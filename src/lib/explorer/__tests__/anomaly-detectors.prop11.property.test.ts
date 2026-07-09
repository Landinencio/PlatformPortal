// Feature: ai-portal-explorer, Property 11: Anomalía de latencia/timeout si y solo si se supera el umbral o expira
/**
 * Property-based test for the Anomaly_Detectors (latency & timeout).
 *
 * Feature: ai-portal-explorer — src/lib/explorer/anomaly-detectors.ts
 *
 * Property 11: Anomalía de latencia/timeout si y solo si se supera el umbral o expira.
 *   Para TODO Visit_Result y umbral de latencia configurado:
 *     - `detectLatencyAnomaly(visit, threshold)` devuelve una Anomaly no nula de
 *       categoría `performance` SII `visit.latencyMs > threshold`; `null` en otro caso.
 *     - `detectTimeoutAnomaly(visit)` devuelve una Anomaly no nula de categoría
 *       `timeout` SII `visit.timedOut === true`; `null` en otro caso.
 *
 * **Validates: Requirements 5.6, 10.6**
 *
 * anomaly-detectors.ts NO importa el AWS SDK, así que no hace falta el polyfill
 * de Web Streams.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/anomaly-detectors.prop11.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { detectLatencyAnomaly, detectTimeoutAnomaly } from "../anomaly-detectors";
import type { Route, VisitResult } from "../types";
import { arbAppRole } from "./arbitraries";

/* ------------------------------------------------------------------ */
/*  Arbitrary local de VisitResult (latencias y timedOut variados)      */
/* ------------------------------------------------------------------ */

/** Una Route mínima pero válida; los detectores de latencia/timeout solo la usan para evidencia/id. */
const arbRoute: fc.Arbitrary<Route> = fc.record({
  id: fc.constantFrom("metrics-ui", "finops-api", "admin-ui", "synthetics-ui"),
  kind: fc.constantFrom<Route["kind"]>("ui", "api"),
  path: fc.constantFrom("/metrics", "/finops", "/admin", "/api/metrics/team-activity"),
  section: fc.constantFrom("metrics", "finops", "admin", "synthetics"),
});

/**
 * Arbitrary de VisitResult con `latencyMs` y `timedOut` variados para ejercitar
 * el umbral de latencia y la condición de timeout. El resto de campos se generan
 * de forma plausible pero no afectan a los detectores bajo prueba.
 *
 * Mantenido LOCAL a este fichero a propósito (los agentes concurrentes 8.4-8.8
 * pueden querer su propia variante) para evitar conflictos en arbitraries.ts.
 */
const arbVisitResult: fc.Arbitrary<VisitResult> = fc.record({
  runId: fc.constantFrom("run_a", "run_b", "run_c"),
  scenarioId: fc.constantFrom("scn_1", "scn_2", "scn_3"),
  route: arbRoute,
  role: arbAppRole,
  params: fc.constant<Record<string, string>>({}),
  httpStatus: fc.constantFrom<number | null>(200, 404, 500, null),
  // Latencias variadas, incluyendo 0 y valores altos, para cruzar el umbral en ambos sentidos.
  latencyMs: fc.integer({ min: 0, max: 20_000 }),
  timedOut: fc.boolean(),
  consoleErrors: fc.constant([]),
  failedRequests: fc.constant([]),
  domErrorStates: fc.constant([]),
  dataSignal: fc.constant(null),
  screenshotRef: fc.constantFrom<string | null>(null, "s3://shots/x.png"),
  accessObserved: fc.constantFrom<"granted" | "denied">("granted", "denied"),
});

/** Umbral de latencia configurable, variado para cruzar `latencyMs` en ambos sentidos. */
const arbThresholdMs: fc.Arbitrary<number> = fc.integer({ min: 0, max: 20_000 });

/* ------------------------------------------------------------------ */
/*  Property 11                                                         */
/* ------------------------------------------------------------------ */

test("Property 11: detectLatencyAnomaly => performance anomaly IFF latencyMs > threshold", () => {
  fc.assert(
    fc.property(arbVisitResult, arbThresholdMs, (visit, thresholdMs) => {
      const anomaly = detectLatencyAnomaly(visit, thresholdMs);
      const exceeds = visit.latencyMs > thresholdMs;

      if (exceeds) {
        assert.notEqual(anomaly, null, "se esperaba una Anomaly cuando latencyMs > threshold");
        assert.equal(anomaly!.category, "performance");
        // Identidad/evidencia coherentes con el Visit_Result.
        assert.equal(anomaly!.route, visit.route);
        assert.equal(anomaly!.role, visit.role);
        assert.equal(anomaly!.scenarioId, visit.scenarioId);
        assert.equal(anomaly!.detector, "deterministic");
        assert.equal(anomaly!.evidence.latencyMs, visit.latencyMs);
      } else {
        assert.equal(anomaly, null, "no debe haber Anomaly cuando latencyMs <= threshold");
      }
    }),
    { numRuns: 100 },
  );
});

test("Property 11: detectTimeoutAnomaly => timeout anomaly IFF timedOut === true", () => {
  fc.assert(
    fc.property(arbVisitResult, (visit) => {
      const anomaly = detectTimeoutAnomaly(visit);

      if (visit.timedOut) {
        assert.notEqual(anomaly, null, "se esperaba una Anomaly cuando timedOut es true");
        assert.equal(anomaly!.category, "timeout");
        assert.equal(anomaly!.route, visit.route);
        assert.equal(anomaly!.role, visit.role);
        assert.equal(anomaly!.scenarioId, visit.scenarioId);
        assert.equal(anomaly!.detector, "deterministic");
      } else {
        assert.equal(anomaly, null, "no debe haber Anomaly cuando timedOut es false");
      }
    }),
    { numRuns: 100 },
  );
});
