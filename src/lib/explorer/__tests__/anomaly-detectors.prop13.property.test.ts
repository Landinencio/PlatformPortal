// Feature: ai-portal-explorer, Property 13: Empty-state con expectativa de datos es una anomalía funcional
/**
 * Property-based test for the Anomaly_Detectors.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/anomaly-detectors.ts
 *
 * Property 13: Empty-state con expectativa de datos es una anomalía funcional.
 *   Para TODO Visit_Result y su Scenario, `detectEmptyStateAnomaly(visit, scenario)`
 *   devuelve una Anomaly NO nula de categoría `empty-state` si y solo si:
 *     (a) el Scenario esperaba datos (`scenario.expectsData === true`), Y
 *     (b) la señal de datos observada existe (`visit.dataSignal` no es null), Y
 *     (c) esa señal es un empty-state (`dataSignal.isEmptyState === true` O
 *         `dataSignal.rowCount === 0`).
 *   En cualquier otro caso (no se esperaban datos, no hay señal, o se observaron
 *   datos) devuelve `null`. Esta es exactamente la regresión de Gestión: un
 *   HTTP 200 OK técnicamente limpio pero con datos vacíos cuando se esperaban.
 *
 * **Validates: Requirements 5.7**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/anomaly-detectors.prop13.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { detectEmptyStateAnomaly } from "../anomaly-detectors";
import type { DataSignal, Route, Scenario, VisitResult } from "../types";
import type { PortalSection } from "@/lib/rbac";
import { arbAppRole } from "./arbitraries";

/* ------------------------------------------------------------------ */
/*  Arbitraries locales (constreñidos al espacio de entrada relevante) */
/* ------------------------------------------------------------------ */

const PORTAL_SECTIONS: readonly PortalSection[] = [
  "metrics",
  "finops",
  "synthetics",
  "admin",
] as const;

/** Una Route navegable cualquiera (UI o API). */
const arbRoute: fc.Arbitrary<Route> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  kind: fc.constantFrom<"ui" | "api">("ui", "api"),
  path: fc.constantFrom("/metrics", "/finops", "/synthetics", "/admin", "/api/metrics/gestion"),
  section: fc.constantFrom(...PORTAL_SECTIONS),
});

/** Scenario con `expectsData` variando para ejercitar ambos lados del IFF. */
const arbScenario: fc.Arbitrary<Scenario> = fc.record({
  scenarioId: fc.string({ minLength: 1, maxLength: 16 }),
  route: arbRoute,
  params: fc.constant<Record<string, string>>({}),
  expectsData: fc.boolean(),
  label: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
});

/**
 * DataSignal cuya señal de vacío varía: `isEmptyState` true/false y `rowCount`
 * 0 / positivo / null, de modo que se cubran todas las combinaciones de la
 * condición "empty" = (isEmptyState === true OR rowCount === 0).
 */
const arbDataSignal: fc.Arbitrary<DataSignal> = fc.record({
  isEmptyState: fc.boolean(),
  rowCount: fc.oneof(
    fc.constant<number | null>(0),
    fc.integer({ min: 1, max: 5000 }),
    fc.constant<number | null>(null),
  ),
  timeSeries: fc.constant(null),
  pagination: fc.constant(null),
  totals: fc.constant<Record<string, number>>({}),
});

/**
 * Visit_Result técnicamente limpio (200 OK, sin errores) cuyo `dataSignal`
 * varía: null, empty-state true/false, rowCount 0/positivo/null. Solo importan
 * para esta property los campos que consume `detectEmptyStateAnomaly`
 * (`dataSignal`), pero construimos un VisitResult completo y bien formado.
 */
const arbVisitResult: fc.Arbitrary<VisitResult> = fc
  .tuple(
    fc.string({ minLength: 1, maxLength: 12 }), // runId
    fc.string({ minLength: 1, maxLength: 16 }), // scenarioId
    arbRoute,
    arbAppRole,
    fc.option(arbDataSignal, { nil: null }),
    fc.integer({ min: 0, max: 1000 }), // latencyMs (bajo umbral implícito)
  )
  .map(([runId, scenarioId, route, role, dataSignal, latencyMs]) => ({
    runId,
    scenarioId,
    route,
    role,
    params: {},
    httpStatus: 200,
    latencyMs,
    timedOut: false,
    consoleErrors: [],
    failedRequests: [],
    domErrorStates: [],
    dataSignal,
    screenshotRef: null,
    accessObserved: "granted" as const,
  }));

/* ------------------------------------------------------------------ */
/*  Property 13                                                        */
/* ------------------------------------------------------------------ */

test("Property 13: detectEmptyStateAnomaly returns an empty-state Anomaly IFF data was expected and observed signal is empty", () => {
  fc.assert(
    fc.property(arbVisitResult, arbScenario, (visit, scenario) => {
      const result = detectEmptyStateAnomaly(visit, scenario);

      const signal = visit.dataSignal;
      const isEmpty = signal !== null && (signal.isEmptyState === true || signal.rowCount === 0);
      const shouldFlag = scenario.expectsData === true && isEmpty;

      if (shouldFlag) {
        // Debe producir una Anomaly bien formada de categoría empty-state.
        assert.notEqual(result, null, "se esperaba una Anomaly empty-state, se obtuvo null");
        assert.equal(result!.category, "empty-state");
        // Identidad: la Anomaly refleja el Visit_Result que la originó.
        assert.equal(result!.runId, visit.runId);
        assert.equal(result!.scenarioId, visit.scenarioId);
        assert.equal(result!.route, visit.route);
        assert.equal(result!.role, visit.role);
        assert.equal(result!.detector, "deterministic");
        // La evidencia conserva el HTTP 200 OK y el dataSignal vacío observado.
        assert.equal(result!.evidence.httpStatus, 200);
        assert.equal(result!.evidence.dataSignal, signal);
      } else {
        // En cualquier otro caso NO debe marcarse empty-state.
        assert.equal(result, null, "se esperaba null (no se cumple la condición de empty-state)");
      }
    }),
    { numRuns: 100 },
  );
});
