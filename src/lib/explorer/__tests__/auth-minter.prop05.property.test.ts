// Feature: ai-portal-explorer, Property 5: Las sesiones sintéticas nunca se persisten en el Report
/**
 * Property-based test for the Auth_Minter ↔ Reporter boundary.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/auth-minter.ts + reporter.ts
 *
 * Property 5: Las sesiones sintéticas nunca se persisten en el Report.
 *   El valor de la cookie de la Synthetic_Session (el JWE cifrado con
 *   `NEXTAUTH_SECRET`) NUNCA debe aparecer en el Report — ni en su forma
 *   estructurada (`JSON.stringify(report)`) ni en su renderizado Markdown
 *   (`renderMarkdown(report)`). El tipo `Report` no contiene la sesión por
 *   construcción, así que esta propiedad protege ese invariante estructural:
 *   por mucho que variemos el Report y el Role acuñado, el secreto de sesión
 *   queda fuera. (Req 2.6)
 *
 * **Validates: Requirements 2.6**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/auth-minter.prop05.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { mintSyntheticSession } from "../auth-minter";
import { buildSummary, renderMarkdown } from "../reporter";
import type { Report } from "../reporter";
import type { RegressionReport } from "../regression-detector";
import { SEVERITY_ORDER } from "../types";
import type {
  AnomalyCategory,
  AnomalyEvidence,
  ExplorationRun,
  FailedRequest,
  Route,
  RunStatus,
  Severity,
  TriageResult,
  TriageStatus,
  VisitResult,
} from "../types";
import type { PortalSection } from "@/lib/rbac";
import { arbAppRole } from "./arbitraries";

/**
 * El Auth_Minter exige `NEXTAUTH_SECRET` para acuñar (cifrar el JWE). Lo fijamos
 * a un valor de test estable para que `mintSyntheticSession` funcione.
 */
process.env.NEXTAUTH_SECRET =
  process.env.NEXTAUTH_SECRET ?? "test-secret-prop05-ai-portal-explorer-do-not-use-in-prod";

/* ------------------------------------------------------------------ */
/*  Arbitraries (simple but realistic Report shapes)                   */
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

const RUN_STATUSES: readonly RunStatus[] = [
  "running",
  "completed",
  "completed-with-errors",
  "aborted",
] as const;

const arbSeverity: fc.Arbitrary<Severity> = fc.constantFrom<Severity>(...SEVERITY_ORDER);

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
      runId: "run-prop05",
      scenarioId: "scn-prop05",
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

const arbExplorationRun: fc.Arbitrary<ExplorationRun> = fc.record({
  runId: fc.uuid(),
  startedAt: fc.constant("2026-06-20T10:00:00.000Z"),
  finishedAt: fc.option(fc.constant("2026-06-20T10:05:00.000Z"), { nil: null }),
  status: fc.constantFrom(...RUN_STATUSES),
  abortReason: fc.option(fc.string({ maxLength: 30 }), { nil: null }),
  rolesCovered: fc.uniqueArray(arbAppRole, { maxLength: 5 }),
  baseUrl: fc.constant("https://portal.today.dev.tooling.dp.iskaypet.com"),
}) as fc.Arbitrary<ExplorationRun>;

const arbRegressionReport: fc.Arbitrary<RegressionReport> = fc.oneof(
  fc.constant<RegressionReport>({ hasBaseline: false, regressions: [] }),
  fc.array(arbTriageResult, { maxLength: 4 }).map(
    (regressions): RegressionReport => ({ hasBaseline: true, regressions }),
  ),
);

const arbReport: fc.Arbitrary<Report> = fc
  .record({
    run: arbExplorationRun,
    triageResults: fc.array(arbTriageResult, { maxLength: 6 }),
    regressions: arbRegressionReport,
    visits: fc.array(arbVisitResult, { maxLength: 6 }),
  })
  .map(
    ({ run, triageResults, regressions, visits }): Report => ({
      run,
      triageResults,
      regressions,
      summary: buildSummary(visits, triageResults),
    }),
  );

/* ------------------------------------------------------------------ */
/*  Property 5                                                         */
/* ------------------------------------------------------------------ */

test("Property 5: la cookie de la sesión sintética nunca aparece en el Report", async () => {
  await fc.assert(
    fc.asyncProperty(arbAppRole, arbReport, async (role, report) => {
      const session = await mintSyntheticSession(role);

      // Sanity: la cookie es un JWE no vacío (segmentos base64url separados por '.').
      assert.ok(session.cookieValue.length > 0, "el JWE acuñado no debe estar vacío");

      // (a) Forma estructurada del Report.
      const structured = JSON.stringify(report);
      assert.ok(
        !structured.includes(session.cookieValue),
        "el valor de la cookie NO debe aparecer en la forma estructurada del Report",
      );

      // (b) Markdown del Report.
      const markdown = renderMarkdown(report);
      assert.ok(
        !markdown.includes(session.cookieValue),
        "el valor de la cookie NO debe aparecer en el Markdown del Report",
      );
    }),
    { numRuns: 100 },
  );
});
