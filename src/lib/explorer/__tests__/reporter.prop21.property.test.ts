// Feature: ai-portal-explorer, Property 21: El Markdown del Report contiene la evidencia de cada triage
/**
 * Property-based test for the Reporter Markdown rendering.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/reporter.ts
 *
 * Property 21: El Markdown del Report contiene la evidencia de cada triage.
 *   Para todo Report, el documento Markdown renderizado por `renderMarkdown`
 *   incluye, para CADA Triage_Result, su Route, Role, Severity, categoría,
 *   causa probable, fix sugerido y una referencia a la evidencia.
 *
 *   Para que las aserciones de containment sean robustas, los campos de texto
 *   libre del Triage_Result (route, probable_cause, suggested_fix) y el resumen
 *   de la evidencia se generan a partir de un alfabeto restringido
 *   (alfanumérico + espacios, sin caracteres que rompan el Markdown como `|` o
 *   saltos de línea), de modo que aparecen verbatim en el Markdown renderizado.
 *
 * **Validates: Requirements 7.1, 7.2, 7.3**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/reporter.prop21.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

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

/* ------------------------------------------------------------------ */
/*  Restricted-alphabet text: alfanumérico + espacios, no vacío.       */
/*  Garantiza que el valor aparece verbatim en el Markdown (no rompe   */
/*  tablas ni cabeceras y no contiene saltos de línea).                */
/* ------------------------------------------------------------------ */

const SAFE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ".split("");

const arbSafeText: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SAFE_CHARS), { minLength: 1, maxLength: 30 })
  .map((chars) => chars.join(""))
  .filter((s) => s.trim().length > 0);

/** Path de Route con alfabeto restringido (sin espacios para parecer un path). */
const arbSafeRoutePath: fc.Arbitrary<string> = fc
  .array(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/".split("")),
    { minLength: 1, maxLength: 24 },
  )
  .map((chars) => `/${chars.join("")}`);

/* ------------------------------------------------------------------ */
/*  Arbitraries (estilo prop05, restringidos para containment robusto) */
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

const arbRoute: fc.Arbitrary<Route> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  kind: fc.constantFrom<"ui" | "api">("ui", "api"),
  path: arbSafeRoutePath,
  section: fc.constantFrom(...SECTIONS),
}) as fc.Arbitrary<Route>;

const arbFailedRequest: fc.Arbitrary<FailedRequest> = fc.record({
  url: fc.webUrl(),
  method: fc.constantFrom("GET", "HEAD"),
  status: fc.option(fc.integer({ min: 400, max: 599 }), { nil: null }),
});

/**
 * Evidencia con `summary` en alfabeto restringido NO vacío: ese summary es el
 * prefijo verbatim de `evidenceReference(result)` en el Markdown, así que sirve
 * de "referencia a la evidencia" comprobable por containment.
 */
const arbEvidence: fc.Arbitrary<AnomalyEvidence> = fc.record({
  summary: arbSafeText,
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
  route: arbSafeRoutePath,
  role: arbAppRole,
  severity: arbSeverity,
  category: fc.constantFrom(...ANOMALY_CATEGORIES),
  probable_cause: arbSafeText,
  suggested_fix: arbSafeText,
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
      runId: "run-prop21",
      scenarioId: "scn-prop21",
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

/**
 * Report con al menos un Triage_Result (minLength: 1) para ejercitar de verdad
 * la sección de hallazgos (con 0 resultados la propiedad es vacuamente cierta).
 */
const arbReport: fc.Arbitrary<Report> = fc
  .record({
    run: arbExplorationRun,
    triageResults: fc.array(arbTriageResult, { minLength: 1, maxLength: 6 }),
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
/*  Property 21                                                        */
/* ------------------------------------------------------------------ */

test("Property 21: el Markdown del Report contiene la evidencia de cada triage", () => {
  fc.assert(
    fc.property(arbReport, (report) => {
      const markdown = renderMarkdown(report);

      for (const result of report.triageResults) {
        assert.ok(
          markdown.includes(result.route),
          `el Markdown debe contener la Route del triage: ${result.route}`,
        );
        assert.ok(
          markdown.includes(result.role),
          `el Markdown debe contener el Role del triage: ${result.role}`,
        );
        assert.ok(
          markdown.includes(result.severity),
          `el Markdown debe contener la Severity del triage: ${result.severity}`,
        );
        assert.ok(
          markdown.includes(result.category),
          `el Markdown debe contener la categoría del triage: ${result.category}`,
        );
        assert.ok(
          markdown.includes(result.probable_cause),
          `el Markdown debe contener la causa probable del triage: ${result.probable_cause}`,
        );
        assert.ok(
          markdown.includes(result.suggested_fix),
          `el Markdown debe contener el fix sugerido del triage: ${result.suggested_fix}`,
        );
        // Referencia a la evidencia: el summary es el prefijo verbatim de
        // evidenceReference(result), así que su presencia prueba que el Markdown
        // incluye una referencia a la evidencia de este triage.
        assert.ok(
          markdown.includes(result.evidence.summary),
          `el Markdown debe contener la referencia a la evidencia del triage: ${result.evidence.summary}`,
        );
      }
    }),
    { numRuns: 100 },
  );
});
