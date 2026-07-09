// Feature: ai-portal-explorer, Property 24: La ejecución es única (no concurrente)
//
// IMPORTANTE: este import DEBE ser el primero. El orquestador importa
// transitivamente el Triage_Engine, que carga el AWS SDK de Bedrock, cuyo
// middleware referencia los globals de Web Streams (TransformStream/...). El
// polyfill los expone en globalThis antes de que el SDK se evalúe.
import "./web-streams-polyfill";

/**
 * Property-based test del Run_Orchestrator — ejecución única (no concurrente).
 *
 * Feature: ai-portal-explorer — src/lib/explorer/orchestrator.ts
 *   (`claimRunLock`, `runExploration`).
 *
 * Property 24: La ejecución es única (no concurrente).
 *   Para toda secuencia de intentos de claim del lock de ejecución SIN liberación
 *   intermedia, exactamente el primer intento adquiere el lock (`acquired = true`)
 *   y todos los posteriores son rechazados (`acquired = false`).
 *
 *   Se verifica en dos niveles:
 *   (A) A nivel de `claimRunLock`: N claims secuenciales contra un lock que NO se
 *       libera entre intentos → solo el primero adquiere; el resto se rechaza.
 *   (B) A nivel de `runExploration`: con el lock ya retenido por otro run, una
 *       nueva llamada NO arranca un segundo run concurrente — devuelve un Report
 *       con `run.status === "aborted"` y un `abortReason` que menciona que ya hay
 *       un run en curso, y el Crawler NUNCA llega a visitar (ni se crea).
 *
 * El Report_Store se mockea por completo (deps inyectadas) y el "lock" se modela
 * como un objeto en memoria que solo concede el lock una vez hasta liberarlo, de
 * modo que NO hay ningún I/O real (PostgreSQL, Bedrock, S3, Teams, Playwright).
 *
 * **Validates: Requirements 9.5**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/orchestrator.prop24.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { claimRunLock, runExploration } from "../orchestrator";
import type { OrchestratorDeps, RunConfig } from "../orchestrator";
import { DEFAULT_SCENARIO_MATRIX } from "../scenario-generator";
import type { SyntheticSession } from "../auth-minter";
import type { AppRole } from "@/lib/rbac";
import type { Crawler } from "../crawler";
import type { Route, Scenario, VisitResult } from "../types";
import { arbAppRole } from "./arbitraries";

/* ------------------------------------------------------------------ */
/*  Mock del lock de ejecución (in-memory, sin I/O)                    */
/* ------------------------------------------------------------------ */

/**
 * Modela la tabla singleton `explorer_run_lock` en memoria. El claim atómico
 * (`UPDATE ... WHERE id=1 AND active_run_id IS NULL`) concede el lock (rowCount
 * 1) SOLO si está libre; mientras se mantiene retenido devuelve rowCount 0. La
 * liberación (`active_run_id = NULL`) solo surte efecto para el `runId` titular.
 */
function makeMockPool(initialActiveRunId: string | null = null) {
  const state = { activeRunId: initialActiveRunId };
  const calls = { insert: 0, claim: 0, release: 0, other: 0 };

  const pool = {
    async query(text: string, params?: unknown[]) {
      if (text.includes("INSERT INTO explorer_run_lock")) {
        calls.insert += 1;
        return { rows: [] as Record<string, unknown>[], rowCount: 1 };
      }
      if (
        text.includes("UPDATE explorer_run_lock") &&
        text.includes("active_run_id IS NULL")
      ) {
        calls.claim += 1;
        if (state.activeRunId === null) {
          state.activeRunId = String((params ?? [])[0]);
          return { rows: [] as Record<string, unknown>[], rowCount: 1 };
        }
        return { rows: [] as Record<string, unknown>[], rowCount: 0 };
      }
      if (
        text.includes("UPDATE explorer_run_lock") &&
        text.includes("active_run_id = NULL")
      ) {
        calls.release += 1;
        if (state.activeRunId === String((params ?? [])[0])) {
          state.activeRunId = null;
          return { rows: [] as Record<string, unknown>[], rowCount: 1 };
        }
        return { rows: [] as Record<string, unknown>[], rowCount: 0 };
      }
      // Cualquier otra query (no debería ocurrir: el store está mockeado).
      calls.other += 1;
      return { rows: [] as Record<string, unknown>[], rowCount: 0 };
    },
  };

  return { pool, state, calls };
}

/* ------------------------------------------------------------------ */
/*  Property 24 (A) — claimRunLock: N claims sin liberación            */
/* ------------------------------------------------------------------ */

test("Property 24 (A): N claims secuenciales con lock retenido → solo el primero adquiere", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 25 }), async (n) => {
      const { pool } = makeMockPool(null);
      let counter = 0;
      const deps: OrchestratorDeps = {
        pool,
        generateRunId: () => `run-${counter++}`,
      };

      const results: { acquired: boolean; runId: string }[] = [];
      for (let i = 0; i < n; i += 1) {
        // No se libera el lock entre intentos.
        results.push(await claimRunLock(deps));
      }

      // Exactamente el primero adquiere.
      assert.equal(results[0].acquired, true, "el primer claim debe adquirir el lock");
      for (let i = 1; i < n; i += 1) {
        assert.equal(
          results[i].acquired,
          false,
          `el claim #${i} debe ser rechazado (lock retenido)`,
        );
      }

      // Exactamente uno adquiere en toda la secuencia.
      const acquiredCount = results.filter((r) => r.acquired).length;
      assert.equal(acquiredCount, 1, "exactamente un claim adquiere el lock");

      // Cada intento genera un runId único (para poder registrar el rechazo).
      const ids = new Set(results.map((r) => r.runId));
      assert.equal(ids.size, n, "cada intento de claim genera un runId distinto");
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 24 (B) — runExploration con el lock ya retenido           */
/* ------------------------------------------------------------------ */

/** baseUrl válida del Target_Environment de desarrollo (portal-dev). */
const DEV_BASE_URL = "https://portal.today.dev.tooling.dp.iskaypet.com";

/** Conjunto no vacío de roles distintos, en orden de barrido. */
const arbRoles: fc.Arbitrary<AppRole[]> = fc
  .uniqueArray(arbAppRole, { minLength: 1, maxLength: 5 })
  .map((roles) => roles as AppRole[]);

test("Property 24 (B): un segundo run con el lock retenido aborta sin visitar", async () => {
  await fc.assert(
    fc.asyncProperty(arbRoles, async (roles) => {
      // El lock ya está retenido por un run previo (no liberado).
      const { pool, state } = makeMockPool("run-held-by-first");

      let visitCalls = 0;
      let createCrawlerCalls = 0;

      const fakeCrawler: Crawler = {
        async visit(
          route: Route,
          role: AppRole,
          scenario: Scenario,
          _session: SyntheticSession,
        ): Promise<VisitResult> {
          visitCalls += 1;
          return {
            runId: "should-not-happen",
            scenarioId: scenario.scenarioId,
            route,
            role,
            params: scenario.params,
            httpStatus: 200,
            latencyMs: 1,
            timedOut: false,
            consoleErrors: [],
            failedRequests: [],
            domErrorStates: [],
            dataSignal: null,
            screenshotRef: null,
            accessObserved: "granted",
          };
        },
        async close() {
          /* noop */
        },
      };

      let storeWrites = 0;
      const deps: OrchestratorDeps = {
        pool,
        store: {
          createRun: async () => {
            storeWrites += 1;
          },
          updateRunTerminal: async () => {
            storeWrites += 1;
          },
          persistVisitResult: async () => true,
          persistAnomaly: async () => {},
          persistTriageResults: async () => {},
          loadPreviousRunTriage: async () => null,
        },
        createCrawler: () => {
          createCrawlerCalls += 1;
          return fakeCrawler;
        },
        // El triage NUNCA debe invocarse en el camino abortado.
        triageDeps: {
          invokeBedrock: async () => {
            throw new Error("Bedrock no debe invocarse en un run abortado");
          },
          parseTriage: () => {
            throw new Error("parseTriage no debe invocarse en un run abortado");
          },
        },
        putScreenshot: async () => "s3://noop/screenshot.png",
        putReportMarkdown: async () => "s3://noop/report.md",
        notifyExplorerRun: async () => ({ sent: false, reason: "no-webhook" }),
        buildRouteInventory: async () => [],
        canMintSessions: () => true,
        mintSyntheticSession: async (role: AppRole): Promise<SyntheticSession> => ({
          role,
          cookieName: "__Secure-next-auth.session-token",
          cookieValue: "synthetic-jwe",
          synthetic: true,
        }),
        generateRunId: () => "run-second-attempt",
        runDate: "2026-06-20",
        onProgress: () => {},
      };

      const config: RunConfig = {
        baseUrl: DEV_BASE_URL,
        roles,
        scenarioMatrix: DEFAULT_SCENARIO_MATRIX,
        detector: { latencyThresholdMs: 3000, seriesEndToleranceDays: 2 },
        bedrockBudget: 5,
        visitTimeoutMs: 1000,
      };

      const report = await runExploration(config, deps);

      // El run no concurrente se aborta.
      assert.equal(report.run.status, "aborted", "el segundo run debe abortar");
      assert.ok(report.run.abortReason, "debe registrar un motivo de aborto");
      assert.match(
        report.run.abortReason ?? "",
        /en curso|concurrente|progress/i,
        "el motivo debe indicar que ya hay un run en curso",
      );

      // El Crawler NUNCA se crea ni visita: no hay segundo run concurrente.
      assert.equal(createCrawlerCalls, 0, "no debe crearse el Crawler");
      assert.equal(visitCalls, 0, "no debe ejecutarse ninguna Visit");

      // No se generan triages ni anomalías en el camino abortado.
      assert.equal(report.triageResults.length, 0, "no debe haber Triage_Results");
      assert.equal(
        report.summary.routesVisited,
        0,
        "no debe haberse visitado ninguna ruta",
      );

      // El lock ajeno NO se ha tocado (el segundo run no lo robó ni liberó).
      assert.equal(
        state.activeRunId,
        "run-held-by-first",
        "el lock del primer run debe permanecer intacto",
      );

      // Se registró el rechazo (createRun + updateRunTerminal del intento).
      assert.ok(storeWrites >= 1, "el rechazo del inicio duplicado debe registrarse");
    }),
    { numRuns: 100 },
  );
});
