// Feature: ai-portal-explorer, Property 19: El triage degrada con elegancia ante fallos de Bedrock
/**
 * Property-based test for the Triage_Engine graceful degradation.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/triage-engine.ts
 *
 * Property 19: El triage degrada con elegancia ante fallos de Bedrock.
 *   Para TODO conjunto de Anomalies donde un subconjunto ARBITRARIO de
 *   invocaciones a Bedrock falla (el resto devuelve JSON válido) y un
 *   Bedrock_Budget `B >= anomalies.length`, `triageAll`:
 *   - NUNCA lanza;
 *   - produce exactamente un Triage_Result por Anomaly de entrada
 *     (`results.length === anomalies.length`, nunca descarta una anomalía);
 *   - las Anomalies cuya invocación a Bedrock falló quedan marcadas
 *     `triage-unavailable` con una severidad determinista derivada de su
 *     categoría (`CATEGORY_SEVERITY[category]`);
 *   - las Anomalies cuya invocación tuvo éxito quedan marcadas `triaged`.
 *
 * **Validates: Requirements 6.5**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/triage-engine.prop19.property.test.ts
 */

// Polyfill de Web Streams globals (Node 16) ANTES de cargar el AWS SDK vía
// triage-engine. Los imports de ES se evalúan en orden, así que este va primero.
import "./web-streams-polyfill";

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  triageAll,
  defaultParseTriage,
  CATEGORY_SEVERITY,
  type TriageDeps,
} from "../triage-engine";
import type {
  Anomaly,
  AnomalyCategory,
  AnomalyEvidence,
  FailedRequest,
  Route,
} from "../types";
import type { PortalSection } from "@/lib/rbac";
import { arbAppRole } from "./arbitraries";

/* ------------------------------------------------------------------ */
/*  Arbitraries: Anomaly (Route, role, category, scenarioId, evidence)  */
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
/*  Bedrock simulado: falla para un subconjunto ARBITRARIO de llamadas   */
/* ------------------------------------------------------------------ */

/**
 * Construye unas `TriageDeps` con un Bedrock SIMULADO accionado por una cola de
 * banderas `shouldThrow` consumida en orden de invocación: cuando la bandera es
 * `true` la invocación lanza (simula un fallo de Bedrock); cuando es `false`
 * devuelve un JSON de triage bien formado. Usa `defaultParseTriage` como parser
 * real. Con `budget >= anomalies.length`, la i-ésima invocación corresponde a
 * la i-ésima Anomaly (triageAll las procesa en orden, una llamada por anomalía).
 */
function makeFailingSubsetDeps(shouldThrowQueue: boolean[]): TriageDeps {
  let idx = 0;
  return {
    async invokeBedrock(_prompt, _system, _evidence) {
      const shouldThrow = shouldThrowQueue[idx] ?? false;
      idx += 1;
      if (shouldThrow) {
        throw new Error("Bedrock simulado: invocación fallida (subset arbitrario)");
      }
      return JSON.stringify({
        severity: "high",
        probable_cause: "causa probable simulada",
        suggested_fix: "fix sugerido simulado",
      });
    },
    parseTriage: defaultParseTriage,
  };
}

/* ------------------------------------------------------------------ */
/*  Property 19: degradación elegante ante fallos de Bedrock            */
/* ------------------------------------------------------------------ */

test("Property 19: triageAll degrada con elegancia ante fallos arbitrarios de Bedrock", async () => {
  await fc.assert(
    fc.asyncProperty(
      // Lote de Anomalies con una bandera `shouldThrow` por anomalía (subconjunto
      // arbitrario de invocaciones que fallarán). Incluye el lote vacío.
      fc.array(
        fc.record({
          anomaly: arbAnomaly,
          shouldThrow: fc.boolean(),
        }),
        { maxLength: 8 },
      ),
      // Holgura del presupuesto sobre la longitud del lote: garantiza
      // budget >= anomalies.length (toda anomalía intenta invocar a Bedrock).
      fc.integer({ min: 0, max: 5 }),
      async (items, slack) => {
        const anomalies = items.map((it) => it.anomaly);
        const budget = anomalies.length + slack; // >= anomalies.length
        const deps = makeFailingSubsetDeps(items.map((it) => it.shouldThrow));

        // triageAll NUNCA debe lanzar, ni siquiera con un subconjunto de fallos.
        const results = await triageAll(anomalies, budget, deps);

        // 1) Cardinalidad de salida === cardinalidad de entrada (nunca descarta).
        assert.equal(
          results.length,
          anomalies.length,
          "results.length === anomalies.length (no se pierde ninguna anomalía)",
        );

        results.forEach((result, i) => {
          const anomaly = anomalies[i];
          const failed = items[i].shouldThrow;

          // Identidad preservada por índice (mismo orden que la entrada).
          assert.equal(result.id, anomaly.anomalyId, "id === anomaly.anomalyId");
          assert.equal(result.route, anomaly.route.path, "route === anomaly.route.path");
          assert.equal(result.role, anomaly.role, "role === anomaly.role");

          if (failed) {
            // 2) Las invocaciones fallidas → 'triage-unavailable' con severidad
            //    determinista derivada de la categoría (Req 6.5).
            assert.equal(
              result.status,
              "triage-unavailable",
              `anomalía #${i} (Bedrock falló) debe quedar 'triage-unavailable'`,
            );
            assert.equal(
              result.severity,
              CATEGORY_SEVERITY[anomaly.category],
              `severidad de fallback determinista para la categoría "${anomaly.category}"`,
            );
            // La categoría se conserva tal cual la de la anomalía.
            assert.equal(result.category, anomaly.category, "category preservada en el fallback");
          } else {
            // 3) Las invocaciones con éxito → 'triaged'.
            assert.equal(
              result.status,
              "triaged",
              `anomalía #${i} (Bedrock OK) debe quedar 'triaged'`,
            );
          }
        });
      },
    ),
    { numRuns: 100 },
  );
});
