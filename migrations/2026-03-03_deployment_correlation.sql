-- Migration: Deployment Correlation (GitLab ↔ ArgoCD)
-- Purpose: Link GitLab pipelines with ArgoCD syncs for hybrid DORA metrics
-- Date: 2026-03-03

-- Table to store correlations between GitLab deploys and ArgoCD syncs
CREATE TABLE IF NOT EXISTS deployment_correlation (
    id SERIAL PRIMARY KEY,
    
    -- Date partition
    correlation_date DATE NOT NULL,
    
    -- GitLab side
    gitlab_project_id INTEGER NOT NULL,
    gitlab_project_name VARCHAR(255),
    gitlab_pipeline_id INTEGER,
    gitlab_job_id INTEGER,
    gitlab_commit_sha VARCHAR(40),
    gitlab_commit_timestamp TIMESTAMP,
    gitlab_pipeline_status VARCHAR(50),
    gitlab_pipeline_timestamp TIMESTAMP,
    
    -- ArgoCD side
    argocd_app_name VARCHAR(255),
    argocd_app_key VARCHAR(255), -- project::name format
    argocd_project VARCHAR(255),
    argocd_namespace VARCHAR(255),
    argocd_cluster VARCHAR(255),
    argocd_repo VARCHAR(500),
    argocd_sync_timestamp TIMESTAMP,
    argocd_sync_status VARCHAR(50), -- Succeeded, Failed, etc.
    argocd_health_status VARCHAR(50), -- Healthy, Degraded, etc.
    argocd_operation VARCHAR(50),
    
    -- Correlation metadata
    correlation_method VARCHAR(50), -- 'repo-match', 'name-match', 'timestamp-proximity', 'manual'
    correlation_confidence FLOAT CHECK (correlation_confidence >= 0 AND correlation_confidence <= 1),
    time_diff_minutes INTEGER, -- Difference between pipeline and sync
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    -- Constraints
    UNIQUE (correlation_date, gitlab_project_id, gitlab_pipeline_id, argocd_app_key)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_deployment_correlation_date 
    ON deployment_correlation(correlation_date DESC);

CREATE INDEX IF NOT EXISTS idx_deployment_correlation_gitlab_project 
    ON deployment_correlation(gitlab_project_id, correlation_date DESC);

CREATE INDEX IF NOT EXISTS idx_deployment_correlation_argocd_app 
    ON deployment_correlation(argocd_app_name, correlation_date DESC);

CREATE INDEX IF NOT EXISTS idx_deployment_correlation_confidence 
    ON deployment_correlation(correlation_confidence DESC) 
    WHERE correlation_confidence >= 0.7;

CREATE INDEX IF NOT EXISTS idx_deployment_correlation_timestamps 
    ON deployment_correlation(gitlab_pipeline_timestamp, argocd_sync_timestamp);

-- Comments
COMMENT ON TABLE deployment_correlation IS 'Correlates GitLab CI/CD pipelines with ArgoCD syncs for hybrid DORA metrics';
COMMENT ON COLUMN deployment_correlation.correlation_method IS 'Method used to correlate: repo-match (best), name-match (good), timestamp-proximity (fallback)';
COMMENT ON COLUMN deployment_correlation.correlation_confidence IS 'Confidence score 0.0-1.0: repo-match=1.0, name-match=0.8, timestamp=0.5';
COMMENT ON COLUMN deployment_correlation.time_diff_minutes IS 'Time difference between GitLab pipeline completion and ArgoCD sync start';

-- View for high-confidence correlations
CREATE OR REPLACE VIEW deployment_correlation_verified AS
SELECT 
    dc.*,
    CASE 
        WHEN dc.correlation_confidence >= 0.9 THEN 'verified'
        WHEN dc.correlation_confidence >= 0.7 THEN 'probable'
        WHEN dc.correlation_confidence >= 0.5 THEN 'possible'
        ELSE 'uncertain'
    END as confidence_level
FROM deployment_correlation dc
WHERE dc.correlation_confidence >= 0.5
ORDER BY dc.correlation_date DESC, dc.correlation_confidence DESC;

COMMENT ON VIEW deployment_correlation_verified IS 'High-confidence correlations (>= 0.5) with confidence level labels';
