// Feature: ai-portal-explorer, Property 22: El resumen del Report es una agregación coherente
/**
 * Property-based test for the Reporter summary aggregation.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/reporter.ts (`buildSummary`).
 *
 * Property 22: El resumen del Report es una agregación coherente.
 *   Para todo Exploration_Run, `buildSummary(visits, triage)` cumple:
 *   - `routesVisited` === nº de `route.path` DISTINTOS entre los Visit_Results.
 *   - La suma de los valores de `anomaliesBySeverity` === `triage.length`
 *     (cada Triage_Result se cuenta exactamente una vez, en su severidad).
 *   - `anomaliesBySeverity[s]` === nº de Triage_Results con severidad `s`,
 *     para cada `s` en `SEVERITY_ORDER`.
 *   - `rbacFindings` === nº de Triage_Results de categoría `rbac`.
 *   - `buildSummary` es determinista e independiente del orden: barajar las
 *     entradas produce exactamente el mismo resumen.
 *
 * **Validates: Requirements 7.4**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/reporter.prop22.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { buildSummary } from "../reporter";
import { SEVERITY_ORDER } from "../types";
import type {
  AnomalyCategory,
  AnomalyEvidence,
  FailedRequest,
  Route,
  Severity,
  TriageResult,
  TriageStatus,
  VisitResult,
} from "../types";
import type { PortalSection } from "@/lib/rbac";
import { arbAppRole } from "./arbitraries";

/* ------------------------------------------------------------------ */
/*  Arbitraries (reusing the prop05 style)                             */
/* ------------------------------------------------------------------ */

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

const TRIAGE_STATUSES: readonly TriageStatus[] = [
  "triaged",
  "triage-unavailable",
  "triage-skipped-budget",
] as const;

const arbSeverity: fc.Arbitrary<Severity> = fc.constantFrom<Severity>(...SEVERITY_ORDER);

/**
 * Conjunto pequeño de paths para que las colisiones (paths repetidos) ocurran
 * con frecuencia y ejerciten el conteo de DISTINTOS de `routesVisited`.
 */
const arbRoutePath: fc.Arbitrary<string> = fc
  .constantFrom("metrics", "finops", "admin", "synthetics", "api/metrics/team-activity", "")
  .map((s) => `/${s}`);

const arbRoute: fc.Arbitrary<Route> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
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

const arbTriageResult: fc.Arbitrary<TriageResult> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 16 }),
  route: arbRoutePath,
  role: arbAppRole,
  severity: arbSeverity,
  category: fc.constantFrom(...ANOMALY_CATEGORIES),
  probable_cause: fc.string({ maxLength: 50 }),
  suggested_fix: fc.string({ maxLength: 50 }),
  evidence: arbEvidence,
  status: fc.constantFrom(...TRIAGE_STATUSES),
}) as fc.Arbitrary<TriageResult>;

/** Visit_Result mínimo pero coherente (buildSummary solo usa route.path). */
const arbVisitResult: fc.Arbitrary<VisitResult> = fc
  .record({
    route: arbRoute,
    role: arbAppRole,
    httpStatus: fc.option(fc.integer({ min: 100, max: 599 }), { nil: null }),
    latencyMs: fc.integer({ min: 0, max: 60000 }),
    timedOut: fc.boolean(),
    accessObserved: fc.constantFrom<"granted" | "denied">("granted", "denied"),
  })
  .map(
    (v): VisitResult => ({
      runId: "run-prop22",
      scenarioId: "scn-prop22",
      route: v.route,
      role: v.role,
      params: {},
      httpStatus: v.httpStatus,
      latencyMs: v.latencyMs,
      timedOut: v.timedOut,
      consoleErrors: [],
      failedRequests: [],
      domErrorStates: [],
      dataSignal: null,
      screenshotRef: null,
      accessObserved: v.accessObserved,
    }),
  );

/** Permutación determinista de un array a partir de una semilla de índices. */
function shuffleBy<T>(items: readonly T[], order: readonly number[]): T[] {
  return items
    .map((item, i) => ({ item, key: order[i] ?? i }))
    .sort((a, b) => a.key - b.key || 0)
    .map(({ item }) => item);
}

/* ------------------------------------------------------------------ */
/*  Property 22                                                        */
/* ------------------------------------------------------------------ */

test("Property 22: el resumen del Report es una agregación coherente", async () => {
  await fc.assert(
    fc.property(
      fc.array(arbVisitResult, { maxLength: 12 }),
      fc.array(arbTriageResult, { maxLength: 12 }),
      // Claves de orden para barajar visits y triage de forma independiente.
      fc.array(fc.integer({ min: 0, max: 1000 }), { maxLength: 12 }),
      fc.array(fc.integer({ min: 0, max: 1000 }), { maxLength: 12 }),
      (visits, triage, visitOrder, triageOrder) => {
        const summary = buildSummary(visits, triage);

        // (1) routesVisited === nº de route.path DISTINTOS.
        const distinctPaths = new Set(visits.map((v) => v.route.path));
        assert.equal(
          summary.routesVisited,
          distinctPaths.size,
          "routesVisited debe ser el nº de paths distintos",
        );

        // (2) suma de anomaliesBySeverity === triage.length.
        const totalBySeverity = SEVERITY_ORDER.reduce(
          (acc, s) => acc + summary.anomaliesBySeverity[s],
          0,
        );
        assert.equal(
          totalBySeverity,
          triage.length,
          "cada Triage_Result se cuenta exactamente una vez por severidad",
        );

        // (3) anomaliesBySeverity[s] === nº de triage con severidad s.
        for (const severity of SEVERITY_ORDER) {
          const expected = triage.filter((t) => t.severity === severity).length;
          assert.equal(
            summary.anomaliesBySeverity[severity],
            expected,
            `anomaliesBySeverity[${severity}] debe contar los triage de esa severidad`,
          );
        }

        // (4) rbacFindings === nº de triage de categoría "rbac".
        const expectedRbac = triage.filter((t) => t.category === "rbac").length;
        assert.equal(
          summary.rbacFindings,
          expectedRbac,
          "rbacFindings debe contar los triage de categoría rbac",
        );

        // (5) determinista e independiente del orden: barajar → mismo resumen.
        const shuffledVisits = shuffleBy(visits, visitOrder);
        const shuffledTriage = shuffleBy(triage, triageOrder);
        const shuffledSummary = buildSummary(shuffledVisits, shuffledTriage);
        assert.deepEqual(
          shuffledSummary,
          summary,
          "buildSummary debe ser independiente del orden de las entradas",
        );
      },
    ),
    { numRuns: 100 },
  );
});
