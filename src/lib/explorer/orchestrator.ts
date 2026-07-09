/**
 * AI Portal Explorer — Run_Orchestrator.
 *
 * Feature: ai-portal-explorer
 *
 * Cablea un Exploration_Run completo de extremo a extremo, reutilizando los
 * módulos puros y de I/O del Explorer. Es el único módulo con estado de
 * coordinación; toda la lógica de QA (Safety_Guard, RBAC_Validator,
 * Anomaly_Detectors, Reporter, Regression_Detector) vive en funciones puras que
 * aquí solo se orquestan.
 *
 * Flujo (ver sequenceDiagram del diseño):
 *   1. Validar que `baseUrl` es el Target_Environment de desarrollo (portal-dev);
 *      si no lo es → aborta antes de cualquier Visit y registra el motivo (Req 1.2).
 *   2. `claimRunLock`: claim atómico sobre `explorer_run_lock`; si ya hay un run
 *      en curso → no inicia un segundo run concurrente y registra el rechazo (Req 9.5).
 *   3. Acuñar Synthetic_Sessions por Role (omitir el Role si no se puede, Req 2.5).
 *   4. `createRun` (estado `running`).
 *   5. Descubrir el Route_Inventory y generar los Scenarios por Route.
 *   6. Por cada (Role, Scenario): `Crawler.visit` envuelto en try/catch — un fallo
 *      de Visit registra `uncaughtError` y continúa (Req 10.1); cada Visit se
 *      persiste sin lanzar (Req 10.5).
 *   7. Detectores deterministas por Visit + pares (paginación/totales) + RBAC
 *      observado vs esperado → Anomalies (Req 3.6); se persisten.
 *   8. `triageAll` acotado por el Bedrock_Budget (Req 9.4).
 *   9. `detectRegressions` contra el baseline (`loadPreviousRunTriage`).
 *  10. `buildSummary` + `renderMarkdown` + persistencia (PG + S3) + Teams.
 *  11. Estado terminal `completed` / `completed-with-errors` / `aborted` (Req 10.2),
 *      con trazas de progreso (Routes visitadas / Anomalies) (Req 10.3).
 *
 * Idempotencia/determinismo (Req 10.4): el orden de iteración (roles en el orden
 * de `config.roles`, rutas del inventario, scenarios del generador) es estable y
 * los `scenarioId`/`equivalence_key` son deterministas, de modo que dos runs sobre
 * un estado idéntico del portal producen el mismo conjunto de Routes visitadas y
 * de Anomalies (salvo marcas temporales y `runId`).
 *
 * Inyección de dependencias: TODO el I/O (crawler/Playwright, Bedrock, store,
 * S3, Teams, pool) se inyecta vía `OrchestratorDeps` con defaults de producción,
 * de modo que el orquestador sea unit-testable sin navegador ni AWS (tareas
 * 14.2–14.5).
 *
 * _Requirements: 1.2, 2.5, 9.4, 9.5, 10.1, 10.2, 10.3, 10.4, 10.6_
 */

import { randomUUID } from "node:crypto";

import type { AppRole } from "@/lib/rbac";
import defaultPool from "@/lib/db";

import type { SyntheticSession } from "./auth-minter";
import {
  canMintSessions as defaultCanMintSessions,
  mintSyntheticSession as defaultMintSyntheticSession,
} from "./auth-minter";
import {
  anomalyEquivalenceKey,
  buildAnomalyId,
  detectAnomalies,
  detectIncoherentTotals,
  detectStuckPaginationAnomaly,
} from "./anomaly-detectors";
import type { DetectorConfig } from "./anomaly-detectors";
import type { Crawler, CrawlerConfig, ScreenshotUploader } from "./crawler";
import { createCrawler as defaultCreateCrawler } from "./crawler";
import { detectRegressions } from "./regression-detector";
import type { RegressionReport } from "./regression-detector";
import { buildRouteInventory as defaultBuildRouteInventory } from "./route-discovery";
import { evaluateRbac } from "./rbac-validator";
import type { RbacFinding } from "./rbac-validator";
import { putReportMarkdown as defaultPutReportMarkdown, putScreenshot as defaultPutScreenshot } from "./report-s3";
import {
  createRun as defaultCreateRun,
  loadPreviousRunTriage as defaultLoadPreviousRunTriage,
  persistAnomaly as defaultPersistAnomaly,
  persistTriageResults as defaultPersistTriageResults,
  persistVisitResult as defaultPersistVisitResult,
  updateRunTerminal as defaultUpdateRunTerminal,
} from "./report-store";
import type { Queryable, TriggerSource } from "./report-store";
import { buildSummary, renderMarkdown } from "./reporter";
import type { Report, ReportSummary } from "./reporter";
import { generateScenarios } from "./scenario-generator";
import type { ScenarioMatrix } from "./scenario-generator";
import { isDevTargetEnvironment } from "./safety-guard";
import { notifyExplorerRun as defaultNotifyExplorerRun } from "./teams-notifier";
import type { ExplorerNotifyResult } from "./teams-notifier";
import { defaultTriageDeps, triageAll } from "./triage-engine";
import type { TriageDeps } from "./triage-engine";
import type {
  Anomaly,
  AnomalyEvidence,
  ExplorationRun,
  Route,
  RunStatus,
  Scenario,
  TriageResult,
  VisitResult,
} from "./types";

// ─── Configuración pública ────────────────────────────────────────────────────

/** Configuración de un Exploration_Run. */
export interface RunConfig {
  /** Base URL del Target_Environment. Debe ser portal-dev (Req 1.2). */
  baseUrl: string;
  /** Roles RBAC a cubrir, en orden de barrido. */
  roles: AppRole[];
  /** Matriz de scenarios (rangos de fechas × filtros seguros). */
  scenarioMatrix: ScenarioMatrix;
  /** Configuración de los detectores deterministas. */
  detector: DetectorConfig;
  /** Máximo de invocaciones a Bedrock para el triage (Req 9.4). */
  bedrockBudget: number;
  /** Timeout por-visita (ms) (Req 10.6). */
  visitTimeoutMs: number;
}

/** Traza de progreso de un Exploration_Run (Req 10.3). */
export interface ProgressTrace {
  runId: string;
  phase: "lock" | "session" | "visit" | "detect" | "triage" | "report" | "done" | "abort";
  routesVisited: number;
  anomaliesTotal: number;
  message?: string;
}

/** Funciones de persistencia del Report_Store (inyectables para test). */
export interface ExplorerStore {
  createRun: typeof defaultCreateRun;
  updateRunTerminal: typeof defaultUpdateRunTerminal;
  persistVisitResult: typeof defaultPersistVisitResult;
  persistAnomaly: typeof defaultPersistAnomaly;
  persistTriageResults: typeof defaultPersistTriageResults;
  loadPreviousRunTriage: typeof defaultLoadPreviousRunTriage;
}

/**
 * Dependencias inyectables del Run_Orchestrator. Todas son opcionales: sin
 * overrides se usan los defaults de producción (Playwright, Bedrock, pg, S3,
 * Teams). Los tests (14.2–14.5) sustituyen las que necesitan por mocks.
 */
export interface OrchestratorDeps {
  /** Pool/Queryable para el lock y las funciones de store. Default: pg pool real. */
  pool?: Queryable;
  /** Funciones del Report_Store (subconjunto override). Default: report-store.ts. */
  store?: Partial<ExplorerStore>;
  /** Factory del Crawler (no acopla a Playwright aquí). Default: createCrawler. */
  createCrawler?: (config: CrawlerConfig) => Crawler;
  /** Deps del Triage_Engine (Bedrock). Default: defaultTriageDeps(). */
  triageDeps?: TriageDeps;
  /** Subidor de screenshots que se pasa al Crawler. Default: putScreenshot (S3). */
  putScreenshot?: ScreenshotUploader;
  /** Subidor del Markdown del Report. Default: putReportMarkdown (S3). */
  putReportMarkdown?: (runId: string, markdown: string) => Promise<string>;
  /** Notificador de Teams (best-effort, nunca lanza). Default: notifyExplorerRun. */
  notifyExplorerRun?: (report: Report, reportUrl: string) => Promise<ExplorerNotifyResult>;
  /** Constructor del Route_Inventory. Default: buildRouteInventory. */
  buildRouteInventory?: (baseUrl: string) => Promise<Route[]>;
  /** ¿Se pueden acuñar sesiones? Default: canMintSessions (auth-minter). */
  canMintSessions?: () => boolean;
  /** Acuña una Synthetic_Session para un Role. Default: mintSyntheticSession. */
  mintSyntheticSession?: (role: AppRole) => Promise<SyntheticSession>;
  /** Generador del runId. Default: crypto.randomUUID. */
  generateRunId?: () => string;
  /** Fecha del run (YYYY-MM-DD) para generar scenarios. Default: hoy (UTC). */
  runDate?: string;
  /** Origen del disparo. Default: "cron". */
  triggerSource?: TriggerSource;
  /** Construye la URL del Report para Teams. Default: el ref S3 o un urn del run. */
  buildReportUrl?: (markdownRef: string | null, runId: string) => string;
  /** Sumidero de trazas de progreso (Req 10.3). Default: console.log. */
  onProgress?: (trace: ProgressTrace) => void;
}

/** Dependencias resueltas con todos los defaults aplicados. */
interface ResolvedDeps {
  pool: Queryable;
  store: ExplorerStore;
  createCrawler: (config: CrawlerConfig) => Crawler;
  triageDeps: TriageDeps;
  putScreenshot: ScreenshotUploader;
  putReportMarkdown: (runId: string, markdown: string) => Promise<string>;
  notifyExplorerRun: (report: Report, reportUrl: string) => Promise<ExplorerNotifyResult>;
  buildRouteInventory: (baseUrl: string) => Promise<Route[]>;
  canMintSessions: () => boolean;
  mintSyntheticSession: (role: AppRole) => Promise<SyntheticSession>;
  generateRunId: () => string;
  runDate: string;
  triggerSource: TriggerSource;
  buildReportUrl: (markdownRef: string | null, runId: string) => string;
  onProgress: (trace: ProgressTrace) => void;
}

/** Resuelve `OrchestratorDeps` aplicando los defaults de producción. */
function resolveDeps(deps: OrchestratorDeps = {}): ResolvedDeps {
  const pool = deps.pool ?? defaultPool;
  const store: ExplorerStore = {
    createRun: deps.store?.createRun ?? defaultCreateRun,
    updateRunTerminal: deps.store?.updateRunTerminal ?? defaultUpdateRunTerminal,
    persistVisitResult: deps.store?.persistVisitResult ?? defaultPersistVisitResult,
    persistAnomaly: deps.store?.persistAnomaly ?? defaultPersistAnomaly,
    persistTriageResults: deps.store?.persistTriageResults ?? defaultPersistTriageResults,
    loadPreviousRunTriage: deps.store?.loadPreviousRunTriage ?? defaultLoadPreviousRunTriage,
  };
  return {
    pool,
    store,
    createCrawler: deps.createCrawler ?? defaultCreateCrawler,
    triageDeps: deps.triageDeps ?? defaultTriageDeps(),
    putScreenshot: deps.putScreenshot ?? defaultPutScreenshot,
    putReportMarkdown: deps.putReportMarkdown ?? defaultPutReportMarkdown,
    notifyExplorerRun: deps.notifyExplorerRun ?? defaultNotifyExplorerRun,
    buildRouteInventory: deps.buildRouteInventory ?? defaultBuildRouteInventory,
    canMintSessions: deps.canMintSessions ?? defaultCanMintSessions,
    mintSyntheticSession: deps.mintSyntheticSession ?? defaultMintSyntheticSession,
    generateRunId: deps.generateRunId ?? (() => randomUUID()),
    runDate: deps.runDate ?? new Date().toISOString().slice(0, 10),
    triggerSource: deps.triggerSource ?? "cron",
    buildReportUrl:
      deps.buildReportUrl ?? ((markdownRef, runId) => markdownRef ?? `explorer-run:${runId}`),
    onProgress: deps.onProgress ?? ((trace) => console.log("[explorer/orchestrator]", JSON.stringify(trace))),
  };
}

// ─── Lock de ejecución única (Req 9.5) ──────────────────────────────────────────

/**
 * Reclama el lock de ejecución única mediante un UPDATE atómico sobre la fila
 * singleton de `explorer_run_lock`. Si ya hay un run en curso (`active_run_id`
 * no nulo) el UPDATE afecta 0 filas y el claim falla. (Req 9.5)
 *
 * Genera el `runId` del intento (lo devuelve siempre, haya o no adquirido el
 * lock, para poder registrar el rechazo del inicio duplicado).
 */
export async function claimRunLock(
  deps: OrchestratorDeps,
): Promise<{ acquired: boolean; runId: string }> {
  const pool = deps.pool ?? defaultPool;
  const generateRunId = deps.generateRunId ?? (() => randomUUID());
  const runId = generateRunId();

  // Garantiza la existencia de la fila singleton (idempotente).
  await pool.query(
    `INSERT INTO explorer_run_lock (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
  );

  const res = await pool.query(
    `UPDATE explorer_run_lock
        SET active_run_id = $1, acquired_at = NOW()
      WHERE id = 1 AND active_run_id IS NULL`,
    [runId],
  );

  return { acquired: (res.rowCount ?? 0) > 0, runId };
}

/** Libera el lock si lo mantiene el `runId` dado. Best-effort: no lanza. */
async function releaseRunLock(pool: Queryable, runId: string): Promise<void> {
  try {
    await pool.query(
      `UPDATE explorer_run_lock
          SET active_run_id = NULL, acquired_at = NULL
        WHERE id = 1 AND active_run_id = $1`,
      [runId],
    );
  } catch (err) {
    console.error(
      `[explorer/orchestrator] releaseRunLock failed for run=${runId}:`,
      (err as Error).message,
    );
  }
}

// ─── Helpers de construcción ────────────────────────────────────────────────────

/** Construye el objeto de dominio ExplorationRun para el Report. */
function buildExplorationRun(params: {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  abortReason: string | null;
  rolesCovered: AppRole[];
  baseUrl: string;
}): ExplorationRun {
  return { ...params };
}

/** Construye el artefacto Report a partir de sus piezas. */
function makeReport(
  run: ExplorationRun,
  triageResults: TriageResult[],
  regressions: RegressionReport,
  summary: ReportSummary,
): Report {
  return { run, triageResults, regressions, summary };
}

/**
 * Sintetiza un Visit_Result cuando `Crawler.visit` lanza una excepción no
 * controlada, para registrar el fallo asociado a la Route y Role y continuar
 * (Req 10.1). El `uncaughtError` marca el run como completado-con-errores.
 */
function buildFailedVisit(
  runId: string,
  route: Route,
  role: AppRole,
  scenario: Scenario,
  error: unknown,
): VisitResult {
  return {
    runId,
    scenarioId: scenario.scenarioId,
    route,
    role,
    params: scenario.params,
    httpStatus: null,
    latencyMs: 0,
    timedOut: false,
    consoleErrors: [],
    failedRequests: [],
    domErrorStates: [],
    dataSignal: null,
    screenshotRef: null,
    accessObserved: "granted",
    uncaughtError: String((error as Error)?.message ?? error).slice(0, 500),
  };
}

/** Convierte un RbacFinding en una Anomaly de categoría `rbac` (Req 3.6). */
function rbacFindingToAnomaly(
  finding: RbacFinding,
  visit: VisitResult,
  runId: string,
): Anomaly {
  const summary =
    finding.kind === "unauthorized-access"
      ? `Acceso no autorizado: el rol "${finding.role}" accedió a ${finding.route.path} (sección ${finding.route.section}) donde se esperaba denegación.`
      : `Bloqueo indebido: el rol "${finding.role}" fue bloqueado en ${finding.route.path} (sección ${finding.route.section}) donde se esperaba acceso.`;

  const evidence: AnomalyEvidence = {
    summary,
    httpStatus: visit.httpStatus,
    latencyMs: visit.latencyMs,
    consoleErrors: visit.consoleErrors.map((e) => e.message),
    failedRequests: visit.failedRequests,
    domErrorStates: visit.domErrorStates,
    dataSignal: visit.dataSignal,
    screenshotRef: visit.screenshotRef,
    expectedAccess: finding.expected,
    observedAccess: finding.observed,
  };

  return {
    anomalyId: buildAnomalyId(runId, finding.route, finding.role, "rbac", visit.scenarioId),
    runId,
    route: finding.route,
    role: finding.role,
    scenarioId: visit.scenarioId,
    category: "rbac",
    detector: "rbac",
    evidence,
  };
}

// ─── Orquestación principal ─────────────────────────────────────────────────────

/**
 * Ejecuta un Exploration_Run completo. Idempotente, no concurrente, con
 * degradación elegante. Siempre devuelve un Report (incluso al abortar).
 *
 * _Requirements: 1.2, 2.5, 9.4, 9.5, 10.1, 10.2, 10.3, 10.4, 10.6_
 */
export async function runExploration(
  config: RunConfig,
  deps: OrchestratorDeps = {},
): Promise<Report> {
  const d = resolveDeps(deps);
  const startedAt = new Date().toISOString();

  // ── 1. Validar entorno: SOLO portal-dev (Req 1.2) ────────────────────────────
  if (!isDevTargetEnvironment(config.baseUrl)) {
    const runId = d.generateRunId();
    const reason = `baseUrl "${config.baseUrl}" no es el Target_Environment de desarrollo (portal-dev); run abortado antes de cualquier Visit.`;
    await safeCreateRun(d, { runId, baseUrl: config.baseUrl, rolesCovered: [], triggerSource: d.triggerSource });
    await safeUpdateTerminal(d, {
      runId,
      status: "aborted",
      abortReason: reason,
      routesVisited: 0,
      anomaliesTotal: 0,
      bedrockCalls: 0,
    });
    d.onProgress({ runId, phase: "abort", routesVisited: 0, anomaliesTotal: 0, message: reason });
    return makeReport(
      buildExplorationRun({
        runId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "aborted",
        abortReason: reason,
        rolesCovered: [],
        baseUrl: config.baseUrl,
      }),
      [],
      { hasBaseline: false, regressions: [] },
      buildSummary([], []),
    );
  }

  // ── 2. Claim del lock de ejecución única (Req 9.5) ───────────────────────────
  const lock = await claimRunLock(deps);
  if (!lock.acquired) {
    const reason = "Ya hay un Exploration_Run en curso: se rechaza el inicio duplicado (no concurrente).";
    // Registramos el rechazo del inicio duplicado SIN tomar el lock ajeno.
    await safeCreateRun(d, {
      runId: lock.runId,
      baseUrl: config.baseUrl,
      rolesCovered: [],
      triggerSource: d.triggerSource,
    });
    await safeUpdateTerminal(d, {
      runId: lock.runId,
      status: "aborted",
      abortReason: reason,
      routesVisited: 0,
      anomaliesTotal: 0,
      bedrockCalls: 0,
    });
    d.onProgress({ runId: lock.runId, phase: "abort", routesVisited: 0, anomaliesTotal: 0, message: reason });
    return makeReport(
      buildExplorationRun({
        runId: lock.runId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "aborted",
        abortReason: reason,
        rolesCovered: [],
        baseUrl: config.baseUrl,
      }),
      [],
      { hasBaseline: false, regressions: [] },
      buildSummary([], []),
    );
  }

  const runId = lock.runId;
  let crawler: Crawler | null = null;
  let anyError = false; // marca completed-with-errors (Req 10.2)

  try {
    // ── 3. Acuñar Synthetic_Sessions por Role (Req 2.5) ────────────────────────
    const sessions = new Map<AppRole, SyntheticSession>();
    const canMint = d.canMintSessions();
    for (const role of config.roles) {
      if (!canMint) {
        d.onProgress({
          runId,
          phase: "session",
          routesVisited: 0,
          anomaliesTotal: 0,
          message: `Rol "${role}" omitido: no se pueden acuñar sesiones (falta NEXTAUTH_SECRET).`,
        });
        continue;
      }
      try {
        sessions.set(role, await d.mintSyntheticSession(role));
      } catch (err) {
        d.onProgress({
          runId,
          phase: "session",
          routesVisited: 0,
          anomaliesTotal: 0,
          message: `Rol "${role}" omitido: fallo al acuñar la sesión (${String((err as Error)?.message ?? err)}).`,
        });
      }
    }
    const rolesCovered = config.roles.filter((role) => sessions.has(role));

    // ── 4. createRun (estado running) ──────────────────────────────────────────
    await safeCreateRun(d, {
      runId,
      baseUrl: config.baseUrl,
      rolesCovered,
      triggerSource: d.triggerSource,
    });

    // ── 5. Route_Inventory + Scenarios ─────────────────────────────────────────
    const inventory = await d.buildRouteInventory(config.baseUrl);
    const scenariosByRoute: { route: Route; scenarios: Scenario[] }[] = inventory.map((route) => ({
      route,
      scenarios: generateScenarios(route, config.scenarioMatrix, d.runDate),
    }));

    // ── 6. Visitas (captura por-visita de excepciones, Req 10.1) ───────────────
    crawler = d.createCrawler({
      baseUrl: config.baseUrl,
      runId,
      visitTimeoutMs: config.visitTimeoutMs,
      screenshotUploader: d.putScreenshot,
    });

    const visits: VisitResult[] = [];
    const visitScenario = new Map<VisitResult, Scenario>();
    const visitedRoutePaths = new Set<string>();
    // Anomalies dedupeadas por anomalyId, en orden de inserción determinista.
    const anomalies = new Map<string, Anomaly>();

    const addAnomaly = (anomaly: Anomaly): void => {
      if (!anomalies.has(anomaly.anomalyId)) {
        anomalies.set(anomaly.anomalyId, anomaly);
      }
    };

    for (const role of rolesCovered) {
      const session = sessions.get(role)!;
      for (const { route, scenarios } of scenariosByRoute) {
        for (const scenario of scenarios) {
          let visit: VisitResult;
          try {
            visit = await crawler.visit(route, role, scenario, session);
          } catch (err) {
            // Req 10.1: un fallo de Visit no aborta el run; se registra y continúa.
            visit = buildFailedVisit(runId, route, role, scenario, err);
            anyError = true;
          }

          // Persistencia por-visita sin lanzar (Req 10.5).
          const persisted = await d.store.persistVisitResult(visit, d.pool);
          if (!persisted) {
            anyError = true;
          }

          visits.push(visit);
          visitScenario.set(visit, scenario);
          visitedRoutePaths.add(route.path);

          // ── 7a. Detectores deterministas de Visit única ──────────────────────
          if (!visit.uncaughtError) {
            for (const anomaly of detectAnomalies(visit, scenario, config.detector)) {
              addAnomaly(anomaly);
            }
          }

          d.onProgress({
            runId,
            phase: "visit",
            routesVisited: visitedRoutePaths.size,
            anomaliesTotal: anomalies.size,
            message: `Visit ${route.path} [${role}] (${scenario.scenarioId})`,
          });
        }
      }
    }

    // ── 7b. Detectores por pares (paginación / totales) por (route, role) ──────
    const byRouteRole = new Map<string, VisitResult[]>();
    for (const visit of visits) {
      if (visit.uncaughtError) continue;
      const key = `${visit.route.id}|${visit.role}`;
      const group = byRouteRole.get(key);
      if (group) group.push(visit);
      else byRouteRole.set(key, [visit]);
    }
    for (const group of byRouteRole.values()) {
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const incoherent = detectIncoherentTotals(group[i], group[j]);
          if (incoherent) addAnomaly(incoherent);
        }
        if (i + 1 < group.length) {
          const stuck = detectStuckPaginationAnomaly(group[i], group[i + 1]);
          if (stuck) addAnomaly(stuck);
        }
      }
    }

    // ── 7c. RBAC observado vs esperado (Req 3.6) ───────────────────────────────
    // Una evaluación por (route, role) usando una Visit representativa (no fallida).
    const rbacSeen = new Set<string>();
    for (const visit of visits) {
      if (visit.uncaughtError) continue;
      const key = `${visit.route.id}|${visit.role}`;
      if (rbacSeen.has(key)) continue;
      rbacSeen.add(key);
      const finding = evaluateRbac(visit.route, visit.role, visit.accessObserved);
      if (finding) {
        addAnomaly(rbacFindingToAnomaly(finding, visit, runId));
      }
    }

    const anomalyList = [...anomalies.values()];

    // Persistir Anomalies (defensivo: un fallo de persistencia no aborta el run).
    for (const anomaly of anomalyList) {
      try {
        await d.store.persistAnomaly(anomaly, d.pool);
      } catch (err) {
        anyError = true;
        console.error(
          `[explorer/orchestrator] persistAnomaly failed for ${anomaly.anomalyId}:`,
          (err as Error).message,
        );
      }
    }

    d.onProgress({
      runId,
      phase: "detect",
      routesVisited: visitedRoutePaths.size,
      anomaliesTotal: anomalyList.length,
      message: `Detección completada: ${anomalyList.length} anomalía(s).`,
    });

    // ── 8. Triage acotado por Bedrock_Budget (Req 9.4) ─────────────────────────
    const triageResults = await triageAll(anomalyList, config.bedrockBudget, d.triageDeps);
    const safeBudget =
      Number.isFinite(config.bedrockBudget) && config.bedrockBudget > 0
        ? Math.floor(config.bedrockBudget)
        : 0;
    const bedrockCalls = Math.min(anomalyList.length, safeBudget);

    d.onProgress({
      runId,
      phase: "triage",
      routesVisited: visitedRoutePaths.size,
      anomaliesTotal: anomalyList.length,
      message: `Triage completado (${bedrockCalls} invocación(es) a Bedrock).`,
    });

    // ── 9. Regresiones vs baseline ─────────────────────────────────────────────
    let previous: TriageResult[] | null = null;
    try {
      previous = await d.store.loadPreviousRunTriage(runId, d.pool);
    } catch (err) {
      anyError = true;
      console.error(
        `[explorer/orchestrator] loadPreviousRunTriage failed:`,
        (err as Error).message,
      );
    }
    const regressions = detectRegressions(triageResults, previous);
    const regressionIds = new Set(regressions.regressions.map((r) => r.id));

    // ── 10. Resumen + Markdown + persistencia + Teams ──────────────────────────
    const summary = buildSummary(visits, triageResults);
    const finishedAt = new Date().toISOString();
    const status: RunStatus = anyError ? "completed-with-errors" : "completed";

    const run = buildExplorationRun({
      runId,
      startedAt,
      finishedAt,
      status,
      abortReason: null,
      rolesCovered,
      baseUrl: config.baseUrl,
    });
    const report = makeReport(run, triageResults, regressions, summary);

    // Markdown del Report → S3 (best-effort).
    const markdown = renderMarkdown(report);
    let reportMarkdownRef: string | null = null;
    try {
      reportMarkdownRef = await d.putReportMarkdown(runId, markdown);
    } catch (err) {
      anyError = true;
      console.error(
        `[explorer/orchestrator] putReportMarkdown failed:`,
        (err as Error).message,
      );
    }

    // Persistir Triage_Results (marca regresiones, Req 8.1/8.2).
    try {
      await d.store.persistTriageResults(runId, triageResults, regressionIds, d.pool);
    } catch (err) {
      anyError = true;
      console.error(
        `[explorer/orchestrator] persistTriageResults failed:`,
        (err as Error).message,
      );
    }

    // Recalcular estado terminal si la persistencia del Report introdujo errores.
    const terminalStatus: RunStatus = anyError ? "completed-with-errors" : "completed";
    run.status = terminalStatus;

    await safeUpdateTerminal(d, {
      runId,
      status: terminalStatus as Exclude<RunStatus, "running">,
      abortReason: null,
      routesVisited: summary.routesVisited,
      anomaliesTotal: anomalyList.length,
      bedrockCalls,
      reportMarkdownRef,
      summary,
    });

    // Teams (best-effort, nunca lanza, Req 7.6).
    const reportUrl = d.buildReportUrl(reportMarkdownRef, runId);
    await d.notifyExplorerRun(report, reportUrl);

    d.onProgress({
      runId,
      phase: "done",
      routesVisited: summary.routesVisited,
      anomaliesTotal: anomalyList.length,
      message: `Run finalizado con estado ${terminalStatus}.`,
    });

    return report;
  } finally {
    // Cierre del navegador y liberación del lock SIEMPRE.
    if (crawler) {
      try {
        await crawler.close();
      } catch {
        /* noop */
      }
    }
    await releaseRunLock(d.pool, runId);
  }
}

// ─── Envoltorios de persistencia defensivos ─────────────────────────────────────

/** `createRun` que no aborta el run ante un fallo de persistencia. */
async function safeCreateRun(
  d: ResolvedDeps,
  input: { runId: string; baseUrl: string; rolesCovered: AppRole[]; triggerSource: TriggerSource },
): Promise<void> {
  try {
    await d.store.createRun(input, d.pool);
  } catch (err) {
    console.error(
      `[explorer/orchestrator] createRun failed for run=${input.runId}:`,
      (err as Error).message,
    );
  }
}

/** `updateRunTerminal` que no lanza (la persistencia del cierre es best-effort). */
async function safeUpdateTerminal(
  d: ResolvedDeps,
  input: {
    runId: string;
    status: Exclude<RunStatus, "running">;
    abortReason?: string | null;
    routesVisited: number;
    anomaliesTotal: number;
    bedrockCalls: number;
    reportMarkdownRef?: string | null;
    summary?: ReportSummary | null;
  },
): Promise<void> {
  try {
    await d.store.updateRunTerminal(input, d.pool);
  } catch (err) {
    console.error(
      `[explorer/orchestrator] updateRunTerminal failed for run=${input.runId}:`,
      (err as Error).message,
    );
  }
}
