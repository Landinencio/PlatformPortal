-- New daily aggregate tables for DORA metrics and developer activity
-- Safe to run multiple times (idempotent where possible)

CREATE TABLE IF NOT EXISTS dora_metrics_daily (
    snapshot_date DATE NOT NULL,
    team TEXT NOT NULL,
    project_id INTEGER NOT NULL,
    project_name TEXT NOT NULL,
    project_path TEXT NOT NULL,
    deployment_count INTEGER NOT NULL DEFAULT 0,
    deployment_failures INTEGER NOT NULL DEFAULT 0,
    lead_time_sum_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
    lead_time_count INTEGER NOT NULL DEFAULT 0,
    mttr_sum_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
    mttr_count INTEGER NOT NULL DEFAULT 0,
    coverage DOUBLE PRECISION NOT NULL DEFAULT 0,
    bugs INTEGER NOT NULL DEFAULT 0,
    vulnerabilities INTEGER NOT NULL DEFAULT 0,
    code_smells INTEGER NOT NULL DEFAULT 0,
    tech_debt_minutes INTEGER NOT NULL DEFAULT 0,
    total_commits INTEGER NOT NULL DEFAULT 0,
    total_mrs INTEGER NOT NULL DEFAULT 0,
    total_reviews INTEGER NOT NULL DEFAULT 0,
    active_devs INTEGER NOT NULL DEFAULT 0,
    data_source TEXT,
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (snapshot_date, project_id)
);

CREATE INDEX IF NOT EXISTS idx_dora_metrics_daily_team_date
    ON dora_metrics_daily (team, snapshot_date);

CREATE INDEX IF NOT EXISTS idx_dora_metrics_daily_project
    ON dora_metrics_daily (project_id, snapshot_date);

CREATE TABLE IF NOT EXISTS developer_activity_daily (
    snapshot_date DATE NOT NULL,
    developer_email TEXT NOT NULL,
    developer_name TEXT,
    team TEXT,
    project_id INTEGER NOT NULL,
    project_name TEXT NOT NULL,
    project_path TEXT NOT NULL,
    commits_count INTEGER NOT NULL DEFAULT 0,
    lines_added INTEGER NOT NULL DEFAULT 0,
    lines_removed INTEGER NOT NULL DEFAULT 0,
    mrs_opened INTEGER NOT NULL DEFAULT 0,
    mrs_merged INTEGER NOT NULL DEFAULT 0,
    reviews_given INTEGER NOT NULL DEFAULT 0,
    first_commit_time TIMESTAMPTZ,
    last_commit_time TIMESTAMPTZ,
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (snapshot_date, developer_email, project_id)
);

CREATE INDEX IF NOT EXISTS idx_dev_activity_daily_team_date
    ON developer_activity_daily (team, snapshot_date);

CREATE INDEX IF NOT EXISTS idx_dev_activity_daily_email_date
    ON developer_activity_daily (developer_email, snapshot_date);
