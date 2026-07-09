CREATE TABLE IF NOT EXISTS finops_advisor_jobs (
    job_id TEXT PRIMARY KEY,
    requested_by_email TEXT NOT NULL,
    requested_by_name TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    stage TEXT NOT NULL,
    stage_message TEXT,
    progress_pct INTEGER NOT NULL DEFAULT 0 CHECK (progress_pct >= 0 AND progress_pct <= 100),
    request_payload JSONB NOT NULL,
    result_json JSONB,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finops_advisor_jobs_created_at
ON finops_advisor_jobs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_finops_advisor_jobs_requested_by
ON finops_advisor_jobs (requested_by_email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_finops_advisor_jobs_status
ON finops_advisor_jobs (status, created_at DESC);
