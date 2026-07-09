/**
 * AI Portal Explorer — Report_Store (PostgreSQL persistence layer).
 *
 * Feature: ai-portal-explorer
 *
 * Capa de persistencia del histórico de Exploration_Runs y su evidencia. Las
 * capturas y el Markdown completo del Report viven en S3; aquí se guardan los
 * metadatos del run, los Visit_Results, las Anomalies, los Triage_Results y las
 * referencias S3. El histórico NUNCA se borra (Req 7.7): cada run es una fila
 * nueva en `exploration_runs` que se conserva para comparar ejecuciones.
 *
 * Tablas (migración `migrations/2026-06-20_ai_portal_explorer.sql`):
 *   exploration_runs · visit_results · anomalies · triage_results
 *
 * Reglas de diseño:
 *  - Todas las queries son parametrizadas ($1, $2…); JAMÁS interpolación de
 *    strings. Las columnas JSONB se serializan con `JSON.stringify` + cast
 *    `::jsonb` (patrón del resto del repo, p.ej. `iskay-memory.ts`).
 *  - `persistVisitResult` NO lanza: ante un fallo por-fila lo registra y
 *    continúa, sin descartar los Visit_Results ya persistidos (Req 10.5).
 *  - Idempotencia: las escrituras usan `ON CONFLICT` sobre las claves naturales
 *    (un run repetido sobre el mismo estado reescribe en lugar de duplicar).
 *  - Inyección de dependencias: cada función acepta un `Queryable` opcional
 *    (por defecto el `pool` real) para poder testear con un pool simulado.
 *
 * _Requirements: 7.1, 7.7, 10.2, 10.5_
 */

import type { AppRole } from "@/lib/rbac";
import pool from "@/lib/db";

import { anomalyEquivalenceKey } from "./anomaly-detectors";
import type { ReportSummary } from "./reporter";
import type {
  Anomaly,
  ExplorationRun,
  RunStatus,
  TriageResult,
  VisitResult,
} from "./types";

/**
 * Superficie mínima de `pg.Pool` que necesita este módulo. Permite inyectar un
 * pool simulado en los tests (tarea 12.4) sin acoplar a la conexión real.
 */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Origen del disparo de un Exploration_Run. */
export type TriggerSource = "cron" | "on-demand";

/** Datos para crear un Exploration_Run (estado inicial `running`). */
export interface CreateRunInput {
  runId: string;
  baseUrl: string;
  rolesCovered: AppRole[];
  triggerSource?: TriggerSource;
}

/** Datos para cerrar un Exploration_Run con su estado terminal y contadores. */
export interface UpdateRunTerminalInput {
  runId: string;
  status: Exclude<RunStatus, "running">;
  abortReason?: string | null;
  routesVisited: number;
  anomaliesTotal: number;
  bedrockCalls: number;
  reportMarkdownRef?: string | null;
  summary?: ReportSummary | null;
}

/**
 * Inserta la fila de un Exploration_Run en estado `running` (Req 7.1). El
 * histórico se conserva: cada run es una fila distinta identificada por
 * `runId`. Idempotente ante reintentos del mismo run vía `ON CONFLICT`.
 */
export async function createRun(
  input: CreateRunInput,
  db: Queryable = pool,
): Promise<void> {
  const { runId, baseUrl, rolesCovered, triggerSource = "cron" } = input;
  await db.query(
    `INSERT INTO exploration_runs (run_id, status, base_url, roles_covered, trigger_source)
     VALUES ($1, 'running', $2, $3::jsonb, $4)
     ON CONFLICT (run_id) DO UPDATE
       SET status = 'running',
           base_url = EXCLUDED.base_url,
           roles_covered = EXCLUDED.roles_covered,
           trigger_source = EXCLUDED.trigger_source`,
    [runId, baseUrl, JSON.stringify(rolesCovered ?? []), triggerSource],
  );
}

/**
 * Cierra un Exploration_Run: fija `finished_at = NOW()`, el estado terminal
 * (`completed` | `completed-with-errors` | `aborted`), el motivo de aborto, los
 * contadores y la referencia al Markdown + el resumen estructurado (Req 7.1,
 * 10.2). El histórico se conserva (no se borra ninguna fila previa).
 */
export async function updateRunTerminal(
  input: UpdateRunTerminalInput,
  db: Queryable = pool,
): Promise<void> {
  const {
    runId,
    status,
    abortReason = null,
    routesVisited,
    anomaliesTotal,
    bedrockCalls,
    reportMarkdownRef = null,
    summary = null,
  } = input;

  await db.query(
    `UPDATE exploration_runs
        SET finished_at = NOW(),
            status = $2,
            abort_reason = $3,
            routes_visited = $4,
            anomalies_total = $5,
            bedrock_calls = $6,
            report_markdown_ref = $7,
            summary = $8::jsonb
      WHERE run_id = $1`,
    [
      runId,
      status,
      abortReason,
      routesVisited,
      anomaliesTotal,
      bedrockCalls,
      reportMarkdownRef,
      summary === null ? null : JSON.stringify(summary),
    ],
  );
}

/**
 * Persiste un Visit_Result de forma idempotente (una Visit por run+scenario+role,
 * Req 4.4). **No lanza**: ante un fallo por-fila lo registra y devuelve `false`,
 * para que el barrido continúe sin descartar lo ya persistido (Req 10.5).
 *
 * @returns `true` si la fila se persistió, `false` si falló (ya registrado).
 */
export async function persistVisitResult(
  visit: VisitResult,
  db: Queryable = pool,
): Promise<boolean> {
  try {
    await db.query(
      `INSERT INTO visit_results (
         run_id, scenario_id, route_path, route_kind, section, role, params,
         http_status, latency_ms, timed_out, access_observed,
         console_errors, failed_requests, dom_error_states, data_signal,
         screenshot_ref, uncaught_error
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7::jsonb,
         $8, $9, $10, $11,
         $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb,
         $16, $17
       )
       ON CONFLICT (run_id, scenario_id, role) DO UPDATE
         SET route_path = EXCLUDED.route_path,
             route_kind = EXCLUDED.route_kind,
             section = EXCLUDED.section,
             params = EXCLUDED.params,
             http_status = EXCLUDED.http_status,
             latency_ms = EXCLUDED.latency_ms,
             timed_out = EXCLUDED.timed_out,
             access_observed = EXCLUDED.access_observed,
             console_errors = EXCLUDED.console_errors,
             failed_requests = EXCLUDED.failed_requests,
             dom_error_states = EXCLUDED.dom_error_states,
             data_signal = EXCLUDED.data_signal,
             screenshot_ref = EXCLUDED.screenshot_ref,
             uncaught_error = EXCLUDED.uncaught_error`,
      [
        visit.runId,
        visit.scenarioId,
        visit.route.path,
        visit.route.kind,
        visit.route.section,
        visit.role,
        JSON.stringify(visit.params ?? {}),
        visit.httpStatus,
        visit.latencyMs,
        visit.timedOut,
        visit.accessObserved,
        JSON.stringify(visit.consoleErrors ?? []),
        JSON.stringify(visit.failedRequests ?? []),
        JSON.stringify(visit.domErrorStates ?? []),
        visit.dataSignal === null || visit.dataSignal === undefined
          ? null
          : JSON.stringify(visit.dataSignal),
        visit.screenshotRef,
        visit.uncaughtError ?? null,
      ],
    );
    return true;
  } catch (err) {
    // Req 10.5: registrar el fallo de persistencia y continuar el run.
    console.error(
      `[explorer/report-store] persistVisitResult failed for run=${visit.runId} scenario=${visit.scenarioId} role=${visit.role}:`,
      (err as Error).message,
    );
    return false;
  }
}

/**
 * Persiste (upsert) una Anomaly con su clave de equivalencia route+role+category
 * (Req 8.4). Idempotente por `(run_id, anomaly_id)`.
 */
export async function persistAnomaly(
  anomaly: Anomaly,
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `INSERT INTO anomalies (
       anomaly_id, run_id, scenario_id, route_path, role,
       category, detector, equivalence_key, evidence
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (run_id, anomaly_id) DO UPDATE
       SET scenario_id = EXCLUDED.scenario_id,
           route_path = EXCLUDED.route_path,
           role = EXCLUDED.role,
           category = EXCLUDED.category,
           detector = EXCLUDED.detector,
           equivalence_key = EXCLUDED.equivalence_key,
           evidence = EXCLUDED.evidence`,
    [
      anomaly.anomalyId,
      anomaly.runId,
      anomaly.scenarioId,
      anomaly.route.path,
      anomaly.role,
      anomaly.category,
      anomaly.detector,
      anomalyEquivalenceKey(anomaly),
      JSON.stringify(anomaly.evidence),
    ],
  );
}

/**
 * Persiste (upsert) los Triage_Results de un run, fijando `is_regression` y la
 * `equivalence_key` (Req 8.1, 8.2, 8.4). Idempotente por `(run_id, id)`.
 *
 * @param runId         Exploration_Run al que pertenecen los triages.
 * @param results       Triage_Results a persistir.
 * @param regressionIds Conjunto de ids de Triage_Results marcados como regresión
 *                      (típicamente `new Set(regressionReport.regressions.map(r => r.id))`).
 */
export async function persistTriageResults(
  runId: string,
  results: TriageResult[],
  regressionIds: Set<string> = new Set(),
  db: Queryable = pool,
): Promise<void> {
  for (const result of results) {
    await db.query(
      `INSERT INTO triage_results (
         id, run_id, route_path, role, severity, category,
         probable_cause, suggested_fix, evidence, status,
         is_regression, equivalence_key
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
       ON CONFLICT (run_id, id) DO UPDATE
         SET route_path = EXCLUDED.route_path,
             role = EXCLUDED.role,
             severity = EXCLUDED.severity,
             category = EXCLUDED.category,
             probable_cause = EXCLUDED.probable_cause,
             suggested_fix = EXCLUDED.suggested_fix,
             evidence = EXCLUDED.evidence,
             status = EXCLUDED.status,
             is_regression = EXCLUDED.is_regression,
             equivalence_key = EXCLUDED.equivalence_key`,
      [
        result.id,
        runId,
        result.route,
        result.role,
        result.severity,
        result.category,
        result.probable_cause,
        result.suggested_fix,
        JSON.stringify(result.evidence),
        result.status,
        regressionIds.has(result.id),
        anomalyEquivalenceKey(result),
      ],
    );
  }
}

/** Fila cruda de `triage_results` tal y como la devuelve PostgreSQL. */
interface TriageRow {
  id: string;
  route_path: string;
  role: AppRole;
  severity: TriageResult["severity"];
  category: TriageResult["category"];
  probable_cause: string;
  suggested_fix: string;
  evidence: TriageResult["evidence"];
  status: TriageResult["status"];
}

/** Reconstruye un TriageResult de dominio a partir de su fila persistida. */
function rowToTriageResult(row: TriageRow): TriageResult {
  return {
    id: row.id,
    route: row.route_path,
    role: row.role,
    severity: row.severity,
    category: row.category,
    probable_cause: row.probable_cause,
    suggested_fix: row.suggested_fix,
    evidence: row.evidence,
    status: row.status,
  };
}

/**
 * Carga los Triage_Results del run previo comparable, que sirve de baseline para
 * la detección de regresiones (Req 8.2). El baseline es el Exploration_Run
 * terminal más reciente (`completed` | `completed-with-errors`) distinto del run
 * actual; los runs `aborted` o `running` no son comparables y se ignoran.
 *
 * @returns Los Triage_Results del baseline, o `null` si no existe ningún run
 *          previo comparable (en cuyo caso no se puede clasificar regresión, Req 8.3).
 */
export async function loadPreviousRunTriage(
  currentRunId: string,
  db: Queryable = pool,
): Promise<TriageResult[] | null> {
  const prev = await db.query<{ run_id: string }>(
    `SELECT run_id
       FROM exploration_runs
      WHERE run_id <> $1
        AND status IN ('completed', 'completed-with-errors')
      ORDER BY started_at DESC
      LIMIT 1`,
    [currentRunId],
  );

  if (prev.rows.length === 0) {
    return null;
  }

  const baselineRunId = prev.rows[0].run_id;

  const { rows } = await db.query<TriageRow>(
    `SELECT id, route_path, role, severity, category,
            probable_cause, suggested_fix, evidence, status
       FROM triage_results
      WHERE run_id = $1`,
    [baselineRunId],
  );

  return rows.map(rowToTriageResult);
}

/** Fila cruda de `exploration_runs` tal y como la devuelve PostgreSQL. */
interface ExplorationRunRow {
  run_id: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  status: RunStatus;
  abort_reason: string | null;
  roles_covered: AppRole[];
  base_url: string;
}

/** Normaliza un timestamp de PostgreSQL a ISO-8601 string. */
function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Carga un Exploration_Run por su identificador y lo mapea al tipo de dominio.
 *
 * @returns El ExplorationRun, o `null` si no existe.
 */
export async function loadRun(
  runId: string,
  db: Queryable = pool,
): Promise<ExplorationRun | null> {
  const { rows } = await db.query<ExplorationRunRow>(
    `SELECT run_id, started_at, finished_at, status, abort_reason,
            roles_covered, base_url
       FROM exploration_runs
      WHERE run_id = $1`,
    [runId],
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  return {
    runId: row.run_id,
    startedAt: toIso(row.started_at) ?? "",
    finishedAt: toIso(row.finished_at),
    status: row.status,
    abortReason: row.abort_reason,
    rolesCovered: row.roles_covered ?? [],
    baseUrl: row.base_url,
  };
}
