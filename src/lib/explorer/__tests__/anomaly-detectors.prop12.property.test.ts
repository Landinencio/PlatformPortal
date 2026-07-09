// Feature: ai-portal-explorer, Property 12: Anomalía técnica si y solo si hay evidencia técnica
/**
 * Property-based test for the Anomaly_Detectors técnico (`detectTechnicalAnomalies`).
 *
 * Feature: ai-portal-explorer — src/lib/explorer/anomaly-detectors.ts
 *
 * Property 12: Anomalía técnica si y solo si hay evidencia técnica.
 *   Para todo Visit_Result, `detectTechnicalAnomalies(visit)` produce:
 *     - una Anomaly de categoría `console-error` SI Y SOLO SI
 *       `visit.consoleErrors.length > 0`;
 *     - una Anomaly de categoría `failed-request` SI Y SOLO SI
 *       `visit.failedRequests.length > 0`;
 *     - una Anomaly de categoría `dom-error` SI Y SOLO SI
 *       `visit.domErrorStates.length > 0`;
 *   y NINGUNA anomalía técnica cuando las tres evidencias están vacías.
 *   Es decir, el conjunto de categorías devueltas es EXACTAMENTE el conjunto de
 *   categorías de evidencia técnica no vacía.
 *
 *   Generadores: un arbVisitResult local con arrays de consoleErrors,
 *   failedRequests y domErrorStates variados (a veces vacíos, a veces no), de
 *   modo que se cubran las 8 combinaciones de evidencia presente/ausente.
 *
 * **Validates: Requirements 5.7**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/anomaly-detectors.prop12.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { detectTechnicalAnomalies } from "../anomaly-detectors";
import type {
  AnomalyCategory,
  ConsoleError,
  DomErrorState,
  FailedRequest,
  Route,
  VisitResult,
} from "../types";
// Reutilizamos el arbitrary base de roles (solo lectura; no editamos arbitraries.ts).
import { arbAppRole } from "./arbitraries";

/* ------------------------------------------------------------------ */
/*  Categorías técnicas bajo prueba                                    */
/* ------------------------------------------------------------------ */

/** Las tres categorías que `detectTechnicalAnomalies` puede emitir. */
const TECHNICAL_CATEGORIES: readonly AnomalyCategory[] = [
  "console-error",
  "failed-request",
  "dom-error",
] as const;

/* ------------------------------------------------------------------ */
/*  Building-block arbitraries (locales a este test)                   */
/* ------------------------------------------------------------------ */

/** Una Route mínima válida (UI o API). */
const arbRoute: fc.Arbitrary<Route> = fc
  .record({
    kind: fc.constantFrom<"ui" | "api">("ui", "api"),
    path: fc.constantFrom("/metrics", "/finops", "/admin", "/api/metrics/dora-core", "/api/health"),
  })
  .map(({ kind, path }) => ({
    id: `${kind}:${path}`,
    kind,
    path,
    section: "metrics",
  }));

/** Un Console_Error cualquiera. */
const arbConsoleError: fc.Arbitrary<ConsoleError> = fc.record({
  message: fc.string({ minLength: 1, maxLength: 40 }),
});

/** Una Failed_Request cualquiera. */
const arbFailedRequest: fc.Arbitrary<FailedRequest> = fc.record({
  url: fc.constantFrom(
    "/api/metrics/dora-core",
    "/api/finops/costs",
    "/api/inventory",
    "/api/health",
  ),
  method: fc.constantFrom("GET", "POST", "PUT", "DELETE"),
  status: fc.oneof(fc.constant(null), fc.integer({ min: 400, max: 599 })),
});

/** Un DOM_Error_State cualquiera. */
const arbDomErrorState: fc.Arbitrary<DomErrorState> = fc.record({
  kind: fc.constantFrom<DomErrorState["kind"]>(
    "error-message",
    "blank-page",
    "empty-state",
    "render-exception",
  ),
  detail: fc.string({ minLength: 0, maxLength: 40 }),
});

/**
 * Array que es vacío con probabilidad apreciable y no vacío en otros casos, para
 * cubrir bien las 8 combinaciones de evidencia presente/ausente.
 */
function arbMaybeEmptyArray<T>(item: fc.Arbitrary<T>): fc.Arbitrary<T[]> {
  return fc.oneof(
    { weight: 1, arbitrary: fc.constant([] as T[]) },
    { weight: 2, arbitrary: fc.array(item, { minLength: 1, maxLength: 4 }) },
  );
}

/**
 * arbVisitResult local: varía las tres evidencias técnicas (a veces vacías, a
 * veces no) y rellena el resto de campos con valores técnicamente "limpios"
 * (irrelevantes para `detectTechnicalAnomalies`, que solo mira esos tres arrays).
 */
const arbVisitResult: fc.Arbitrary<VisitResult> = fc
  .record({
    route: arbRoute,
    role: arbAppRole,
    consoleErrors: arbMaybeEmptyArray(arbConsoleError),
    failedRequests: arbMaybeEmptyArray(arbFailedRequest),
    domErrorStates: arbMaybeEmptyArray(arbDomErrorState),
    httpStatus: fc.oneof(fc.constant(null), fc.integer({ min: 100, max: 599 })),
    latencyMs: fc.integer({ min: 0, max: 10_000 }),
    timedOut: fc.boolean(),
    scenarioId: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `scn_${s}`),
    runId: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `run_${s}`),
  })
  .map((r) => ({
    runId: r.runId,
    scenarioId: r.scenarioId,
    route: r.route,
    role: r.role,
    params: {},
    httpStatus: r.httpStatus,
    latencyMs: r.latencyMs,
    timedOut: r.timedOut,
    consoleErrors: r.consoleErrors,
    failedRequests: r.failedRequests,
    domErrorStates: r.domErrorStates,
    dataSignal: null,
    screenshotRef: null,
    accessObserved: "granted" as const,
  }));

/** Conjunto esperado de categorías técnicas según la evidencia no vacía. */
function expectedCategories(visit: VisitResult): Set<AnomalyCategory> {
  const expected = new Set<AnomalyCategory>();
  if (visit.consoleErrors.length > 0) expected.add("console-error");
  if (visit.failedRequests.length > 0) expected.add("failed-request");
  if (visit.domErrorStates.length > 0) expected.add("dom-error");
  return expected;
}

/* ------------------------------------------------------------------ */
/*  Property 12                                                         */
/* ------------------------------------------------------------------ */

test("Property 12: the set of technical anomaly categories equals exactly the set of non-empty evidence categories", () => {
  fc.assert(
    fc.property(arbVisitResult, (visit) => {
      const anomalies = detectTechnicalAnomalies(visit);
      const got = new Set(anomalies.map((a) => a.category));
      const expected = expectedCategories(visit);

      // Igualdad de conjuntos: mismo tamaño y misma pertenencia.
      assert.equal(
        got.size,
        anomalies.length,
        `categorías técnicas duplicadas: ${anomalies.map((a) => a.category).join(", ")}`,
      );
      assert.equal(
        got.size,
        expected.size,
        `nº de categorías ${got.size} != esperado ${expected.size} ` +
          `(got=[${[...got].join(", ")}], expected=[${[...expected].join(", ")}])`,
      );

      // IFF por categoría: cada categoría técnica aparece sii su evidencia no está vacía.
      for (const category of TECHNICAL_CATEGORIES) {
        assert.equal(
          got.has(category),
          expected.has(category),
          `categoría ${category}: presente=${got.has(category)} esperado=${expected.has(category)}`,
        );
      }

      // Solo emite categorías técnicas (no otras como performance/timeout/etc.).
      for (const a of anomalies) {
        assert.ok(
          (TECHNICAL_CATEGORIES as readonly string[]).includes(a.category),
          `categoría no técnica emitida por detectTechnicalAnomalies: ${a.category}`,
        );
        assert.equal(a.detector, "deterministic");
      }
    }),
    { numRuns: 100 },
  );
});

test("Property 12: all-empty evidence yields no technical anomaly", () => {
  fc.assert(
    fc.property(
      arbVisitResult.map((v) => ({
        ...v,
        consoleErrors: [],
        failedRequests: [],
        domErrorStates: [],
      })),
      (visit) => {
        assert.deepEqual(detectTechnicalAnomalies(visit), []);
      },
    ),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Directed example                                                   */
/* ------------------------------------------------------------------ */

test("Property 12 (example): each evidence kind maps to its category, none when clean", () => {
  const route: Route = { id: "ui:/metrics", kind: "ui", path: "/metrics", section: "metrics" };
  const base: VisitResult = {
    runId: "run_x",
    scenarioId: "scn_x",
    route,
    role: "desarrolladores",
    params: {},
    httpStatus: 200,
    latencyMs: 100,
    timedOut: false,
    consoleErrors: [],
    failedRequests: [],
    domErrorStates: [],
    dataSignal: null,
    screenshotRef: null,
    accessObserved: "granted",
  };

  // Clean visit → no technical anomaly.
  assert.deepEqual(detectTechnicalAnomalies(base), []);

  // Only a console error.
  assert.deepEqual(
    detectTechnicalAnomalies({ ...base, consoleErrors: [{ message: "boom" }] }).map((a) => a.category),
    ["console-error"],
  );

  // Only a failed request.
  assert.deepEqual(
    detectTechnicalAnomalies({
      ...base,
      failedRequests: [{ url: "/api/x", method: "GET", status: 500 }],
    }).map((a) => a.category),
    ["failed-request"],
  );

  // Only a DOM error state.
  assert.deepEqual(
    detectTechnicalAnomalies({
      ...base,
      domErrorStates: [{ kind: "error-message", detail: "oops" }],
    }).map((a) => a.category),
    ["dom-error"],
  );

  // All three present → all three categories.
  assert.deepEqual(
    new Set(
      detectTechnicalAnomalies({
        ...base,
        consoleErrors: [{ message: "boom" }],
        failedRequests: [{ url: "/api/x", method: "GET", status: 500 }],
        domErrorStates: [{ kind: "blank-page", detail: "" }],
      }).map((a) => a.category),
    ),
    new Set<AnomalyCategory>(["console-error", "failed-request", "dom-error"]),
  );
});
