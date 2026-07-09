// Feature: ai-portal-explorer — Directed example: Gestión empty-state regression
/**
 * Directed example test (NOT a property test) for the Anomaly_Detectors.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/anomaly-detectors.ts
 *
 * Intent: reproduce the exact "Gestión" regression the Explorer must catch — a
 * page that returns HTTP 200 OK (technically clean: no console errors, no failed
 * requests, no DOM error states, latency below threshold, no timeout) but whose
 * data is empty even though the scenario expected data. This is the silent bug
 * that classic uptime/error monitoring misses: the request "succeeds" yet the
 * dashboard shows nothing.
 *
 * We build a VisitResult over the `crosses-90d-boundary` scenario
 * (2026-01-01 – 2026-03-28, expectsData: true) with `dataSignal.isEmptyState`
 * true, and assert that `detectAnomalies` produces EXACTLY ONE Anomaly of
 * category `empty-state` — and nothing else, because the visit is otherwise
 * technically healthy.
 *
 * _Requirements: 5.7_
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/gestion-empty-state.example.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { detectAnomalies } from "../anomaly-detectors";
import type { DetectorConfig } from "../anomaly-detectors";
import type { Route, Scenario, VisitResult } from "../types";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

/** La Route de Gestión (pestaña dentro de /metrics). */
const gestionRoute: Route = {
  id: "metrics-gestion-ui",
  kind: "ui",
  path: "/metrics",
  section: "metrics",
  paramSpec: { dateRange: true },
};

/**
 * Scenario que cruza el límite de 90 días (el que destapa el bug de Gestión).
 * Construido directamente con las fechas y la expectativa de datos que
 * DEFAULT_SCENARIO_MATRIX declara para `crosses-90d-boundary`.
 */
const crosses90dScenario: Scenario = {
  scenarioId: "scn_gestion_crosses90d",
  route: gestionRoute,
  params: { startDate: "2026-01-01", endDate: "2026-03-28" },
  expectsData: true,
  label: "crosses-90d-boundary",
};

/**
 * Visita técnicamente LIMPIA: HTTP 200, sin errores de consola, sin peticiones
 * fallidas, sin estados de error en el DOM, latencia baja, sin timeout. La ÚNICA
 * señal anómala es que el `dataSignal` reporta un empty-state (rowCount 0) pese a
 * que el scenario esperaba datos. Eso es exactamente la regresión de Gestión.
 */
const cleanButEmptyVisit: VisitResult = {
  runId: "run_example_gestion",
  scenarioId: crosses90dScenario.scenarioId,
  route: gestionRoute,
  role: "desarrolladores",
  params: crosses90dScenario.params,
  httpStatus: 200, // 200 OK — NO es un error técnico
  latencyMs: 320, // muy por debajo del umbral
  timedOut: false,
  consoleErrors: [],
  failedRequests: [],
  domErrorStates: [],
  dataSignal: {
    isEmptyState: true, // ← la regresión: vacío pese a 200 OK
    rowCount: 0,
    timeSeries: null,
    pagination: null,
    totals: {},
  },
  screenshotRef: "s3://explorer-shots/run_example_gestion/metrics.png",
  accessObserved: "granted",
};

/** Umbral de latencia alto para que la latencia NO dispare una anomalía. */
const config: DetectorConfig = {
  latencyThresholdMs: 5000,
  seriesEndToleranceDays: 1,
};

/* ------------------------------------------------------------------ */
/*  Directed example                                                   */
/* ------------------------------------------------------------------ */

test("detectAnomalies catches the Gestión regression: HTTP 200 with empty data => exactly one empty-state anomaly", () => {
  const anomalies = detectAnomalies(cleanButEmptyVisit, crosses90dScenario, config);

  // EXACTAMENTE UNA anomalía: la visita es técnicamente limpia salvo el vacío.
  assert.equal(
    anomalies.length,
    1,
    `se esperaba exactamente 1 anomalía (empty-state), se obtuvieron ${anomalies.length}: ` +
      anomalies.map((a) => a.category).join(", "),
  );

  const [anomaly] = anomalies;
  assert.equal(anomaly.category, "empty-state");
  assert.equal(anomaly.route.path, "/metrics");
  assert.equal(anomaly.role, "desarrolladores");
  assert.equal(anomaly.scenarioId, crosses90dScenario.scenarioId);
  assert.equal(anomaly.detector, "deterministic");

  // La evidencia refleja que la respuesta fue 200 OK con empty-state.
  assert.equal(anomaly.evidence.httpStatus, 200);
  assert.equal(anomaly.evidence.dataSignal?.isEmptyState, true);
  assert.equal(anomaly.evidence.dataSignal?.rowCount, 0);
});
