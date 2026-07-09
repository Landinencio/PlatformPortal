import pool from "@/lib/db";
import type { FinOpsAdvisorRunInput, FinOpsAdvisorRunResult, FinOpsAdvisorStage } from "@/lib/finops-advisor-runner";

export type FinOpsAdvisorJobStatus = "queued" | "running" | "completed" | "failed";

interface JobRow {
  job_id: string;
  requested_by_email: string;
  requested_by_name: string | null;
  status: FinOpsAdvisorJobStatus;
  stage: FinOpsAdvisorStage;
  stage_message: string | null;
  progress_pct: number;
  request_payload: FinOpsAdvisorRunInput;
  result_json: FinOpsAdvisorRunResult | null;
  error_message: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

type PgError = Error & { code?: string };

export interface FinOpsAdvisorJob {
  jobId: string;
  requestedByEmail: string;
  requestedByName: string | null;
  status: FinOpsAdvisorJobStatus;
  stage: FinOpsAdvisorStage;
  stageMessage: string | null;
  progressPct: number;
  requestPayload: FinOpsAdvisorRunInput;
  result: FinOpsAdvisorRunResult | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface FinOpsAdvisorJobListItem {
  jobId: string;
  requestedByEmail: string;
  requestedByName: string | null;
  status: FinOpsAdvisorJobStatus;
  stage: FinOpsAdvisorStage;
  stageMessage: string | null;
  progressPct: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  errorMessage: string | null;
  resultMeta: {
    model: string | null;
    provider: string | null;
    metricsCollected: number | null;
    costsIncluded: boolean | null;
    costWindow: { startDate: string; endDate: string } | null;
    timestamp: string | null;
  };
}

interface JobListRow {
  job_id: string;
  requested_by_email: string;
  requested_by_name: string | null;
  status: FinOpsAdvisorJobStatus;
  stage: FinOpsAdvisorStage;
  stage_message: string | null;
  progress_pct: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
  error_message: string | null;
  model: string | null;
  provider: string | null;
  metrics_collected: string | null;
  costs_included: string | null;
  cost_window: { startDate: string; endDate: string } | null;
  result_timestamp: string | null;
}

function mapRow(row: JobRow): FinOpsAdvisorJob {
  return {
    jobId: row.job_id,
    requestedByEmail: row.requested_by_email,
    requestedByName: row.requested_by_name,
    status: row.status,
    stage: row.stage,
    stageMessage: row.stage_message,
    progressPct: row.progress_pct,
    requestPayload: row.request_payload,
    result: row.result_json,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapListRow(row: JobListRow): FinOpsAdvisorJobListItem {
  const metricsCollected = row.metrics_collected !== null ? Number(row.metrics_collected) : null;
  const costsIncluded = row.costs_included !== null ? row.costs_included === "true" : null;

  return {
    jobId: row.job_id,
    requestedByEmail: row.requested_by_email,
    requestedByName: row.requested_by_name,
    status: row.status,
    stage: row.stage,
    stageMessage: row.stage_message,
    progressPct: row.progress_pct,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    updatedAt: row.updated_at.toISOString(),
    errorMessage: row.error_message,
    resultMeta: {
      model: row.model,
      provider: row.provider,
      metricsCollected: Number.isFinite(metricsCollected) ? metricsCollected : null,
      costsIncluded,
      costWindow: row.cost_window || null,
      timestamp: row.result_timestamp,
    },
  };
}

export async function createFinOpsAdvisorJob(params: {
  requestedByEmail: string;
  requestedByName?: string | null;
  requestPayload: FinOpsAdvisorRunInput;
}) {
  const jobId = crypto.randomUUID();
  const result = await pool.query<JobRow>(
    `
      INSERT INTO finops_advisor_jobs (
        job_id,
        requested_by_email,
        requested_by_name,
        status,
        stage,
        stage_message,
        progress_pct,
        request_payload,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, 'queued', 'queued', 'Trabajo en cola', 0, $4::jsonb, NOW(), NOW())
      RETURNING *
    `,
    [
      jobId,
      params.requestedByEmail,
      params.requestedByName ?? null,
      JSON.stringify(params.requestPayload),
    ],
  );

  return mapRow(result.rows[0]);
}

export async function markFinOpsAdvisorJobRunning(jobId: string) {
  await pool.query(
    `
      UPDATE finops_advisor_jobs
      SET status = 'running',
          stage = 'fetching_inventory',
          stage_message = 'Iniciando análisis',
          progress_pct = GREATEST(progress_pct, 5),
          started_at = COALESCE(started_at, NOW()),
          updated_at = NOW()
      WHERE job_id = $1
    `,
    [jobId],
  );
}

export async function updateFinOpsAdvisorJobProgress(
  jobId: string,
  stage: FinOpsAdvisorStage,
  progressPct: number,
  stageMessage: string,
) {
  await pool.query(
    `
      UPDATE finops_advisor_jobs
      SET stage = $2,
          stage_message = $3,
          progress_pct = LEAST(100, GREATEST(0, $4)),
          updated_at = NOW()
      WHERE job_id = $1
        AND status IN ('queued', 'running')
    `,
    [jobId, stage, stageMessage, Math.round(progressPct)],
  );
}

export async function completeFinOpsAdvisorJob(jobId: string, resultPayload: FinOpsAdvisorRunResult) {
  await pool.query(
    `
      UPDATE finops_advisor_jobs
      SET status = 'completed',
          stage = 'completed',
          stage_message = 'Informe completado',
          progress_pct = 100,
          result_json = $2::jsonb,
          error_message = NULL,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE job_id = $1
    `,
    [jobId, JSON.stringify(resultPayload)],
  );
}

export async function failFinOpsAdvisorJob(jobId: string, errorMessage: string) {
  await pool.query(
    `
      UPDATE finops_advisor_jobs
      SET status = 'failed',
          stage = 'failed',
          stage_message = 'Error en análisis',
          error_message = $2,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE job_id = $1
    `,
    [jobId, errorMessage],
  );
}

export async function getFinOpsAdvisorJob(jobId: string): Promise<FinOpsAdvisorJob | null> {
  const result = await pool.query<JobRow>(
    `
      SELECT *
      FROM finops_advisor_jobs
      WHERE job_id = $1
      LIMIT 1
    `,
    [jobId],
  );

  if (result.rowCount === 0) return null;
  return mapRow(result.rows[0]);
}

export async function listFinOpsAdvisorJobs(params: {
  requesterEmail: string;
  isAdmin: boolean;
  limit?: number;
  status?: FinOpsAdvisorJobStatus;
}) {
  const limit = Math.min(100, Math.max(1, params.limit ?? 20));
  const result = await pool.query<JobListRow>(
    `
      SELECT
        job_id,
        requested_by_email,
        requested_by_name,
        status,
        stage,
        stage_message,
        progress_pct,
        created_at,
        started_at,
        finished_at,
        updated_at,
        error_message,
        result_json->>'model' AS model,
        result_json->>'provider' AS provider,
        result_json->>'metricsCollected' AS metrics_collected,
        result_json->>'costsIncluded' AS costs_included,
        result_json->'costWindow' AS cost_window,
        result_json->>'timestamp' AS result_timestamp
      FROM finops_advisor_jobs
      WHERE ($1::boolean OR lower(requested_by_email) = lower($2))
        AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC
      LIMIT $4
    `,
    [
      params.isAdmin,
      params.requesterEmail,
      params.status ?? null,
      limit,
    ],
  );

  return result.rows.map(mapListRow);
}

export function isMissingFinOpsAdvisorJobsTableError(error: unknown): boolean {
  const pgError = error as PgError;
  return pgError?.code === "42P01";
}
