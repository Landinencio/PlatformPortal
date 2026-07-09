// Feature: ai-portal-explorer, Property 18: El triage respeta el presupuesto y solo procesa anomalías
/**
 * Property-based test for the Triage_Engine budget enforcement.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/triage-engine.ts
 *
 * Property 18: El triage respeta el presupuesto y solo procesa anomalías.
 *   Para TODO conjunto de Anomalies y Bedrock_Budget `B`, `triageAll`:
 *   - invoca a Bedrock como máximo `B` veces y SOLO para Anomalies (nunca para
 *     un Visit_Result sin anomalía) → nº de llamadas reales a `invokeBedrock`
 *     === min(max(B, 0), anomalies.length);
 *   - produce un Triage_Result por cada Anomaly de entrada
 *     (`results.length === anomalies.length`);
 *   - las primeras `min(B, length)` Anomalies quedan triadas (`triaged`, porque
 *     el Bedrock simulado tiene éxito) y las que exceden el presupuesto quedan
 *     marcadas `triage-skipped-budget` SIN consumir invocación.
 *
 * **Validates: Requirements 6.4, 6.6, 9.4**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/triage-engine.prop18.property.test.ts
 */

// Polyfill de Web Streams globals (Node 16) ANTES de cargar el AWS SDK vía
// triage-engine. Los imports de ES se evalúan en orden, así que este va primero.
import "./web-streams-polyfill";

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { triageAll, defaultParseTriage, type TriageDeps } from "../triage-engine";
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
/*  Bedrock simulado con contador de invocaciones                       */
/* ------------------------------------------------------------------ */

/**
 * `TriageDeps` con un Bedrock SIMULADO que SIEMPRE tiene éxito (devuelve JSON
 * de triage bien formado) y cuenta cada invocación en `counter.calls`. Permite
 * verificar que `triageAll` invoca a Bedrock como máximo `budget` veces.
 */
function makeCountingDeps(counter: { calls: number }): TriageDeps {
  return {
    async invokeBedrock(_prompt, _system, _evidence) {
      counter.calls += 1;
      return JSON.stringify({
        severity: "high",
        probable_cause: "causa probable simulada",
        suggested_fix: "fix sugerido simulado",
      });
    },
    parseTriage: defaultParseTriage,
  };
}

/** Presupuesto efectivo aplicado por triageAll (espejo de su saneado interno). */
function effectiveBudget(budget: number): number {
  return Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0;
}

/* ------------------------------------------------------------------ */
/*  Property 18: triageAll respeta el presupuesto y solo procesa anomalías */
/* ------------------------------------------------------------------ */

test("Property 18: triageAll invoca a Bedrock como máximo `budget` veces y respeta la cardinalidad", async () => {
  await fc.assert(
    fc.asyncProperty(
      // Lote de Anomalies (incluido el lote vacío).
      fc.array(arbAnomaly, { maxLength: 8 }),
      // Presupuesto arbitrario: incluye 0, negativos y valores > longitud.
      fc.integer({ min: -5, max: 12 }),
      async (anomalies, budget) => {
        const counter = { calls: 0 };
        const deps = makeCountingDeps(counter);

        const results = await triageAll(anomalies, budget, deps);

        const expectedCalls = Math.min(effectiveBudget(budget), anomalies.length);

        // 1) Bedrock se invoca exactamente min(max(budget,0), nº anomalías) veces:
        //    como máximo `budget` y SOLO para Anomalies (Req 6.4, 9.4).
        assert.equal(
          counter.calls,
          expectedCalls,
          `invokeBedrock debe llamarse ${expectedCalls} veces (budget=${budget}, anomalies=${anomalies.length}), llamó ${counter.calls}`,
        );

        // 2) Un Triage_Result por cada Anomaly de entrada (cardinalidad).
        assert.equal(
          results.length,
          anomalies.length,
          "results.length === anomalies.length",
        );

        // 3) Las primeras `expectedCalls` quedan triadas (Bedrock simulado OK);
        //    las que exceden el presupuesto quedan `triage-skipped-budget` y NO
        //    consumen invocación (Req 6.6).
        results.forEach((result, i) => {
          // Identidad preservada por índice (mismo orden que la entrada).
          assert.equal(result.id, anomalies[i].anomalyId, "id === anomaly.anomalyId");

          if (i < expectedCalls) {
            assert.equal(
              result.status,
              "triaged",
              `anomalía #${i} (dentro de presupuesto) debe quedar 'triaged'`,
            );
          } else {
            assert.equal(
              result.status,
              "triage-skipped-budget",
              `anomalía #${i} (fuera de presupuesto) debe quedar 'triage-skipped-budget'`,
            );
          }
        });

        // 4) El nº de skipped es exactamente lo que excede el presupuesto.
        const skipped = results.filter((r) => r.status === "triage-skipped-budget").length;
        assert.equal(
          skipped,
          anomalies.length - expectedCalls,
          "nº de 'triage-skipped-budget' === anomalías fuera de presupuesto",
        );
      },
    ),
    { numRuns: 100 },
  );
});
