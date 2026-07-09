// Feature: ai-portal-explorer — Smoke test (OPTIONAL / non-blocking) del Triage_Engine contra Bedrock REAL.
/**
 * Smoke test del Triage_Engine contra Amazon Bedrock REAL.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/triage-engine.ts
 *
 * ⚠️ OPTIONAL / NON-BLOCKING — este test:
 *   - Hace UNA invocación end-to-end real del `ConverseCommand` (modelo
 *     `eu.anthropic.claude-sonnet-4-20250514-v1:0`) vía `defaultTriageDeps()`.
 *   - **CUESTA DINERO** (una llamada real a Bedrock) y requiere credenciales AWS
 *     con acceso a Bedrock en la región configurada.
 *   - Está **GATED por la env `EXPLORER_BEDROCK_SMOKE`**: se SALTA por defecto
 *     (en CI y en local) y solo se ejecuta cuando `EXPLORER_BEDROCK_SMOKE === "1"`.
 *
 * Valida el contrato real del `ConverseCommand` end-to-end: que una Anomaly
 * realista produce un `TriageResult` bien formado (los 8 campos, severidad y
 * categoría válidas, identidad respetada, status "triaged").
 *
 * Ejecutar SOLO bajo demanda (coste real):
 *   EXPLORER_BEDROCK_SMOKE=1 TSX_TSCONFIG_PATH=tsconfig.test.json \
 *     npx tsx --test src/lib/explorer/__tests__/triage-engine.bedrock-smoke.test.ts
 *
 * Por defecto (sin la env) reporta SKIPPED y termina con exit 0:
 *   TSX_TSCONFIG_PATH=tsconfig.test.json \
 *     npx tsx --test src/lib/explorer/__tests__/triage-engine.bedrock-smoke.test.ts
 */

// Polyfill de Web Streams globals (Node 16) ANTES de cargar el AWS SDK vía
// triage-engine. Los imports de ES se evalúan en orden, así que este va primero.
// Aunque el test esté gated, el import del módulo (y por tanto del AWS SDK) se
// evalúa al cargar el fichero, así que el polyfill debe estar presente igualmente.
import "./web-streams-polyfill";

import test from "node:test";
import assert from "node:assert/strict";

import { triageAnomaly, defaultTriageDeps } from "../triage-engine";
import { SEVERITY_ORDER } from "../types";
import type { Anomaly, AnomalyCategory } from "../types";

/** Conjunto de categorías válidas (espejo de la unión de types.ts). */
const VALID_CATEGORIES = new Set<AnomalyCategory>([
  "console-error",
  "failed-request",
  "dom-error",
  "performance",
  "timeout",
  "rbac",
  "empty-state",
  "truncated-series",
  "stuck-pagination",
  "incoherent-totals",
  "suspicious-null",
]);

const VALID_SEVERITIES = new Set<string>(SEVERITY_ORDER);

/**
 * Anomaly realista: un empty-state en /metrics para un rango de fechas histórico
 * que DEBERÍA tener datos (típico bug funcional que el Explorer busca detectar).
 */
function buildRealisticAnomaly(): Anomaly {
  return {
    anomalyId: "smoke-metrics-empty-state-001",
    runId: "smoke-run-0001",
    route: {
      id: "ui-metrics",
      kind: "ui",
      path: "/metrics",
      section: "metrics",
    },
    role: "directores",
    scenarioId: "metrics-historical-30d",
    category: "empty-state",
    detector: "deterministic",
    evidence: {
      summary:
        "La pestaña DORA de /metrics muestra 'No hay datos' para un rango de 30 días que debería tener despliegues registrados.",
      httpStatus: 200,
      latencyMs: 1840,
      consoleErrors: [],
      failedRequests: [],
      domErrorStates: [
        {
          kind: "empty-state",
          detail: "No hay datos para el rango seleccionado",
        },
      ],
      dataSignal: {
        isEmptyState: true,
        rowCount: 0,
        timeSeries: {
          requestedStart: "2026-05-01",
          requestedEnd: "2026-05-31",
          firstDataPoint: null,
          lastDataPoint: null,
          pointCount: 0,
        },
        pagination: null,
        totals: {},
      },
      screenshotRef: "s3://explorer/smoke/metrics-empty-state.png",
      expectedAccess: "granted",
      observedAccess: "granted",
    },
  };
}

test(
  "Smoke: triageAnomaly contra Bedrock REAL produce un TriageResult bien formado (ConverseCommand end-to-end)",
  { skip: process.env.EXPLORER_BEDROCK_SMOKE !== "1" },
  async () => {
    const anomaly = buildRealisticAnomaly();

    // UNA invocación end-to-end real (ConverseCommand) con las deps de producción.
    const result = await triageAnomaly(anomaly, defaultTriageDeps());

    // Los OCHO campos presentes y no vacíos donde corresponde.
    assert.ok(typeof result.id === "string" && result.id.length > 0, "id presente");
    assert.ok(typeof result.route === "string" && result.route.length > 0, "route presente");
    assert.ok(typeof result.role === "string" && result.role.length > 0, "role presente");
    assert.ok(typeof result.severity === "string", "severity presente");
    assert.ok(typeof result.category === "string", "category presente");
    assert.ok(
      typeof result.probable_cause === "string" && result.probable_cause.trim().length > 0,
      "probable_cause es un string no vacío",
    );
    assert.ok(
      typeof result.suggested_fix === "string" && result.suggested_fix.trim().length > 0,
      "suggested_fix es un string no vacío",
    );
    assert.ok(result.evidence !== undefined && result.evidence !== null, "evidence presente");

    // Severidad válida ∈ SEVERITY_ORDER y categoría válida.
    assert.ok(
      VALID_SEVERITIES.has(result.severity),
      `severity "${result.severity}" ∈ {critical, high, medium, low, info}`,
    );
    assert.ok(VALID_CATEGORIES.has(result.category), `category "${result.category}" válida`);

    // Identidad y status del contrato.
    assert.equal(result.id, anomaly.anomalyId, "id === anomaly.anomalyId");
    assert.equal(result.route, anomaly.route.path, "route === anomaly.route.path");
    assert.equal(result.role, anomaly.role, "role === anomaly.role");
    assert.equal(result.status, "triaged", "status === 'triaged'");

    // Telemetría útil cuando se ejecuta manualmente.
    console.log("[bedrock-smoke] TriageResult:", JSON.stringify(result, null, 2));
  },
);
