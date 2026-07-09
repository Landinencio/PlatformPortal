-- Reliability and real-incident foundation
-- Prepares the portal to track production deployments, incidents, and their links.

CREATE TABLE IF NOT EXISTS services (
    id SERIAL PRIMARY KEY,
    service_key VARCHAR(255) NOT NULL UNIQUE,
    service_name VARCHAR(255) NOT NULL,
    team VARCHAR(100),
    gitlab_project_id INTEGER,
    gitlab_project_path VARCHAR(255),
    tier VARCHAR(32) DEFAULT 'unknown',
    criticality VARCHAR(32) DEFAULT 'medium',
    lifecycle VARCHAR(32) DEFAULT 'active',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_services_team ON services(team);
CREATE INDEX IF NOT EXISTS idx_services_gitlab_project ON services(gitlab_project_id);

CREATE TABLE IF NOT EXISTS service_runtime_targets (
    id SERIAL PRIMARY KEY,
    service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    environment VARCHAR(64) NOT NULL,
    cluster VARCHAR(128),
    namespace VARCHAR(255),
    workload_kind VARCHAR(64),
    workload_name VARCHAR(255),
    region VARCHAR(64),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(service_id, environment, cluster, namespace, workload_kind, workload_name)
);

CREATE INDEX IF NOT EXISTS idx_service_runtime_targets_service ON service_runtime_targets(service_id);
CREATE INDEX IF NOT EXISTS idx_service_runtime_targets_env ON service_runtime_targets(environment);
CREATE INDEX IF NOT EXISTS idx_service_runtime_targets_cluster_ns ON service_runtime_targets(cluster, namespace);

CREATE TABLE IF NOT EXISTS production_deployments (
    id SERIAL PRIMARY KEY,
    external_id VARCHAR(255),
    source VARCHAR(64) NOT NULL DEFAULT 'gitlab',
    service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
    project_id INTEGER,
    project_name VARCHAR(255),
    environment VARCHAR(64) NOT NULL DEFAULT 'production',
    status VARCHAR(32) NOT NULL DEFAULT 'success',
    commit_sha VARCHAR(64),
    image_tag VARCHAR(255),
    image_digest VARCHAR(255),
    deploy_started_at TIMESTAMP,
    deploy_completed_at TIMESTAMP NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_production_deployments_service ON production_deployments(service_id);
CREATE INDEX IF NOT EXISTS idx_production_deployments_project ON production_deployments(project_id);
CREATE INDEX IF NOT EXISTS idx_production_deployments_env_time ON production_deployments(environment, deploy_completed_at);
CREATE INDEX IF NOT EXISTS idx_production_deployments_commit ON production_deployments(commit_sha);

CREATE TABLE IF NOT EXISTS deployment_changes (
    id SERIAL PRIMARY KEY,
    deployment_id INTEGER NOT NULL REFERENCES production_deployments(id) ON DELETE CASCADE,
    commit_sha VARCHAR(64) NOT NULL,
    commit_created_at TIMESTAMP,
    mr_id INTEGER,
    mr_iid INTEGER,
    mr_created_at TIMESTAMP,
    mr_first_commit_at TIMESTAMP,
    mr_merged_at TIMESTAMP,
    author_email VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(deployment_id, commit_sha)
);

CREATE INDEX IF NOT EXISTS idx_deployment_changes_deployment ON deployment_changes(deployment_id);
CREATE INDEX IF NOT EXISTS idx_deployment_changes_commit ON deployment_changes(commit_sha);

CREATE TABLE IF NOT EXISTS production_incidents (
    id SERIAL PRIMARY KEY,
    source VARCHAR(64) NOT NULL,
    source_incident_id VARCHAR(255) NOT NULL,
    service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
    service_name VARCHAR(255),
    team VARCHAR(100),
    gitlab_project_id INTEGER,
    environment VARCHAR(64) NOT NULL DEFAULT 'production',
    severity VARCHAR(32) NOT NULL DEFAULT 'medium',
    status VARCHAR(32) NOT NULL DEFAULT 'open',
    classification VARCHAR(32) NOT NULL DEFAULT 'unknown',
    title TEXT NOT NULL,
    summary TEXT,
    opened_at TIMESTAMP NOT NULL,
    detected_at TIMESTAMP,
    acknowledged_at TIMESTAMP,
    resolved_at TIMESTAMP,
    source_url TEXT,
    namespace VARCHAR(255),
    workload_kind VARCHAR(64),
    workload_name VARCHAR(255),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(source, source_incident_id)
);

CREATE INDEX IF NOT EXISTS idx_production_incidents_source ON production_incidents(source);
CREATE INDEX IF NOT EXISTS idx_production_incidents_service ON production_incidents(service_id);
CREATE INDEX IF NOT EXISTS idx_production_incidents_project ON production_incidents(gitlab_project_id);
CREATE INDEX IF NOT EXISTS idx_production_incidents_env_opened ON production_incidents(environment, opened_at);
CREATE INDEX IF NOT EXISTS idx_production_incidents_status ON production_incidents(status);
CREATE INDEX IF NOT EXISTS idx_production_incidents_severity ON production_incidents(severity);
CREATE INDEX IF NOT EXISTS idx_production_incidents_classification ON production_incidents(classification);

CREATE TABLE IF NOT EXISTS incident_events (
    id SERIAL PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES production_incidents(id) ON DELETE CASCADE,
    event_type VARCHAR(64) NOT NULL,
    status VARCHAR(32),
    message TEXT,
    happened_at TIMESTAMP NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(incident_id, event_type, happened_at)
);

CREATE INDEX IF NOT EXISTS idx_incident_events_incident ON incident_events(incident_id);
CREATE INDEX IF NOT EXISTS idx_incident_events_happened_at ON incident_events(happened_at);

CREATE TABLE IF NOT EXISTS deployment_incident_links (
    id SERIAL PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES production_incidents(id) ON DELETE CASCADE,
    deployment_id INTEGER NOT NULL REFERENCES production_deployments(id) ON DELETE CASCADE,
    confidence DECIMAL(5,2) DEFAULT 0.50,
    is_primary BOOLEAN DEFAULT FALSE,
    link_reason TEXT,
    linked_by VARCHAR(32) DEFAULT 'rule',
    linked_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(incident_id, deployment_id)
);

CREATE INDEX IF NOT EXISTS idx_deployment_incident_links_incident ON deployment_incident_links(incident_id);
CREATE INDEX IF NOT EXISTS idx_deployment_incident_links_deployment ON deployment_incident_links(deployment_id);
CREATE INDEX IF NOT EXISTS idx_deployment_incident_links_primary ON deployment_incident_links(is_primary);

COMMENT ON TABLE services IS 'Canonical service catalog for production reliability metrics';
COMMENT ON TABLE service_runtime_targets IS 'Runtime identifiers to map services to clusters, namespaces, and workloads';
COMMENT ON TABLE production_deployments IS 'Real production deployments from GitLab, ArgoCD, cluster events, or similar';
COMMENT ON TABLE deployment_changes IS 'Commit and MR lineage attached to a production deployment';
COMMENT ON TABLE production_incidents IS 'Real incidents from alerting, observability, ticketing, or manual intake';
COMMENT ON TABLE incident_events IS 'Incident timeline events such as detected, acknowledged, mitigated, and resolved';
COMMENT ON TABLE deployment_incident_links IS 'Correlation layer between incidents and production deployments';
