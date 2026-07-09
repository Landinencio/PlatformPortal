// Feature: ai-portal-explorer, Property 27: El barrido es idempotente sobre un estado idéntico del Portal
/**
 * Property-based test for the Run_Orchestrator.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/orchestrator.ts
 *
 * Property 27: El barrido es idempotente sobre un estado idéntico del Portal.
 *   Para TODO estado fijo del Portal, ejecutar dos veces el Exploration_Run
 *   (`runExploration`) produce el MISMO conjunto de Routes visitadas y el MISMO
 *   conjunto de Anomalies detectadas —comparadas por `scenarioId` + clave de
 *   equivalencia (`route|role|category`)— salvo las marcas temporales y el
 *   identificador del run.
 *
 *   El estado del Portal se modela con dependencias inyectadas (Portal y store
 *   mockeados): un `buildRouteInventory` fijo y un Crawler cuyo `visit` es una
 *   función PURA de `(route, role, scenario)` (perturbada por una semilla
 *   determinista por estado), idéntica entre ambos runs. Solo cambian el
 *   `runId` (run-1 / run-2) y, por diseño, los `anomalyId` (que incrustan el
 *   runId) — por eso la comparación NO usa `anomalyId`/`runId`/timestamps, sino
 *   `scenarioId` + `anomalyEquivalenceKey`.
 *
 * **Validates: Requirements 10.4**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/orchestrator.prop27.property.test.ts
 */

// Polyfill de Web Streams globals (Node 16) ANTES de cargar el AWS SDK que el
// orquestador arrastra vía triage-engine. Los imports de ES se evalúan en
// orden, así que este DEBE ir primero.
import "./web-streams-polyfill";

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { runExploration } from "../orchestrator";
import type { OrchestratorDeps, RunConfig } from "../orchestrator";
import { anomalyEquivalenceKey } from "../anomaly-detectors";
import { DEFAULT_SCENARIO_MATRIX } from "../scenario-generator";
import type { Queryable } from "../report-store";
import type { SyntheticSession } from "../auth-minter";
import type { TriageDeps } from "../triage-engine";
import { defaultParseTriage } from "../triage-engine";
import type { AppRole, PortalSection } from "@/lib/rbac";
import type {
  Anomaly,
  ConsoleError,
  DataSignal,
  FailedRequest,
  Route,
  Scenario,
  TriageResult,
  VisitResult,
} from "../types";

/* ------------------------------------------------------------------ */
/*  Constantes del barrido (compartidas por ambos runs)                 */
/* ------------------------------------------------------------------ */

/** Host del Target_Environment de desarrollo válido (Safety_Guard, Req 1.2). */
const DEV_BASE_URL = "https://portal.today.dev.tooling.dp.iskaypet.com";

/** Roles RBAC cubiertos por el barrido (subconjunto estable). */
const ROLES: AppRole[] = ["admin", "desarrolladores", "externos"];

/** Fecha de ejecución FIJA: ambos runs generan los mismos scenarios. */
const RUN_DATE = "2026-03-28";

/** Umbral de latencia: por encima del cual una Visit es anomalía de rendimiento. */
const LATENCY_THRESHOLD_MS = 3000;

/* ------------------------------------------------------------------ */
/*  Modelo determinista del estado del Portal                           */
/* ------------------------------------------------------------------ */

/** Especificación de una Route generada por fast-check. */
interface RouteSpec {
  kind: "ui" | "api";
  section: PortalSection;
  dateRange: boolean;
  hasFilters: boolean;
}

/** Hash numérico determinista (FNV-1a) de un string. */
function hashNum(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Construye el Route_Inventory (fijo) a partir de las specs generadas. Paths e
 * ids únicos por índice → el mismo inventario para ambos runs.
 */
function buildInventory(specs: RouteSpec[]): Route[] {
  return specs.map((spec, i) => {
    const filters = spec.hasFilters
      ? [{ key: "team", safeValues: ["digital", "retail"] }]
      : undefined;
    const paramSpec =
      spec.dateRange || filters ? { dateRange: spec.dateRange, filters } : undefined;
    return {
      id: `explorer-route-${i}`,
      kind: spec.kind,
      path: `/explorer-route-${i}`,
      section: spec.section,
      paramSpec,
    };
  });
}

/**
 * Crawler simulado: `visit` es una función PURA de `(route, role, scenario)`,
 * perturbada por la `seed` del estado del Portal (idéntica entre runs). El
 * `runId` solo se incrusta en el campo `runId` del Visit_Result (procede del
 * Crawler_Config del run), de modo que dos runs sobre el mismo estado producen
 * Visit_Results idénticos salvo ese `runId`.
 *
 * Varía dataSignal/console/failed/latency de forma determinista para PRODUCIR
 * anomalías (técnicas, rendimiento, empty-state) idénticas entre runs.
 */
function fakeVisit(
  runId: string,
  seed: number,
  route: Route,
  role: AppRole,
  scenario: Scenario,
): VisitResult {
  const h = hashNum(`${seed}|${route.path}|${role}|${scenario.scenarioId}`);

  const consoleErrors: ConsoleError[] = h % 5 === 0 ? [{ message: "TypeError simulado" }] : [];
  const failedRequests: FailedRequest[] =
    h % 7 === 0 ? [{ url: `${route.path}/data`, method: "GET", status: 500 }] : [];
  const isEmpty = h % 3 === 0;

  const hasData = route.kind === "api" || Boolean(route.paramSpec?.dateRange);
  const dataSignal: DataSignal | null = hasData
    ? {
        isEmptyState: isEmpty,
        rowCount: isEmpty ? 0 : (h % 50) + 1,
        timeSeries: null,
        pagination: null,
        totals: {},
      }
    : null;

  return {
    runId,
    scenarioId: scenario.scenarioId,
    route,
    role,
    params: scenario.params,
    httpStatus: 200,
    latencyMs: h % 5000, // a veces > LATENCY_THRESHOLD_MS → anomalía de rendimiento
    timedOut: false,
    consoleErrors,
    failedRequests,
    domErrorStates: [],
    dataSignal,
    screenshotRef: null,
    accessObserved: "granted",
  };
}

/* ------------------------------------------------------------------ */
/*  Grabadora del store mockeado (visits / anomalies / triage)          */
/* ------------------------------------------------------------------ */

interface RunRecord {
  visits: VisitResult[];
  anomalies: Anomaly[];
  triage: TriageResult[];
}

function newRecord(): RunRecord {
  return { visits: [], anomalies: [], triage: [] };
}

/** Pool simulado: solo lo usa el lock de ejecución única. rowCount 1 → adquirido. */
function makeFakePool(): Queryable {
  return {
    async query() {
      return { rows: [], rowCount: 1 };
    },
  };
}

/** Triage determinista: Bedrock simulado devuelve siempre el mismo JSON válido. */
function makeTriageDeps(): TriageDeps {
  return {
    async invokeBedrock() {
      return JSON.stringify({
        severity: "high",
        probable_cause: "causa simulada determinista",
        suggested_fix: "fix simulado determinista",
      });
    },
    parseTriage: defaultParseTriage,
  };
}

/**
 * Construye las dependencias del orquestador para un run concreto. El estado
 * del Portal (inventory + seed) es idéntico entre runs; solo cambia `runId`.
 */
function makeDeps(
  runId: string,
  seed: number,
  inventory: Route[],
  record: RunRecord,
): OrchestratorDeps {
  return {
    pool: makeFakePool(),
    store: {
      async createRun() {
        /* no-op */
      },
      async updateRunTerminal() {
        /* no-op */
      },
      async persistVisitResult(visit: VisitResult) {
        record.visits.push(visit);
        return true;
      },
      async persistAnomaly(anomaly: Anomaly) {
        record.anomalies.push(anomaly);
      },
      async persistTriageResults(_runId: string, results: TriageResult[]) {
        record.triage.push(...results);
      },
      async loadPreviousRunTriage() {
        return null; // baseline consistente: sin run previo comparable
      },
    },
    createCrawler: (crawlerConfig) => ({
      async visit(route, role, scenario) {
        return fakeVisit(crawlerConfig.runId, seed, route, role, scenario);
      },
      async close() {
        /* no-op */
      },
    }),
    triageDeps: makeTriageDeps(),
    async putReportMarkdown() {
      return `s3://explorer-reports/${runId}.md`;
    },
    async notifyExplorerRun() {
      return { sent: false, reason: "no-webhook" as const };
    },
    async buildRouteInventory() {
      return inventory; // mismo inventario fijo en ambos runs
    },
    canMintSessions: () => true,
    async mintSyntheticSession(role: AppRole): Promise<SyntheticSession> {
      return {
        role,
        cookieName: "next-auth.session-token",
        cookieValue: `synthetic-${role}`,
        synthetic: true,
      };
    },
    generateRunId: () => runId,
    runDate: RUN_DATE,
    triggerSource: "cron",
    onProgress: () => {
      /* silencio */
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Claves normalizadas para la comparación entre runs                  */
/* ------------------------------------------------------------------ */

function sortedRoutePaths(record: RunRecord): string[] {
  return [...new Set(record.visits.map((v) => v.route.path))].sort();
}

function sortedScenarioIds(record: RunRecord): string[] {
  return [...new Set(record.visits.map((v) => v.scenarioId))].sort();
}

/**
 * Conjunto de anomalías normalizado por `scenarioId` + clave de equivalencia
 * (`route|role|category`). Ignora `anomalyId` (incrusta el runId), `runId` y
 * cualquier marca temporal.
 */
function sortedAnomalyKeys(record: RunRecord): string[] {
  return [
    ...new Set(record.anomalies.map((a) => `${a.scenarioId}::${anomalyEquivalenceKey(a)}`)),
  ].sort();
}

/* ------------------------------------------------------------------ */
/*  Arbitraries                                                         */
/* ------------------------------------------------------------------ */

const arbSection = fc.constantFrom<PortalSection>(
  "metrics",
  "finops",
  "admin",
  "synthetics",
  "home",
);

const arbRouteSpec: fc.Arbitrary<RouteSpec> = fc.record({
  kind: fc.constantFrom<"ui" | "api">("ui", "api"),
  section: arbSection,
  dateRange: fc.boolean(),
  hasFilters: fc.boolean(),
});

const arbInventorySpec: fc.Arbitrary<RouteSpec[]> = fc.array(arbRouteSpec, {
  minLength: 1,
  maxLength: 5,
});

const arbSeed: fc.Arbitrary<number> = fc.integer({ min: 0, max: 1_000_000 });

/* ------------------------------------------------------------------ */
/*  Property 27                                                         */
/* ------------------------------------------------------------------ */

test("Property 27: el barrido es idempotente sobre un estado idéntico del Portal", async () => {
  const config: RunConfig = {
    baseUrl: DEV_BASE_URL,
    roles: ROLES,
    scenarioMatrix: DEFAULT_SCENARIO_MATRIX,
    detector: { latencyThresholdMs: LATENCY_THRESHOLD_MS, seriesEndToleranceDays: 1 },
    bedrockBudget: 100_000,
    visitTimeoutMs: 30_000,
  };

  await fc.assert(
    fc.asyncProperty(arbInventorySpec, arbSeed, async (specs, seed) => {
      const inventory = buildInventory(specs);

      const rec1 = newRecord();
      const rec2 = newRecord();

      const report1 = await runExploration(config, makeDeps("run-1", seed, inventory, rec1));
      const report2 = await runExploration(config, makeDeps("run-2", seed, inventory, rec2));

      // Sanity: ambos runs terminaron (no abortaron) y con runIds distintos.
      assert.equal(report1.run.runId, "run-1");
      assert.equal(report2.run.runId, "run-2");
      assert.notEqual(report1.run.status, "aborted");
      assert.notEqual(report2.run.status, "aborted");

      // Mismo número de Routes visitadas (summary del Report).
      assert.equal(
        report1.summary.routesVisited,
        report2.summary.routesVisited,
        "summary.routesVisited debe coincidir entre runs",
      );

      // Mismo conjunto de paths de Route visitados.
      assert.deepEqual(
        sortedRoutePaths(rec1),
        sortedRoutePaths(rec2),
        "el conjunto de Routes visitadas debe ser idéntico",
      );

      // Mismo conjunto de scenarioIds visitados.
      assert.deepEqual(
        sortedScenarioIds(rec1),
        sortedScenarioIds(rec2),
        "el conjunto de scenarioIds visitados debe ser idéntico",
      );

      // Mismo conjunto de Anomalies por (scenarioId + clave de equivalencia),
      // ignorando runId, anomalyId crudo y timestamps.
      assert.deepEqual(
        sortedAnomalyKeys(rec1),
        sortedAnomalyKeys(rec2),
        "el conjunto de Anomalies (scenarioId + route|role|category) debe ser idéntico",
      );
    }),
    { numRuns: 100 },
  );
});
