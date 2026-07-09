-- Indexes to support the split dashboards for DORA core, MR manager analytics and SonarQube.

CREATE INDEX IF NOT EXISTS idx_gitlab_mr_analytics_latest
ON gitlab_mr_analytics (project_id, mr_iid, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_gitlab_mr_analytics_scope
ON gitlab_mr_analytics (team, project_id, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_gitlab_mr_analytics_reference_dates
ON gitlab_mr_analytics (merged_at, created_at);

CREATE INDEX IF NOT EXISTS idx_sonarqube_metrics_daily_latest
ON sonarqube_metrics_daily (sonar_project_key, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_sonarqube_metrics_daily_date_status
ON sonarqube_metrics_daily (snapshot_date, quality_gate_status);
