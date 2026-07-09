
-- Migration to support Daily DORA Metrics
-- Derived from ARCHITECTURE.md changes

CREATE TABLE IF NOT EXISTS dora_metrics_daily (
    snapshot_date DATE NOT NULL,
    project_id INTEGER NOT NULL,
    team TEXT NOT NULL,
    project_name TEXT NOT NULL,
    project_path TEXT NOT NULL,
    
    -- DORA Metrics (Daily Aggregates)
    deployment_count INTEGER DEFAULT 0,
    deployment_failures INTEGER DEFAULT 0,
    lead_time_sum_hours FLOAT DEFAULT 0,
    lead_time_count INTEGER DEFAULT 0,
    mttr_sum_hours FLOAT DEFAULT 0,
    mttr_count INTEGER DEFAULT 0,
    
    -- Code Quality (Snapshot)
    coverage FLOAT DEFAULT 0,
    bugs INTEGER DEFAULT 0,
    vulnerabilities INTEGER DEFAULT 0,
    code_smells INTEGER DEFAULT 0,
    tech_debt_minutes INTEGER DEFAULT 0,
    
    -- Activity Stats
    total_commits INTEGER DEFAULT 0,
    total_mrs INTEGER DEFAULT 0,
    total_reviews INTEGER DEFAULT 0,
    active_devs INTEGER DEFAULT 0,
    
    data_source TEXT DEFAULT 'gitlab',
    calculated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    PRIMARY KEY (snapshot_date, project_id)
);

CREATE INDEX IF NOT EXISTS idx_dora_daily_team ON dora_metrics_daily(team);
CREATE INDEX IF NOT EXISTS idx_dora_daily_date ON dora_metrics_daily(snapshot_date);

CREATE TABLE IF NOT EXISTS developer_activity_daily (
    snapshot_date DATE NOT NULL,
    developer_email TEXT NOT NULL,
    project_id INTEGER NOT NULL,
    
    developer_name TEXT,
    team TEXT,
    project_name TEXT,
    project_path TEXT,
    
    commits_count INTEGER DEFAULT 0,
    lines_added INTEGER DEFAULT 0,
    lines_removed INTEGER DEFAULT 0,
    mrs_opened INTEGER DEFAULT 0,
    mrs_merged INTEGER DEFAULT 0,
    reviews_given INTEGER DEFAULT 0,
    
    first_commit_time TIMESTAMP WITH TIME ZONE,
    last_commit_time TIMESTAMP WITH TIME ZONE,
    
    calculated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    PRIMARY KEY (snapshot_date, developer_email, project_id)
);

CREATE INDEX IF NOT EXISTS idx_dev_daily_email ON developer_activity_daily(developer_email);
CREATE INDEX IF NOT EXISTS idx_dev_daily_team ON developer_activity_daily(team);
