-- K8s workload mapping to GitLab project/team for scoped runtime analytics.
-- This enables filtering Kubernetes runtime signals by project/team in DORA views.

CREATE TABLE IF NOT EXISTS k8s_workload_mapping (
    id SERIAL PRIMARY KEY,
    cluster VARCHAR(128) NOT NULL DEFAULT 'dp-prod',
    namespace VARCHAR(255) NOT NULL,
    deployment VARCHAR(255) NOT NULL,
    project_id INTEGER NOT NULL,
    team VARCHAR(100),
    project_name VARCHAR(255),
    source VARCHAR(32) NOT NULL DEFAULT 'manual', -- manual | heuristic | service-catalog
    confidence NUMERIC(4,3) NOT NULL DEFAULT 1.000,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(cluster, namespace, deployment)
);

CREATE INDEX IF NOT EXISTS idx_k8s_mapping_project ON k8s_workload_mapping(project_id);
CREATE INDEX IF NOT EXISTS idx_k8s_mapping_team ON k8s_workload_mapping(team);
CREATE INDEX IF NOT EXISTS idx_k8s_mapping_cluster_ns ON k8s_workload_mapping(cluster, namespace);

ALTER TABLE k8s_rollouts_daily
ADD COLUMN IF NOT EXISTS cluster VARCHAR(128) DEFAULT 'dp-prod',
ADD COLUMN IF NOT EXISTS project_id INTEGER,
ADD COLUMN IF NOT EXISTS team VARCHAR(100),
ADD COLUMN IF NOT EXISTS mapping_source VARCHAR(32),
ADD COLUMN IF NOT EXISTS mapping_confidence NUMERIC(4,3);

ALTER TABLE k8s_failures_daily
ADD COLUMN IF NOT EXISTS cluster VARCHAR(128) DEFAULT 'dp-prod',
ADD COLUMN IF NOT EXISTS project_id INTEGER,
ADD COLUMN IF NOT EXISTS team VARCHAR(100),
ADD COLUMN IF NOT EXISTS mapping_source VARCHAR(32),
ADD COLUMN IF NOT EXISTS mapping_confidence NUMERIC(4,3);

UPDATE k8s_rollouts_daily
SET cluster = 'dp-prod'
WHERE cluster IS NULL;

UPDATE k8s_failures_daily
SET cluster = 'dp-prod'
WHERE cluster IS NULL;

CREATE INDEX IF NOT EXISTS idx_k8s_rollouts_project_date ON k8s_rollouts_daily(project_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_k8s_rollouts_team_date ON k8s_rollouts_daily(team, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_k8s_rollouts_cluster_date ON k8s_rollouts_daily(cluster, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_k8s_failures_project_date ON k8s_failures_daily(project_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_k8s_failures_team_date ON k8s_failures_daily(team, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_k8s_failures_cluster_date ON k8s_failures_daily(cluster, snapshot_date DESC);

COMMENT ON TABLE k8s_workload_mapping IS 'Maps Kubernetes workloads to GitLab project/team for scoped runtime analytics';
COMMENT ON COLUMN k8s_workload_mapping.source IS 'Mapping origin: manual, heuristic or service-catalog';
COMMENT ON COLUMN k8s_workload_mapping.confidence IS 'Confidence score for mapping quality (0-1)';
