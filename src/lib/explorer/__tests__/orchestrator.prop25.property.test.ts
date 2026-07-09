// Feature: ai-portal-explorer, Property 25: Un fallo de Visit no aborta el run y queda registrado
/**
 * Property-based test for the Run_Orchestrator.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/orchestrator.ts
 *
 * Property 25: Un fallo de Visit no aborta el run y queda registrado.
 *   Para TODO conjunto de Visits donde un subconjunto arbitrario lanza una
 *   excepción no controlada, `runExploration`:
 *     - NUNCA rechaza: siempre resuelve con un Report.
 *     - Cada Visit (Scenario×Role) que lanzó queda REGISTRADA (persistida) como
 *       un Visit_Result con `uncaughtError` (su Route y Role conservados), y se
 *       llamó a `persistVisitResult` para ella.
 *     - El run NO aborta: `run.status` es "completed" o "completed-with-errors"
 *       (NUNCA "aborted") — y específicamente "completed-with-errors" cuando al
 *       menos una Visit lanzó.
 *     - El total de Visits persistidas === roles × scenarios (ninguna se
 *       descarta por el fallo de las vecinas).
 *
 * **Validates: Requirements 10.1**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/orchestrator.prop25.property.test.ts
 */

// Polyfill de Web Streams globals (Node 16) ANTES de cargar el AWS SDK: el
// orquestador importa el triage-engine, que importa @aws-sdk/client-bedrock-runtime.
// Los imports de ES se evalúan en orden, así que este va primero.
import "./web-streams-polyfill";

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { runExploration, type OrchestratorDeps, type RunConfig } from "../orchestrator";
import type { Crawler, CrawlerConfig } from "../crawler";
import type { Queryable } from "../report-store";
import type { SyntheticSession } from "../auth-minter";
import { defaultParseTriage, type TriageDeps } from "../triage-engine";
import { DEV_TARGET_HOST } from "../safety-guard";
import type { AppRole } from "@/lib/rbac";
import type { Route, Scenario, VisitResult } from "../types";
import { ALL_APP_ROLES } from "./arbitraries";

/* ------------------------------------------------------------------ */
/*  Constantes del entorno simulado                                     */
/* ------------------------------------------------------------------ */

/** baseUrl que SÍ es el Target_Environment de desarrollo (portal-dev). */
const DEV_BASE_URL = `https://${DEV_TARGET_HOST}`;

const RUN_CONFIG_BASE: Omit<RunConfig, "roles"> = {
  baseUrl: DEV_BASE_URL,
  // Matriz mínima: sin paramSpec en las Routes ⇒ 1 scenario por Route.
  scenarioMatrix: { dateRanges: [], filtersBySection: {} },
  detector: { latencyThresholdMs: 5000, seriesEndToleranceDays: 1 },
  bedrockBudget: 0,
  visitTimeoutMs: 30_000,
};

/* ------------------------------------------------------------------ */
/*  Mocks de I/O (sin navegador, sin AWS, sin PostgreSQL)               */
/* ------------------------------------------------------------------ */

/** Pool que concede el lock (UPDATE rowCount 1) y acepta todo lo demás. */
function makePoolMock(): Queryable {
  return {
    async query() {
      return { rows: [], rowCount: 1 };
    },
  };
}

/** Sesión sintética falsa para un Role. */
function fakeSession(role: AppRole): SyntheticSession {
  return {
    role,
    cookieName: "__Secure-next-auth.session-token",
    cookieValue: `jwe-${role}`,
    synthetic: true,
  };
}

/** Visit_Result limpio (sin error) para los scenarios que NO lanzan. */
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
    dataSignal: null,
    screenshotRef: null,
    accessObserved: "granted",
  };
}

/** Triage_Deps con Bedrock simulado que devuelve JSON válido. */
function makeTriageDeps(): TriageDeps {
  return {
    async invokeBedrock() {
      return JSON.stringify({
        severity: "high",
        probable_cause: "causa simulada",
        suggested_fix: "fix simulado",
      });
    },
    parseTriage: defaultParseTriage,
  };
}

/* ------------------------------------------------------------------ */
/*  Arbitrary del caso: roles, nº de routes y subconjunto que lanza     */
/* ------------------------------------------------------------------ */

interface Case {
  roles: AppRole[];
  routeCount: number;
  /** Una bandera por (role, route) en orden role-major; true ⇒ la Visit lanza. */
  throwFlags: boolean[];
}

const arbCase: fc.Arbitrary<Case> = fc
  .record({
    roles: fc.subarray([...ALL_APP_ROLES], { minLength: 1 }),
    routeCount: fc.integer({ min: 1, max: 4 }),
  })
  .chain(({ roles, routeCount }) => {
    const total = roles.length * routeCount;
    return fc.record({
      roles: fc.constant(roles),
      routeCount: fc.constant(routeCount),
      throwFlags: fc.array(fc.boolean(), { minLength: total, maxLength: total }),
    });
  });

/* ------------------------------------------------------------------ */
/*  Property 25                                                         */
/* ------------------------------------------------------------------ */

test("Property 25: un fallo de Visit no aborta el run y queda registrado", async () => {
  await fc.assert(
    fc.asyncProperty(arbCase, async ({ roles, routeCount, throwFlags }) => {
      const total = roles.length * routeCount;

      // Inventario fijo de Routes UI sin paramSpec ⇒ 1 scenario por Route.
      const inventory: Route[] = Array.from({ length: routeCount }, (_, i) => ({
        id: `r${i}`,
        kind: "ui",
        path: `/route-${i}`,
        section: "metrics",
      }));

      // Registro de invocaciones del crawler y de Visits persistidas.
      const calls: { role: AppRole; scenarioId: string; threw: boolean }[] = [];
      const persisted: VisitResult[] = [];
      let visitIdx = 0;

      // Crawler falso: lanza para el subconjunto arbitrario (orden role-major).
      const createCrawler = (_config: CrawlerConfig): Crawler => ({
        async visit(route, role, scenario) {
          const shouldThrow = throwFlags[visitIdx] ?? false;
          visitIdx += 1;
          calls.push({ role, scenarioId: scenario.scenarioId, threw: shouldThrow });
          if (shouldThrow) {
            throw new Error(`Visit reventada: ${role} ${scenario.scenarioId}`);
          }
          return cleanVisit(_config.runId, route, role, scenario);
        },
        async close() {
          /* noop */
        },
      });

      const deps: OrchestratorDeps = {
        pool: makePoolMock(),
        store: {
          async createRun() {
            /* noop */
          },
          async updateRunTerminal() {
            /* noop */
          },
          async persistVisitResult(visit: VisitResult) {
            // RECORDA cada Visit persistida y confirma la persistencia.
            persisted.push(visit);
            return true;
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
        createCrawler,
        triageDeps: makeTriageDeps(),
        async putScreenshot() {
          return "s3://explorer/screenshot.png";
        },
        async putReportMarkdown() {
          return "s3://explorer/report.md";
        },
        async notifyExplorerRun() {
          return { sent: true } as never;
        },
        async buildRouteInventory() {
          return inventory;
        },
        canMintSessions: () => true,
        async mintSyntheticSession(role: AppRole) {
          return fakeSession(role);
        },
        generateRunId: () => "run-prop25-fixed",
        runDate: "2026-06-20",
        triggerSource: "cron",
        onProgress: () => {
          /* silenciar trazas */
        },
      };

      // ── El run NUNCA rechaza: siempre resuelve con un Report. ──────────────
      const report = await runExploration({ ...RUN_CONFIG_BASE, roles }, deps);
      assert.ok(report && report.run, "runExploration debe resolver con un Report");

      const anyThrew = throwFlags.some((f) => f);
      const threwCount = throwFlags.filter((f) => f).length;

      // El crawler honró exactamente el subconjunto de fallos solicitado.
      assert.equal(calls.length, total, "se intentó cada Visit (role × scenario)");
      assert.equal(
        calls.filter((c) => c.threw).length,
        threwCount,
        "el crawler lanzó exactamente en el subconjunto arbitrario",
      );

      // ── El run NO aborta. ──────────────────────────────────────────────────
      assert.notEqual(report.run.status, "aborted", "el run NO debe abortar");
      assert.ok(
        report.run.status === "completed" || report.run.status === "completed-with-errors",
        `status terminal esperado, recibido "${report.run.status}"`,
      );
      if (anyThrew) {
        assert.equal(
          report.run.status,
          "completed-with-errors",
          "con ≥1 Visit fallida el estado terminal es completed-with-errors",
        );
      } else {
        assert.equal(
          report.run.status,
          "completed",
          "sin fallos el estado terminal es completed",
        );
      }

      // ── Ninguna Visit se descarta: total persistido === roles × scenarios. ──
      assert.equal(
        persisted.length,
        total,
        "se persiste una Visit por cada (role, scenario), incluidas las fallidas",
      );

      // ── Cada Visit que lanzó queda registrada con uncaughtError; las demás no.
      const persistedByKey = new Map<string, VisitResult>();
      for (const v of persisted) {
        persistedByKey.set(`${v.role}|${v.scenarioId}`, v);
      }
      for (const call of calls) {
        const key = `${call.role}|${call.scenarioId}`;
        const v = persistedByKey.get(key);
        assert.ok(v, `existe un Visit_Result persistido para ${key}`);
        // Route y Role conservados.
        assert.equal(v!.role, call.role, "el Role se conserva en la Visit registrada");
        assert.ok(v!.route && typeof v!.route.path === "string", "la Route se conserva");
        if (call.threw) {
          assert.ok(
            typeof v!.uncaughtError === "string" && v!.uncaughtError.length > 0,
            `la Visit fallida ${key} se registra con uncaughtError`,
          );
        } else {
          assert.ok(
            v!.uncaughtError === undefined,
            `la Visit exitosa ${key} no lleva uncaughtError`,
          );
        }
      }
    }),
    { numRuns: 100 },
  );
});
