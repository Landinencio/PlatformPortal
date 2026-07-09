// Feature: ai-portal-explorer, Property 17: El Triage_Result está bien formado y con severidad válida
/**
 * Property-based test for the Triage_Engine.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/triage-engine.ts
 *
 * Property 17: El Triage_Result está bien formado y con severidad válida.
 *   Para TODA Anomaly, el Triage_Result producido por `triageAnomaly` y por
 *   `triageAll` —incluso con Bedrock SIMULADO vía `TriageDeps` que devuelve JSON
 *   válido, texto malformado o campos parciales, e incluso cuando la invocación
 *   falla— contiene los OCHO campos (`id`, `route`, `role`, `severity`,
 *   `category`, `probable_cause`, `suggested_fix`, `evidence`), su `severity`
 *   pertenece a `{critical, high, medium, low, info}` (SEVERITY_ORDER), su
 *   `category` es una categoría de anomalía válida, su `status` es un
 *   TriageStatus válido, y la identidad se respeta: `id === anomaly.anomalyId`,
 *   `route === anomaly.route.path`, `role === anomaly.role`.
 *
 * **Validates: Requirements 6.1, 6.2, 6.3**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/triage-engine.prop17.property.test.ts
 */

// Polyfill de Web Streams globals (Node 16) ANTES de cargar el AWS SDK vía
// triage-engine. Los imports de ES se evalúan en orden, así que este va primero.
import "./web-streams-polyfill";

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  triageAnomaly,
  triageAll,
  defaultParseTriage,
  type TriageDeps,
} from "../triage-engine";
import { SEVERITY_ORDER } from "../types";
import type {
  Anomaly,
  AnomalyCategory,
  AnomalyEvidence,
  FailedRequest,
  Route,
  Severity,
  TriageResult,
  TriageStatus,
} from "../types";
import type { PortalSection } from "@/lib/rbac";
import { arbAppRole } from "./arbitraries";

/* ------------------------------------------------------------------ */
/*  Conjuntos de validación (espejo de las uniones de types.ts)         */
/* ------------------------------------------------------------------ */

const ANOMALY_CATEGORIES: readonly AnomalyCategory[] = [
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
] as const;

const VALID_SEVERITIES = new Set<string>(SEVERITY_ORDER);
const VALID_CATEGORIES = new Set<string>(ANOMALY_CATEGORIES);
const VALID_TRIAGE_STATUSES = new Set<TriageStatus>([
  "triaged",
  "triage-unavailable",
  "triage-skipped-budget",
]);

const SECTIONS: readonly PortalSection[] = [
  "home",
  "metrics",
  "finops",
  "create-infra",
  "access-management",
  "incidents",
  "requests",
  "sonarqube",
  "synthetics",
  "infra-requests",
  "kiro-analytics",
  "admin",
] as const;

/* ------------------------------------------------------------------ */
/*  Arbitraries: Anomaly (Route, role, category, scenarioId, evidence)  */
/* ------------------------------------------------------------------ */

const arbRoutePath: fc.Arbitrary<string> = fc
  .constantFrom(
    "metrics",
    "finops",
    "admin",
    "synthetics",
    "api/metrics/team-activity",
    "access-management",
    "",
  )
  .map((s) => `/${s}`);

const arbRoute: fc.Arbitrary<Route> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  kind: fc.constantFrom<"ui" | "api">("ui", "api"),
  path: arbRoutePath,
  section: fc.constantFrom(...SECTIONS),
}) as fc.Arbitrary<Route>;

const arbFailedRequest: fc.Arbitrary<FailedRequest> = fc.record({
  url: fc.webUrl(),
  method: fc.constantFrom("GET", "HEAD"),
  status: fc.option(fc.integer({ min: 400, max: 599 }), { nil: null }),
});

const arbEvidence: fc.Arbitrary<AnomalyEvidence> = fc.record({
  summary: fc.string({ maxLength: 40 }),
  httpStatus: fc.option(fc.integer({ min: 100, max: 599 }), { nil: null }),
  latencyMs: fc.option(fc.integer({ min: 0, max: 60000 }), { nil: null }),
  consoleErrors: fc.array(fc.string({ maxLength: 30 }), { maxLength: 3 }),
  failedRequests: fc.array(arbFailedRequest, { maxLength: 3 }),
  domErrorStates: fc.array(
    fc.record({
      kind: fc.constantFrom<"error-message" | "blank-page" | "empty-state" | "render-exception">(
        "error-message",
        "blank-page",
        "empty-state",
        "render-exception",
      ),
      detail: fc.string({ maxLength: 30 }),
    }),
    { maxLength: 2 },
  ),
  dataSignal: fc.constant(null),
  screenshotRef: fc.option(fc.constant("s3://explorer/screenshot.png"), { nil: null }),
  expectedAccess: fc.option(fc.constantFrom<"granted" | "denied">("granted", "denied"), {
    nil: undefined,
  }),
  observedAccess: fc.option(fc.constantFrom<"granted" | "denied">("granted", "denied"), {
    nil: undefined,
  }),
}) as fc.Arbitrary<AnomalyEvidence>;

const arbAnomaly: fc.Arbitrary<Anomaly> = fc.record({
  anomalyId: fc.string({ minLength: 1, maxLength: 24 }),
  runId: fc.uuid(),
  route: arbRoute,
  role: arbAppRole,
  scenarioId: fc.string({ minLength: 1, maxLength: 24 }),
  category: fc.constantFrom(...ANOMALY_CATEGORIES),
  detector: fc.constantFrom<"deterministic" | "rbac">("deterministic", "rbac"),
  evidence: arbEvidence,
}) as fc.Arbitrary<Anomaly>;

/* ------------------------------------------------------------------ */
/*  Bedrock simulado: variamos el contenido devuelto vía TriageDeps      */
/* ------------------------------------------------------------------ */

/**
 * Comportamiento del Bedrock simulado para una invocación concreta. Cubre:
 * - `valid`     → JSON de triage bien formado.
 * - `fenced`    → JSON válido envuelto en un bloque ```json (debe parsearse).
 * - `partial`   → objeto JSON con campos faltantes y/o una severidad inválida.
 * - `malformed` → texto que no es JSON.
 * - `throw`     → la invocación lanza (solo se ejercita en triageAll).
 */
type BedrockBehavior = "valid" | "fenced" | "partial" | "malformed" | "throw";

const arbBehaviorNonThrowing: fc.Arbitrary<BedrockBehavior> = fc.constantFrom<BedrockBehavior>(
  "valid",
  "fenced",
  "partial",
  "malformed",
);

const arbBehaviorAny: fc.Arbitrary<BedrockBehavior> = fc.constantFrom<BedrockBehavior>(
  "valid",
  "fenced",
  "partial",
  "malformed",
  "throw",
);

/** Una severidad arbitraria, a veces inválida, para forzar el saneado. */
const arbModelSeverity: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom<Severity>(...SEVERITY_ORDER),
  fc.constantFrom("URGENT", "blocker", "", "sev1"),
);

/**
 * Construye unas `TriageDeps` con un Bedrock SIMULADO accionado por una cola de
 * comportamientos consumida en orden de invocación. Usa `defaultParseTriage`
 * como parser real (tolerante a fences, JSON parcial y texto malformado).
 */
function makeSimulatedDeps(queue: { behavior: BedrockBehavior; severity: string }[]): TriageDeps {
  let idx = 0;
  return {
    async invokeBedrock(prompt, _system, _evidence) {
      const step = queue[idx] ?? { behavior: "valid" as BedrockBehavior, severity: "high" };
      idx += 1;
      if (step.behavior === "throw") {
        throw new Error("Bedrock simulado: invocación fallida");
      }
      // El prompt incluye la ruta/categoría: reconstruimos una Anomaly mínima
      // para el render no es necesario; usamos los datos del step + prompt.
      // (El render solo necesita category/route, que vienen embebidos en el
      // prompt; pero defaultParseTriage saneará con la Anomaly real igualmente.)
      return renderRawFromPrompt(step.behavior, prompt, step.severity);
    },
    parseTriage: defaultParseTriage,
  };
}

/**
 * Variante de render que no depende de la Anomaly completa (el contrato de
 * `invokeBedrock` solo recibe prompt/system/evidence). Para `valid`/`fenced`
 * produce un JSON con una severidad dada y campos genéricos; el resto igual que
 * `renderBedrockRaw`. La categoría/identidad la fija después `defaultParseTriage`
 * a partir de la Anomaly, así que aquí no hace falta que coincida.
 */
function renderRawFromPrompt(
  behavior: BedrockBehavior,
  _prompt: string,
  modelSeverity: string,
): string {
  const body = {
    severity: modelSeverity,
    probable_cause: "causa probable simulada",
    suggested_fix: "fix sugerido simulado",
  };
  switch (behavior) {
    case "valid":
      return JSON.stringify(body);
    case "fenced":
      return "```json\n" + JSON.stringify(body, null, 2) + "\n```";
    case "partial":
      return JSON.stringify({ severity: modelSeverity });
    case "malformed":
      return "respuesta no-JSON del modelo";
    case "throw":
      return "";
  }
}

/* ------------------------------------------------------------------ */
/*  Aserción reutilizable: un TriageResult está bien formado            */
/* ------------------------------------------------------------------ */

function assertWellFormed(t: TriageResult, anomaly: Anomaly): void {
  // Los OCHO campos presentes (Req 6.2).
  assert.ok(typeof t.id === "string" && t.id.length > 0, "id presente");
  assert.ok(typeof t.route === "string" && t.route.length > 0, "route presente");
  assert.ok(typeof t.role === "string" && t.role.length > 0, "role presente");
  assert.ok(typeof t.severity === "string", "severity presente");
  assert.ok(typeof t.category === "string", "category presente");
  assert.ok(
    typeof t.probable_cause === "string" && t.probable_cause.length > 0,
    "probable_cause presente",
  );
  assert.ok(
    typeof t.suggested_fix === "string" && t.suggested_fix.length > 0,
    "suggested_fix presente",
  );
  assert.ok(t.evidence !== undefined && t.evidence !== null, "evidence presente");

  // Severidad válida (Req 6.3).
  assert.ok(
    VALID_SEVERITIES.has(t.severity),
    `severity "${t.severity}" debe pertenecer a {critical, high, medium, low, info}`,
  );

  // Categoría y status válidos.
  assert.ok(VALID_CATEGORIES.has(t.category), `category "${t.category}" debe ser válida`);
  assert.ok(VALID_TRIAGE_STATUSES.has(t.status), `status "${t.status}" debe ser un TriageStatus`);

  // Identidad respetada.
  assert.equal(t.id, anomaly.anomalyId, "id === anomaly.anomalyId");
  assert.equal(t.route, anomaly.route.path, "route === anomaly.route.path");
  assert.equal(t.role, anomaly.role, "role === anomaly.role");
}

/* ------------------------------------------------------------------ */
/*  Property 17a: triageAnomaly (una Anomaly)                          */
/* ------------------------------------------------------------------ */

test("Property 17: triageAnomaly produce un Triage_Result bien formado con severidad válida", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbAnomaly,
      arbBehaviorNonThrowing,
      arbModelSeverity,
      async (anomaly, behavior, severity) => {
        const deps = makeSimulatedDeps([{ behavior, severity }]);
        const result = await triageAnomaly(anomaly, deps);

        assertWellFormed(result, anomaly);
        // triageAnomaly marca siempre un triage exitoso.
        assert.equal(result.status, "triaged", "triageAnomaly debe marcar 'triaged'");
      },
    ),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 17b: triageAll (lote con presupuesto y fallos simulados)  */
/* ------------------------------------------------------------------ */

test("Property 17: triageAll produce Triage_Results bien formados para todo el lote", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          anomaly: arbAnomaly,
          behavior: arbBehaviorAny,
          severity: arbModelSeverity,
        }),
        { maxLength: 8 },
      ),
      fc.integer({ min: 0, max: 10 }),
      async (items, budget) => {
        const anomalies = items.map((it) => it.anomaly);
        const deps = makeSimulatedDeps(
          items.map((it) => ({ behavior: it.behavior, severity: it.severity })),
        );

        const results = await triageAll(anomalies, budget, deps);

        // Cardinalidad de salida == cardinalidad de entrada.
        assert.equal(results.length, anomalies.length, "un Triage_Result por Anomaly");

        results.forEach((result, i) => {
          assertWellFormed(result, anomalies[i]);
        });
      },
    ),
    { numRuns: 100 },
  );
});
