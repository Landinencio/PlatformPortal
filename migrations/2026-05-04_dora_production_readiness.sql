-- DORA Metrics Production Readiness
-- Purpose: Deprecate SonarQube columns in dora_metrics_daily, add performance indexes,
--          and relax uniqueness constraint in deployment_correlation to support
--          multiple ArgoCD syncs per pipeline.
-- Date: 2026-05-04
-- Requirements: 9.1, 9.4, 10.1, 10.2, 10.3, 10.4, 10.5, 14.1, 14.2

-- =============================================================================
-- 1. Deprecate SonarQube columns in dora_metrics_daily (Req 9)
--    These columns are superseded by the sonarqube_metrics_daily table.
-- =============================================================================

ALTER TABLE dora_metrics_daily
  ALTER COLUMN coverage SET DEFAULT NULL,
  ALTER COLUMN bugs SET DEFAULT NULL,
  ALTER COLUMN vulnerabilities SET DEFAULT NULL,
  ALTER COLUMN code_smells SET DEFAULT NULL,
  ALTER COLUMN tech_debt_minutes SET DEFAULT NULL;

COMMENT ON COLUMN dora_metrics_daily.coverage IS 'DEPRECATED: Use sonarqube_metrics_daily instead';
COMMENT ON COLUMN dora_metrics_daily.bugs IS 'DEPRECATED: Use sonarqube_metrics_daily instead';
COMMENT ON COLUMN dora_metrics_daily.vulnerabilities IS 'DEPRECATED: Use sonarqube_metrics_daily instead';
COMMENT ON COLUMN dora_metrics_daily.code_smells IS 'DEPRECATED: Use sonarqube_metrics_daily instead';
COMMENT ON COLUMN dora_metrics_daily.tech_debt_minutes IS 'DEPRECATED: Use sonarqube_metrics_daily instead';

-- =============================================================================
-- 2. Performance indexes (Req 10)
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_deployment_traces_deploy_type
  ON deployment_traces(deploy_type);

CREATE INDEX IF NOT EXISTS idx_deployment_traces_composite
  ON deployment_traces(snapshot_date, project_id, deploy_type);

CREATE INDEX IF NOT EXISTS idx_dora_metrics_daily_date_project
  ON dora_metrics_daily(snapshot_date, project_id);

CREATE INDEX IF NOT EXISTS idx_sonarqube_metrics_daily_date_key
  ON sonarqube_metrics_daily(snapshot_date, sonar_project_key);

-- =============================================================================
-- 3. Relax uniqueness in deployment_correlation (Req 14)
--    Allow multiple ArgoCD syncs per pipeline by including argocd_sync_timestamp
--    in the unique constraint.
-- =============================================================================

ALTER TABLE deployment_correlation
  DROP CONSTRAINT IF EXISTS deployment_correlation_correlation_date_gitlab_project_id_key;

ALTER TABLE deployment_correlation
  ADD CONSTRAINT deployment_correlation_unique_sync
  UNIQUE (correlation_date, gitlab_project_id, gitlab_pipeline_id, argocd_app_key, argocd_sync_timestamp);
