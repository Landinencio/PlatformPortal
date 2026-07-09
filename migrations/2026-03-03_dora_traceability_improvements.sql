-- Improves DORA traceability with better lead-time capture and deploy classification metadata.

ALTER TABLE dora_metrics_daily
ADD COLUMN IF NOT EXISTS lead_time_first_commit_sum_hours DECIMAL(10,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS lead_time_first_commit_count INTEGER DEFAULT 0;

ALTER TABLE deployment_traces
ADD COLUMN IF NOT EXISTS mr_first_commit_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS mr_last_commit_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS mr_commit_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS deploy_type_reason TEXT,
ADD COLUMN IF NOT EXISTS lead_time_first_commit_hours DECIMAL(10,2);

CREATE INDEX IF NOT EXISTS idx_deployment_traces_type_date
ON deployment_traces (deploy_type, snapshot_date);

COMMENT ON COLUMN dora_metrics_daily.lead_time_first_commit_sum_hours IS 'Sum of lead time from earliest MR commit to production deploy';
COMMENT ON COLUMN dora_metrics_daily.lead_time_first_commit_count IS 'Deployments with earliest MR commit lead time available';
COMMENT ON COLUMN deployment_traces.mr_first_commit_at IS 'Earliest commit timestamp found inside the associated MR';
COMMENT ON COLUMN deployment_traces.mr_last_commit_at IS 'Latest commit timestamp found inside the associated MR';
COMMENT ON COLUMN deployment_traces.mr_commit_count IS 'Number of commits included in the associated MR';
COMMENT ON COLUMN deployment_traces.deploy_type_reason IS 'Why this deploy was classified as feature, hotfix or rollback';
COMMENT ON COLUMN deployment_traces.lead_time_first_commit_hours IS 'Lead time from earliest MR commit to deploy';
