-- DORA Metrics Improvements Migration
-- 1. Add deploy classification and improved lead time tracking
-- 2. Create deployment traces table for full traceability
-- 3. Separate SonarQube metrics into independent table

-- Add new columns to dora_metrics_daily for deploy classification
ALTER TABLE dora_metrics_daily 
ADD COLUMN IF NOT EXISTS lead_time_mr_sum_hours DECIMAL(10,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS lead_time_mr_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS unique_commits_deployed INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS rollback_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS hotfix_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS feature_count INTEGER DEFAULT 0;

-- Create deployment traces table for full traceability
CREATE TABLE IF NOT EXISTS deployment_traces (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    project_id INTEGER NOT NULL,
    project_name VARCHAR(255),
    
    -- Commit info
    commit_sha VARCHAR(64) NOT NULL,
    commit_created_at TIMESTAMP,
    commit_author_email VARCHAR(255),
    
    -- MR info (nullable if direct push)
    mr_id INTEGER,
    mr_iid INTEGER,
    mr_created_at TIMESTAMP,
    mr_merged_at TIMESTAMP,
    mr_title TEXT,
    mr_labels TEXT[], -- for hotfix detection
    mr_source_branch VARCHAR(255),
    
    -- Deploy info
    deploy_id VARCHAR(64) NOT NULL,
    deploy_created_at TIMESTAMP NOT NULL,
    deploy_type VARCHAR(32) DEFAULT 'feature', -- feature, hotfix, rollback
    deploy_environment VARCHAR(64),
    
    -- Calculated metrics
    lead_time_commit_hours DECIMAL(10,2), -- deploy - commit (current)
    lead_time_mr_hours DECIMAL(10,2), -- deploy - mr_created (real dev time)
    
    created_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(snapshot_date, project_id, deploy_id)
);

CREATE INDEX IF NOT EXISTS idx_deployment_traces_date ON deployment_traces(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_deployment_traces_project ON deployment_traces(project_id);
CREATE INDEX IF NOT EXISTS idx_deployment_traces_commit ON deployment_traces(commit_sha);

-- Create independent SonarQube metrics table
CREATE TABLE IF NOT EXISTS sonarqube_metrics_daily (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    
    -- SonarQube project info (independent of GitLab)
    sonar_project_key VARCHAR(255) NOT NULL,
    sonar_project_name VARCHAR(255),
    
    -- Optional GitLab link (manual mapping)
    gitlab_project_id INTEGER,
    gitlab_project_path VARCHAR(255),
    
    -- Metrics
    coverage DECIMAL(5,2) DEFAULT 0,
    bugs INTEGER DEFAULT 0,
    vulnerabilities INTEGER DEFAULT 0,
    code_smells INTEGER DEFAULT 0,
    tech_debt_minutes INTEGER DEFAULT 0,
    security_hotspots INTEGER DEFAULT 0,
    duplicated_lines_density DECIMAL(5,2) DEFAULT 0,
    
    -- Quality gate
    quality_gate_status VARCHAR(32),
    
    calculated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(snapshot_date, sonar_project_key)
);

CREATE INDEX IF NOT EXISTS idx_sonarqube_metrics_date ON sonarqube_metrics_daily(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_sonarqube_metrics_project ON sonarqube_metrics_daily(sonar_project_key);

-- Create mapping table for GitLab <-> SonarQube (manual/admin managed)
CREATE TABLE IF NOT EXISTS project_sonar_mapping (
    id SERIAL PRIMARY KEY,
    gitlab_project_id INTEGER NOT NULL,
    gitlab_project_path VARCHAR(255),
    sonar_project_key VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(gitlab_project_id),
    UNIQUE(sonar_project_key)
);

-- Remove SonarQube columns from dora_metrics_daily (keep for now, deprecate later)
-- We'll stop populating them but keep for historical data
COMMENT ON COLUMN dora_metrics_daily.coverage IS 'DEPRECATED: Use sonarqube_metrics_daily instead';
COMMENT ON COLUMN dora_metrics_daily.bugs IS 'DEPRECATED: Use sonarqube_metrics_daily instead';
COMMENT ON COLUMN dora_metrics_daily.vulnerabilities IS 'DEPRECATED: Use sonarqube_metrics_daily instead';
COMMENT ON COLUMN dora_metrics_daily.code_smells IS 'DEPRECATED: Use sonarqube_metrics_daily instead';
COMMENT ON COLUMN dora_metrics_daily.tech_debt_minutes IS 'DEPRECATED: Use sonarqube_metrics_daily instead';
