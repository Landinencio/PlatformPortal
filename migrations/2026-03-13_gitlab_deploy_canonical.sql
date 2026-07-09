-- Canonical GitLab deployment ingestion for DORA V2
-- 1. Enrich canonical production deployments with GitLab-specific identifiers
-- 2. Persist raw deploy jobs and normalized deploy attempts

ALTER TABLE production_deployments
ADD COLUMN IF NOT EXISTS team VARCHAR(100),
ADD COLUMN IF NOT EXISTS deploy_type VARCHAR(32) DEFAULT 'feature',
ADD COLUMN IF NOT EXISTS deploy_type_reason TEXT,
ADD COLUMN IF NOT EXISTS gitlab_pipeline_id VARCHAR(64),
ADD COLUMN IF NOT EXISTS gitlab_job_id VARCHAR(64),
ADD COLUMN IF NOT EXISTS gitlab_ref VARCHAR(255),
ADD COLUMN IF NOT EXISTS gitlab_stage_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS gitlab_job_name VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_production_deployments_team
ON production_deployments(team);

CREATE INDEX IF NOT EXISTS idx_production_deployments_type
ON production_deployments(deploy_type, deploy_completed_at);

CREATE INDEX IF NOT EXISTS idx_production_deployments_gitlab_pipeline
ON production_deployments(gitlab_pipeline_id);

CREATE INDEX IF NOT EXISTS idx_production_deployments_gitlab_job
ON production_deployments(gitlab_job_id);

CREATE TABLE IF NOT EXISTS gitlab_deploy_jobs (
    id SERIAL PRIMARY KEY,
    service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
    project_id INTEGER NOT NULL,
    project_name VARCHAR(255),
    team VARCHAR(100),
    pipeline_id VARCHAR(64),
    job_id VARCHAR(64) NOT NULL,
    job_name VARCHAR(255),
    stage_name VARCHAR(255),
    status VARCHAR(32) NOT NULL,
    ref VARCHAR(255),
    environment VARCHAR(64),
    commit_sha VARCHAR(64),
    commit_created_at TIMESTAMP,
    commit_author_email VARCHAR(255),
    job_created_at TIMESTAMP,
    job_started_at TIMESTAMP,
    job_finished_at TIMESTAMP,
    job_web_url TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    first_seen_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(project_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_gitlab_deploy_jobs_project
ON gitlab_deploy_jobs(project_id, job_finished_at);

CREATE INDEX IF NOT EXISTS idx_gitlab_deploy_jobs_team
ON gitlab_deploy_jobs(team, job_finished_at);

CREATE INDEX IF NOT EXISTS idx_gitlab_deploy_jobs_status
ON gitlab_deploy_jobs(status, job_finished_at);

CREATE INDEX IF NOT EXISTS idx_gitlab_deploy_jobs_commit
ON gitlab_deploy_jobs(commit_sha);

CREATE TABLE IF NOT EXISTS gitlab_deploy_attempts (
    id SERIAL PRIMARY KEY,
    external_id VARCHAR(255) NOT NULL UNIQUE,
    source VARCHAR(64) NOT NULL DEFAULT 'gitlab_job',
    service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
    production_deployment_id INTEGER REFERENCES production_deployments(id) ON DELETE SET NULL,
    project_id INTEGER NOT NULL,
    project_name VARCHAR(255),
    team VARCHAR(100),
    environment VARCHAR(64) NOT NULL DEFAULT 'production',
    status VARCHAR(32) NOT NULL,
    ref VARCHAR(255),
    commit_sha VARCHAR(64),
    commit_created_at TIMESTAMP,
    commit_author_email VARCHAR(255),
    pipeline_id VARCHAR(64),
    job_id VARCHAR(64),
    job_name VARCHAR(255),
    stage_name VARCHAR(255),
    deploy_started_at TIMESTAMP,
    deploy_completed_at TIMESTAMP,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gitlab_deploy_attempts_project
ON gitlab_deploy_attempts(project_id, deploy_completed_at);

CREATE INDEX IF NOT EXISTS idx_gitlab_deploy_attempts_team
ON gitlab_deploy_attempts(team, deploy_completed_at);

CREATE INDEX IF NOT EXISTS idx_gitlab_deploy_attempts_status
ON gitlab_deploy_attempts(status, deploy_completed_at);

CREATE INDEX IF NOT EXISTS idx_gitlab_deploy_attempts_environment
ON gitlab_deploy_attempts(environment, deploy_completed_at);

CREATE INDEX IF NOT EXISTS idx_gitlab_deploy_attempts_commit
ON gitlab_deploy_attempts(commit_sha);

COMMENT ON TABLE gitlab_deploy_jobs IS 'Raw GitLab deploy jobs collected from deploy_prod-like stages';
COMMENT ON TABLE gitlab_deploy_attempts IS 'Normalized GitLab production deploy attempts, successful or failed';
COMMENT ON COLUMN production_deployments.gitlab_pipeline_id IS 'GitLab pipeline identifier backing the canonical production deployment';
COMMENT ON COLUMN production_deployments.gitlab_job_id IS 'GitLab job identifier that completed the production deployment';
