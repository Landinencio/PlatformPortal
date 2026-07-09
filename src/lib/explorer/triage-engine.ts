/**
 * AI Portal Explorer — Triage_Engine.
 *
 * Feature: ai-portal-explorer
 *
 * Convierte cada `Anomaly` detectada de forma determinista en un `TriageResult`
 * estructurado (severidad, categoría, causa probable, fix sugerido, evidencia)
 * usando Amazon Bedrock (patrón `ConverseCommand` de `src/lib/bedrock.ts`,
 * modelo `eu.anthropic.claude-sonnet-4-20250514-v1:0`).
 *
 * Diseño:
 * - `TriageDeps` inyecta `invokeBedrock` y `parseTriage` para que el motor sea
 *   testeable sin Bedrock real (integración con mocks).
 * - `triageAll` respeta el `Bedrock_Budget`: hasta `budget` invocaciones; las
 *   anomalías sobrantes se marcan `triage-skipped-budget`; las que fallan se
 *   marcan `triage-unavailable`. NUNCA lanza, y la cardinalidad de salida es
 *   igual a la de entrada.
 * - `fallbackTriage` deriva una severidad determinista de la categoría de la
 *   anomalía, garantizando un `TriageResult` bien formado aunque Bedrock no
 *   esté disponible o se omita.
 * - `serializeTriageResult`/`deserializeTriageResult` son inversas (round-trip).
 *
 * _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 9.4_
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

import type {
  Anomaly,
  AnomalyCategory,
  AnomalyEvidence,
  Severity,
  TriageResult,
  TriageStatus,
} from "./types";
import { SEVERITY_ORDER } from "./types";

/**
 * Dependencias inyectables del Triage_Engine. Permiten ejercitar el motor con
 * un Bedrock simulado (integración con mocks) sin tocar AWS.
 */
export interface TriageDeps {
  /** Invoca Bedrock con el prompt y la evidencia y devuelve el texto crudo. */
  invokeBedrock: (
    prompt: string,
    system: string,
    evidence: AnomalyEvidence,
  ) => Promise<string>;
  /** Parsea la respuesta cruda de Bedrock en un `TriageResult` para la Anomaly. */
  parseTriage: (raw: string, anomaly: Anomaly) => TriageResult;
}

/** Modelo Bedrock usado para el triage (igual que el resto de agentes del portal). */
export const TRIAGE_MODEL_ID =
  process.env.EXPLORER_TRIAGE_MODEL_ID?.trim() ||
  process.env.FINOPS_CHAT_MODEL_ID?.trim() ||
  "eu.anthropic.claude-sonnet-4-20250514-v1:0";

/**
 * Mapeo determinista categoría → severidad mínima. Se usa cuando Bedrock no
 * está disponible / se omite (fallback) y como base cuando el modelo no
 * devuelve una severidad válida. Refleja el impacto típico de cada categoría:
 *
 * - `rbac`            → high  (fuga/bloqueo de acceso: seguridad)
 * - `failed-request`  → high  (peticiones 4xx/5xx: funcionalidad rota)
 * - `dom-error`       → high  (render roto / excepción en pantalla)
 * - `timeout`         → high  (la página no responde a tiempo)
 * - `incoherent-totals` → high (integridad de datos comprometida)
 * - `console-error`   → medium (error JS no fatal)
 * - `empty-state`     → medium (datos esperados ausentes: posible bug de datos)
 * - `truncated-series`→ medium (serie temporal cortada antes de tiempo)
 * - `performance`     → low   (latencia alta sin fallo)
 * - `stuck-pagination`→ low   (paginación que no avanza)
 * - `suspicious-null` → low   (null/NaN/"-" donde se esperaba número)
 */
export const CATEGORY_SEVERITY: Record<AnomalyCategory, Severity> = {
  rbac: "high",
  "failed-request": "high",
  "dom-error": "high",
  timeout: "high",
  "incoherent-totals": "high",
  "console-error": "medium",
  "empty-state": "medium",
  "truncated-series": "medium",
  performance: "low",
  "stuck-pagination": "low",
  "suspicious-null": "low",
};

/** Conjunto de categorías válidas (para validar la salida del modelo). */
const ANOMALY_CATEGORIES = new Set<AnomalyCategory>(
  Object.keys(CATEGORY_SEVERITY) as AnomalyCategory[],
);

/** System prompt para el triage. Pide JSON estricto, juicio semántico. */
export const TRIAGE_SYSTEM_PROMPT = `Eres un ingeniero SRE experto en QA funcional del Platform Portal.
Recibes la evidencia estructurada de UNA anomalía detectada por un crawler de solo lectura
(errores de consola, peticiones fallidas, estados de error del DOM, señales de datos como
empty-states, series temporales truncadas, totales incoherentes, valores nulos).

Tu tarea es hacer el triage de esa anomalía y responder ÚNICAMENTE con un objeto JSON válido
(sin texto adicional ni bloques de código) con esta forma exacta:
{
  "severity": "critical|high|medium|low|info",
  "category": "<categoría de la anomalía>",
  "probable_cause": "<causa probable, 1-2 frases en español>",
  "suggested_fix": "<fix accionable, 1-2 frases en español>"
}

Criterios de severidad:
- critical: el portal está roto para un rol (página en blanco, excepción de render, acceso no autorizado a datos sensibles).
- high: funcionalidad rota o integridad de datos comprometida (peticiones fallidas, totales incoherentes, timeout, RBAC).
- medium: datos esperados ausentes o degradados (empty-state donde debería haber datos, serie truncada, error de consola).
- low: molestia sin pérdida de funcionalidad (latencia alta, paginación estancada, valores nulos puntuales).
- info: comportamiento esperable, no es un bug real.

Considera explícitamente si un empty-state es esperable o un bug (p.ej. un rango de fechas histórico que debería tener datos).`;

/**
 * Construye el prompt de usuario con la evidencia estructurada de la Anomaly.
 * Incluye la categoría detectada de forma determinista como contexto.
 */
export function buildTriagePrompt(anomaly: Anomaly): string {
  const { route, role, category, scenarioId, evidence } = anomaly;
  return [
    `Anomalía detectada durante una exploración de solo lectura del Platform Portal.`,
    ``,
    `Ruta: ${route.path} (${route.kind}, sección ${route.section})`,
    `Rol sintético: ${role}`,
    `Categoría detectada (heurística determinista): ${category}`,
    `Scenario: ${scenarioId}`,
    ``,
    `Evidencia:`,
    JSON.stringify(evidence, null, 2),
    ``,
    `Haz el triage y responde solo con el JSON solicitado.`,
  ].join("\n");
}

/**
 * Hace el triage de UNA Anomaly invocando Bedrock (vía deps) y parseando el
 * resultado. El resultado exitoso queda marcado `triaged`. Si la invocación o
 * el parseo lanzan, la excepción se propaga para que `triageAll` la marque como
 * `triage-unavailable`. (Req 6.1, 6.2)
 */
export async function triageAnomaly(
  anomaly: Anomaly,
  deps: TriageDeps,
): Promise<TriageResult> {
  const raw = await deps.invokeBedrock(
    buildTriagePrompt(anomaly),
    TRIAGE_SYSTEM_PROMPT,
    anomaly.evidence,
  );
  const result = deps.parseTriage(raw, anomaly);
  // Un triage exitoso siempre queda marcado como "triaged" y bien formado.
  return normalizeTriageResult(result, anomaly, "triaged");
}

/**
 * Procesa el lote de Anomalies respetando el `Bedrock_Budget`:
 * - Invoca Bedrock como máximo `budget` veces (solo Anomalies, nunca
 *   Visit_Results sin anomalía). (Req 6.4, 9.4)
 * - Las Anomalies más allá del presupuesto se marcan `triage-skipped-budget`
 *   sin invocar a Bedrock. (Req 6.6)
 * - Las Anomalies cuya invocación falla se marcan `triage-unavailable` y NO
 *   abortan el lote. (Req 6.5)
 * - NUNCA lanza; la cardinalidad de salida es igual a la de entrada.
 */
export async function triageAll(
  anomalies: Anomaly[],
  budget: number,
  deps: TriageDeps,
): Promise<TriageResult[]> {
  const safeBudget =
    Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0;
  const results: TriageResult[] = [];
  let calls = 0;

  for (const anomaly of anomalies) {
    if (calls >= safeBudget) {
      // Presupuesto agotado: marcar sin invocar a Bedrock.
      results.push(fallbackTriage(anomaly, "triage-skipped-budget"));
      continue;
    }

    // Cada intento (con éxito o fallo) consume una invocación del presupuesto.
    calls += 1;
    try {
      results.push(await triageAnomaly(anomaly, deps));
    } catch {
      results.push(fallbackTriage(anomaly, "triage-unavailable"));
    }
  }

  return results;
}

/**
 * Fallback determinista cuando Bedrock falla (`triage-unavailable`) o se omite
 * por presupuesto (`triage-skipped-budget`), o como base de un triage exitoso.
 * La severidad se deriva de la categoría de la anomalía (mapa `CATEGORY_SEVERITY`).
 */
export function fallbackTriage(
  anomaly: Anomaly,
  status: TriageStatus,
): TriageResult {
  const severity = CATEGORY_SEVERITY[anomaly.category] ?? "info";
  return {
    id: anomaly.anomalyId,
    route: anomaly.route.path,
    role: anomaly.role,
    severity,
    category: anomaly.category,
    probable_cause: fallbackProbableCause(anomaly, status),
    suggested_fix: fallbackSuggestedFix(status),
    evidence: anomaly.evidence,
    status,
  };
}

/** Causa probable determinista para un triage de fallback. */
function fallbackProbableCause(anomaly: Anomaly, status: TriageStatus): string {
  const base = anomaly.evidence.summary?.trim();
  switch (status) {
    case "triage-unavailable":
      return base
        ? `Triage automático no disponible (Bedrock); severidad derivada de la categoría "${anomaly.category}". Evidencia: ${base}`
        : `Triage automático no disponible (Bedrock); severidad derivada de la categoría "${anomaly.category}".`;
    case "triage-skipped-budget":
      return `Triage omitido por presupuesto de Bedrock agotado; severidad derivada de la categoría "${anomaly.category}".`;
    case "triaged":
    default:
      return base || `Anomalía de categoría "${anomaly.category}".`;
  }
}

/** Fix sugerido determinista para un triage de fallback. */
function fallbackSuggestedFix(status: TriageStatus): string {
  switch (status) {
    case "triage-unavailable":
      return "Revisar la evidencia manualmente o re-ejecutar el triage cuando Bedrock esté disponible.";
    case "triage-skipped-budget":
      return "Re-ejecutar el Exploration_Run con un Bedrock_Budget mayor o revisar la anomalía manualmente.";
    case "triaged":
    default:
      return "Revisar la evidencia de la anomalía y aplicar la corrección correspondiente.";
  }
}

/**
 * Normaliza un `TriageResult` proveniente del parseo: asegura los ocho campos,
 * una severidad válida (deriva de la categoría si no lo es) y el `status` dado.
 */
function normalizeTriageResult(
  result: TriageResult,
  anomaly: Anomaly,
  status: TriageStatus,
): TriageResult {
  const severity = isSeverity(result?.severity)
    ? result.severity
    : CATEGORY_SEVERITY[anomaly.category] ?? "info";
  const category = isAnomalyCategory(result?.category)
    ? result.category
    : anomaly.category;
  return {
    id: result?.id || anomaly.anomalyId,
    route: result?.route || anomaly.route.path,
    role: result?.role || anomaly.role,
    severity,
    category,
    probable_cause: result?.probable_cause || fallbackProbableCause(anomaly, status),
    suggested_fix: result?.suggested_fix || fallbackSuggestedFix(status),
    evidence: result?.evidence ?? anomaly.evidence,
    status,
  };
}

/** Type guard: severidad válida. */
function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITY_ORDER as string[]).includes(value);
}

/** Type guard: categoría de anomalía válida. */
function isAnomalyCategory(value: unknown): value is AnomalyCategory {
  return typeof value === "string" && ANOMALY_CATEGORIES.has(value as AnomalyCategory);
}

/**
 * Serializa un `TriageResult` a JSON canónico. Inversa de
 * `deserializeTriageResult`. (Req 6.7)
 */
export function serializeTriageResult(t: TriageResult): string {
  return JSON.stringify(t);
}

/**
 * Deserializa JSON a `TriageResult`. Inversa de `serializeTriageResult`. (Req 6.7)
 */
export function deserializeTriageResult(json: string): TriageResult {
  return JSON.parse(json) as TriageResult;
}

// ============================================================================
// Implementación por defecto de TriageDeps (Bedrock real vía ConverseCommand).
// El motor usa estas funciones en producción; los tests inyectan mocks.
// ============================================================================

/**
 * Parser por defecto: extrae el JSON de la respuesta del modelo (tolerando
 * fences ```json), valida los campos y completa con el fallback determinista
 * lo que falte. Nunca lanza.
 */
export function defaultParseTriage(raw: string, anomaly: Anomaly): TriageResult {
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object") {
    return fallbackTriage(anomaly, "triaged");
  }
  const obj = parsed as Record<string, unknown>;
  const partial: TriageResult = {
    id: anomaly.anomalyId,
    route: anomaly.route.path,
    role: anomaly.role,
    severity: isSeverity(obj.severity)
      ? obj.severity
      : CATEGORY_SEVERITY[anomaly.category] ?? "info",
    category: isAnomalyCategory(obj.category) ? obj.category : anomaly.category,
    probable_cause:
      typeof obj.probable_cause === "string" && obj.probable_cause.trim()
        ? obj.probable_cause
        : fallbackProbableCause(anomaly, "triaged"),
    suggested_fix:
      typeof obj.suggested_fix === "string" && obj.suggested_fix.trim()
        ? obj.suggested_fix
        : fallbackSuggestedFix("triaged"),
    evidence: anomaly.evidence,
    status: "triaged",
  };
  return partial;
}

/** Parsea JSON de forma segura, tolerando bloques de código markdown. */
function safeJsonParse(raw: string): unknown {
  if (!raw) return null;
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Último intento: aislar el primer objeto JSON del texto.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Invocación por defecto de Bedrock con el patrón `ConverseCommand` de
 * `src/lib/bedrock.ts` (cross-account opcional vía STS AssumeRole).
 */
export async function invokeBedrockForTriage(
  prompt: string,
  system: string,
  _evidence: AnomalyEvidence,
): Promise<string> {
  const region =
    process.env.AWS_BEDROCK_REGION?.trim() ||
    process.env.BEDROCK_REGION?.trim() ||
    process.env.AWS_REGION?.trim() ||
    "eu-west-1";
  const bedrockRoleArn = process.env.AWS_BEDROCK_ROLE_ARN?.trim() || null;

  let credentials:
    | { accessKeyId: string; secretAccessKey: string; sessionToken: string }
    | undefined;

  if (bedrockRoleArn) {
    const sts = new STSClient({ region });
    const assumed = await sts.send(
      new AssumeRoleCommand({
        RoleArn: bedrockRoleArn,
        RoleSessionName: "portal-explorer-triage",
        DurationSeconds: 900,
      }),
    );
    credentials = {
      accessKeyId: assumed.Credentials!.AccessKeyId!,
      secretAccessKey: assumed.Credentials!.SecretAccessKey!,
      sessionToken: assumed.Credentials!.SessionToken!,
    };
  }

  const client = new BedrockRuntimeClient({ region, credentials });
  const command = new ConverseCommand({
    modelId: TRIAGE_MODEL_ID,
    system: [{ text: system }],
    messages: [{ role: "user", content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens: 1024, temperature: 0.2 },
  });

  const response = await client.send(command);
  const outputContent = response.output?.message?.content || [];
  return (
    outputContent
      .filter((b): b is { text: string } => "text" in b)
      .map((b) => b.text)
      .join("\n") || ""
  );
}

/** Dependencias por defecto del Triage_Engine (Bedrock real). */
export function defaultTriageDeps(): TriageDeps {
  return {
    invokeBedrock: invokeBedrockForTriage,
    parseTriage: defaultParseTriage,
  };
}
