-- Service compliance snapshot for GitLab governance, DORA readiness and Sonar/runtime linkage.

CREATE TABLE IF NOT EXISTS service_compliance_daily (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    project_id INTEGER NOT NULL,
    project_name VARCHAR(255) NOT NULL,
    project_path VARCHAR(255) NOT NULL,
    team VARCHAR(100),
    default_branch VARCHAR(255),
    default_branch_protected BOOLEAN DEFAULT FALSE,
    push_rules_configured BOOLEAN DEFAULT FALSE,
    branch_name_regex TEXT,
    branch_regex_ok BOOLEAN DEFAULT FALSE,
    deploy_prod_declared BOOLEAN DEFAULT FALSE,
    deploy_prod_observed BOOLEAN DEFAULT FALSE,
    prod_environment_standard_ok BOOLEAN DEFAULT FALSE,
    service_catalog_linked BOOLEAN DEFAULT FALSE,
    runtime_mapping_ok BOOLEAN DEFAULT FALSE,
    runtime_mapping_sources TEXT[] DEFAULT ARRAY[]::TEXT[],
    k8s_mapping_count INTEGER DEFAULT 0,
    k8s_mapping_confidence NUMERIC(4,3),
    sonar_linked BOOLEAN DEFAULT FALSE,
    sonar_project_key VARCHAR(255),
    quality_gate_reporting BOOLEAN DEFAULT FALSE,
    latest_quality_gate_status VARCHAR(32),
    last_deploy_job_at TIMESTAMP,
    last_production_deploy_at TIMESTAMP,
    successful_deploys_90d INTEGER DEFAULT 0,
    traced_deploys_90d INTEGER DEFAULT 0,
    dora_traceability_ready BOOLEAN DEFAULT FALSE,
    compliance_score NUMERIC(5,2) DEFAULT 0,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(snapshot_date, project_id)
);

CREATE INDEX IF NOT EXISTS idx_service_compliance_daily_snapshot
ON service_compliance_daily(snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_service_compliance_daily_team_snapshot
ON service_compliance_daily(team, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_service_compliance_daily_project_snapshot
ON service_compliance_daily(project_id, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_service_compliance_daily_score
ON service_compliance_daily(compliance_score DESC, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_service_compliance_daily_dora_ready
ON service_compliance_daily(dora_traceability_ready, snapshot_date DESC);

COMMENT ON TABLE service_compliance_daily IS 'Daily GitLab compliance and delivery-readiness snapshot per repository';
COMMENT ON COLUMN service_compliance_daily.branch_regex_ok IS 'Whether project push rules enforce ADR-001 branch naming regex';
COMMENT ON COLUMN service_compliance_daily.deploy_prod_declared IS 'Whether the repository CI declares a deploy_prod-like job or stage';
COMMENT ON COLUMN service_compliance_daily.deploy_prod_observed IS 'Whether the portal has observed deploy_prod-like jobs recently in canonical GitLab ingestion';
COMMENT ON COLUMN service_compliance_daily.runtime_mapping_ok IS 'Whether the project is linked to runtime/service catalog targets for operational scoping';
COMMENT ON COLUMN service_compliance_daily.dora_traceability_ready IS 'Whether the repository currently has enough GitLab deploy evidence and lineage to sustain DORA metrics';
