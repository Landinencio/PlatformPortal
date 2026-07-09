// Feature: ai-portal-explorer, Property 26: El estado terminal refleja si hubo errores
/**
 * Property-based test for the Run_Orchestrator.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/orchestrator.ts
 *
 * Property 26: El estado terminal refleja si hubo errores.
 *   *Para todo* Exploration_Run sobre portal-dev (lock adquirible), el estado
 *   terminal persistido vía `updateRunTerminal` —y reflejado en `report.run.status`—
 *   es `completed-with-errors` si y solo si al menos una Visit registró una
 *   excepción no controlada O al menos una persistencia de Visit_Result falló
 *   (`persistVisitResult` devolvió `false`); en caso contrario es `completed`.
 *
 *   Además, el estado registrado en `updateRunTerminal` coincide exactamente con
 *   `report.run.status` (la misma fuente de verdad).
 *
 *   Caso adicional (no-dev baseUrl) → el run se aborta antes de cualquier Visit
 *   con estado `aborted`.
 *
 * **Validates: Requirements 10.2**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/orchestrator.prop26.property.test.ts
 */

// Polyfill de Web Streams globals (Node 16) ANTES de cargar el AWS SDK que
// arrastra el orchestrator vía triage-engine. Debe ser el PRIMER import.
import "./web-streams-polyfill";

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { runExploration, type OrchestratorDeps, type RunConfig } from "../orchestrator";
import type { Queryable } from "../report-store";
import type { Crawler, CrawlerConfig } from "../crawler";
import type { SyntheticSession } from "../auth-minter";
import type { ExplorerNotifyResult } from "../teams-notifier";
import type { Report } from "../reporter";
import type { AppRole } from "@/lib/rbac";
import type { Route, Scenario, VisitResult } from "../types";
import { DEV_TARGET_HOST } from "../safety-guard";

/* ------------------------------------------------------------------ */
/*  Constantes y dobles de prueba                                       */
/* ------------------------------------------------------------------ */

const DEV_BASE_URL = `https://${DEV_TARGET_HOST}`;
const FIXED_RUN_ID = "run-prop26-fixed";

/** Pool simulado: el claim del lock siempre adquiere (rowCount=1). */
function makePool(): Queryable {
  return {
    async query() {
      // rowCount=1 → claimRunLock adquiere el lock; el resto de queries (que el
      // test no usa porque el store está mockeado) también responden inocuamente.
      return { rows: [], rowCount: 1 };
    },
  };
}

/** Construye un VisitResult "limpio" (sin error) para una Visit exitosa. */
function cleanVisit(
  runId: string,
  route: Route,
  role: AppRole,
  scenario: Scenario,
): VisitResult {
  return {
    runId,
    scenarioId: scenario.scenarioId,
    route,
    role,
    params: scenario.params,
    httpStatus: 200,
    latencyMs: 10,
    timedOut: false,
    consoleErrors: [],
    failedRequests: [],
    domErrorStates: [],
    dataSignal: { isEmptyState: false, rowCount: 5, timeSeries: null, pagination: null, totals: {} },
    screenshotRef: null,
    accessObserved: "granted",
  };
}

/** Outcome por-Visit que el test controla. */
interface VisitOutcome {
  /** La Visit lanza una excepción no controlada (Req 10.1). */
  throws: boolean;
  /** `persistVisitResult` devuelve `true` (ok) o `false` (fallo, Req 10.5). */
  persistOk: boolean;
}

/**
 * Construye las dependencias del orquestador con todo el I/O mockeado. Las
 * Visits y las persistencias se accionan por la cola `outcomes`, consumida en
 * orden de iteración (un Role × N Routes, una Scenario por Route).
 *
 * Captura el estado terminal pasado a `updateRunTerminal`.
 */
function makeDeps(outcomes: VisitOutcome[]): {
  deps: OrchestratorDeps;
  recorded: { status: string | null };
} {
  const recorded: { status: string | null } = { status: null };

  // Una Route por outcome, sin paramSpec → exactamente una Scenario por Route.
  const routes: Route[] = outcomes.map((_, i) => ({
    id: `r${i}`,
    kind: "ui",
    path: `/route${i}`,
    section: "metrics",
  }));

  let visitIdx = 0;
  let persistIdx = 0;

  const fakeCrawler: Crawler = {
    async visit(route, role, scenario) {
      const outcome = outcomes[visitIdx] ?? { throws: false, persistOk: true };
      visitIdx += 1;
      if (outcome.throws) {
        throw new Error(`Visit simulada fallida en ${route.path}`);
      }
      return cleanVisit(FIXED_RUN_ID, route, role, scenario);
    },
    async close() {
      /* noop */
    },
  };

  const deps: OrchestratorDeps = {
    pool: makePool(),
    store: {
      async createRun() {
        /* noop */
      },
      async updateRunTerminal(input) {
        recorded.status = input.status;
      },
      async persistVisitResult() {
        const outcome = outcomes[persistIdx] ?? { throws: false, persistOk: true };
        persistIdx += 1;
        return outcome.persistOk;
      },
      async persistAnomaly() {
        /* noop */
      },
      async persistTriageResults() {
        /* noop */
      },
      async loadPreviousRunTriage() {
        return null;
      },
    },
    createCrawler: (_config: CrawlerConfig) => fakeCrawler,
    triageDeps: {
      async invokeBedrock() {
        return "{}";
      },
      parseTriage: (_raw, anomaly) => ({
        id: anomaly.anomalyId,
        route: anomaly.route.path,
        role: anomaly.role,
        severity: "medium",
        category: anomaly.category,
        probable_cause: "x",
        suggested_fix: "y",
        evidence: anomaly.evidence,
        status: "triaged",
      }),
    },
    async putScreenshot() {
      return "s3://explorer/shot.png";
    },
    async putReportMarkdown() {
      return "s3://explorer/report.md";
    },
    async notifyExplorerRun(): Promise<ExplorerNotifyResult> {
      return { sent: true, reason: "sent" };
    },
    async buildRouteInventory() {
      return routes;
    },
    canMintSessions: () => true,
    async mintSyntheticSession(role: AppRole): Promise<SyntheticSession> {
      return {
        role,
        cookieName: "__Secure-next-auth.session-token",
        cookieValue: `synthetic-${role}`,
        synthetic: true,
      };
    },
    generateRunId: () => FIXED_RUN_ID,
    runDate: "2026-06-26",
    triggerSource: "on-demand",
    buildReportUrl: (ref, runId) => ref ?? `explorer-run:${runId}`,
    onProgress: () => {
      /* silencio en el test */
    },
  };

  return { deps, recorded };
}

function baseConfig(baseUrl: string): RunConfig {
  return {
    baseUrl,
    roles: ["admin"],
    scenarioMatrix: { dateRanges: [], filtersBySection: {} },
    detector: { latencyThresholdMs: 5000, seriesEndToleranceDays: 2 },
    bedrockBudget: 0,
    visitTimeoutMs: 30_000,
  };
}

/* ------------------------------------------------------------------ */
/*  Arbitraries                                                         */
/* ------------------------------------------------------------------ */

const arbOutcome: fc.Arbitrary<VisitOutcome> = fc.record({
  throws: fc.boolean(),
  persistOk: fc.boolean(),
});

/* ------------------------------------------------------------------ */
/*  Property 26                                                         */
/* ------------------------------------------------------------------ */

test("Property 26: el estado terminal es completed-with-errors sii hubo algún fallo de Visit o persistencia", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbOutcome, { minLength: 1, maxLength: 6 }),
      async (outcomes) => {
        const { deps, recorded } = makeDeps(outcomes);
        const report: Report = await runExploration(baseConfig(DEV_BASE_URL), deps);

        const anyError = outcomes.some((o) => o.throws || !o.persistOk);
        const expected = anyError ? "completed-with-errors" : "completed";

        // El run no se abortó (baseUrl es dev y el lock se adquirió).
        assert.notEqual(report.run.status, "aborted", "el run no debe abortarse");

        // El estado terminal refleja exactamente si hubo errores (Req 10.2).
        assert.equal(
          report.run.status,
          expected,
          `report.run.status debe ser ${expected} (anyError=${anyError})`,
        );

        // El estado registrado vía updateRunTerminal coincide con report.run.status.
        assert.equal(
          recorded.status,
          report.run.status,
          "updateRunTerminal recibió el mismo estado que report.run.status",
        );
        assert.equal(recorded.status, expected, `updateRunTerminal recibió ${expected}`);
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 26 (extra): una baseUrl que no es portal-dev aborta el run", async () => {
  const { deps, recorded } = makeDeps([{ throws: false, persistOk: true }]);
  const report = await runExploration(
    baseConfig("https://portal.today.tooling.dp.iskaypet.com"),
    deps,
  );

  assert.equal(report.run.status, "aborted", "baseUrl de producción → aborted");
  assert.equal(recorded.status, "aborted", "updateRunTerminal recibió 'aborted'");
});
