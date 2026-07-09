/**
 * AI Portal Explorer — shared types.
 *
 * Feature: ai-portal-explorer
 *
 * Tipos compartidos por todos los módulos del Explorer (Safety_Guard, Auth_Minter,
 * RBAC_Validator, Route_Discovery, Scenario_Generator, Anomaly_Detectors,
 * Triage_Engine, Regression_Detector, Reporter y Run_Orchestrator).
 *
 * Reutiliza AppRole y PortalSection del RBAC existente del portal.
 *
 * _Requirements: 2.2, 6.2_
 */

import type { AppRole, PortalSection } from "@/lib/rbac";

/** Entorno objetivo, fijado a portal-dev. */
export interface TargetEnvironment {
  baseUrl: string; // https://portal.today.dev.tooling.dp.iskaypet.com
  namespace: "platformportal";
  isDevelopment: true;
}

/** Una Route navegable: UI o endpoint de API. */
export interface Route {
  id: string; // estable: hash de kind+path
  kind: "ui" | "api";
  path: string; // "/metrics", "/api/metrics/team-activity"
  section: PortalSection;
  /** Plantillas de parámetros seguros (query/path) para esta Route. */
  paramSpec?: ParamSpec;
}

/** Especificación de parámetros seguros para una Route. */
export interface ParamSpec {
  dateRange?: boolean; // admite startDate/endDate
  filters?: FilterSpec[]; // team, project, author, accountIds...
}

export interface FilterSpec {
  key: string; // "team" | "accountIds" | "projectIds" | "author"
  safeValues: string[]; // valores de ejemplo seguros (configurables)
}

/** Un Scenario = Route + una combinación concreta de parámetros seguros. */
export interface Scenario {
  scenarioId: string; // estable y determinista (ver buildScenarioId)
  route: Route;
  params: Record<string, string>; // { startDate, endDate, team, accountIds }
  /** Expectativa de datos: ¿este scenario DEBERÍA devolver datos? */
  expectsData: boolean;
  /** Etiqueta semántica del scenario (p.ej. "crosses-90d-boundary"). */
  label?: string;
}

/** Resultado de visitar un Scenario con un Role. */
export interface VisitResult {
  runId: string;
  scenarioId: string;
  route: Route;
  role: AppRole;
  params: Record<string, string>;
  httpStatus: number | null; // status de la respuesta principal
  latencyMs: number;
  timedOut: boolean;
  consoleErrors: ConsoleError[];
  failedRequests: FailedRequest[];
  domErrorStates: DomErrorState[];
  /** Señal de datos extraída del DOM/JSON para heurísticas funcionales. */
  dataSignal: DataSignal | null;
  screenshotRef: string | null; // s3://... o null para rutas API
  accessObserved: "granted" | "denied";
  uncaughtError?: string; // excepción no controlada de la Visit
}

export interface ConsoleError {
  message: string;
}

export interface FailedRequest {
  url: string;
  method: string;
  status: number | null;
}

export interface DomErrorState {
  kind: "error-message" | "blank-page" | "empty-state" | "render-exception";
  detail: string;
}

/**
 * Señal de datos para heurísticas funcionales/semánticas. Extraída de forma
 * best-effort del DOM (cards, tablas, charts) o del JSON de una respuesta API.
 */
export interface DataSignal {
  isEmptyState: boolean; // se ve "No hay datos..." o lista vacía
  rowCount: number | null; // filas de tabla / items de lista
  timeSeries: TimeSeriesSignal | null;
  pagination: PaginationSignal | null;
  totals: Record<string, number>; // KPIs/totales nombrados detectados
}

/** Señal de serie temporal para detectar truncamiento. */
export interface TimeSeriesSignal {
  requestedStart: string; // YYYY-MM-DD (del scenario)
  requestedEnd: string;
  firstDataPoint: string | null; // fecha del primer punto con datos
  lastDataPoint: string | null; // fecha del último punto con datos
  pointCount: number;
}

/** Señal de paginación para detectar estancamiento. */
export interface PaginationSignal {
  pageIndex: number;
  hasNextControl: boolean; // existe un control "siguiente" habilitado
  pageItemSignature: string; // hash de los items de esta página
}

export type AnomalyCategory =
  | "console-error"
  | "failed-request"
  | "dom-error"
  | "performance"
  | "timeout"
  | "rbac"
  | "empty-state"
  | "truncated-series"
  | "stuck-pagination"
  | "incoherent-totals"
  | "suspicious-null";

export interface Anomaly {
  anomalyId: string; // determinista: ver buildAnomalyId
  runId: string;
  route: Route;
  role: AppRole;
  scenarioId: string;
  category: AnomalyCategory;
  detector: "deterministic" | "rbac";
  evidence: AnomalyEvidence;
}

export interface AnomalyEvidence {
  summary: string;
  httpStatus: number | null;
  latencyMs: number | null;
  consoleErrors: string[];
  failedRequests: FailedRequest[];
  domErrorStates: DomErrorState[];
  dataSignal: DataSignal | null;
  screenshotRef: string | null;
  expectedAccess?: "granted" | "denied";
  observedAccess?: "granted" | "denied";
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export type TriageStatus = "triaged" | "triage-unavailable" | "triage-skipped-budget";

/** Salida estructurada del triage de una Anomaly. */
export interface TriageResult {
  id: string; // == anomalyId
  route: string; // route.path
  role: AppRole;
  severity: Severity;
  category: AnomalyCategory;
  probable_cause: string;
  suggested_fix: string;
  evidence: AnomalyEvidence;
  status: TriageStatus;
}

export type RunStatus = "running" | "completed" | "completed-with-errors" | "aborted";

export interface ExplorationRun {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  abortReason: string | null;
  rolesCovered: AppRole[];
  baseUrl: string;
}
