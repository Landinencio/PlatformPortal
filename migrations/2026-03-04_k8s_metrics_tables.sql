-- K8s Rollouts: Real deployment events from Kubernetes
-- Source: changes(kube_deployment_metadata_generation) from Prometheus
CREATE TABLE IF NOT EXISTS k8s_rollouts_daily (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    namespace VARCHAR(255) NOT NULL,
    deployment VARCHAR(255) NOT NULL,
    rollout_hour TIMESTAMP NOT NULL,
    rollout_count INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(snapshot_date, namespace, deployment, rollout_hour)
);

CREATE INDEX IF NOT EXISTS idx_k8s_rollouts_date ON k8s_rollouts_daily(snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_k8s_rollouts_ns_deploy ON k8s_rollouts_daily(namespace, deployment);

-- K8s Failures: Deployment health issues
-- Source: kube_deployment_status_replicas_unavailable, container restarts
CREATE TABLE IF NOT EXISTS k8s_failures_daily (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    namespace VARCHAR(255) NOT NULL,
    deployment VARCHAR(255) NOT NULL,
    unavailable_replicas INTEGER NOT NULL DEFAULT 0,
    container_restarts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(snapshot_date, namespace, deployment)
);

CREATE INDEX IF NOT EXISTS idx_k8s_failures_date ON k8s_failures_daily(snapshot_date DESC);

-- ArgoCD Health: Daily health status of all ArgoCD apps
-- Source: argocd_app_info from Prometheus
CREATE TABLE IF NOT EXISTS argocd_health_daily (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    app_name VARCHAR(255) NOT NULL,
    namespace VARCHAR(255) NOT NULL,
    health_status VARCHAR(50) NOT NULL,
    sync_status VARCHAR(50) NOT NULL,
    repo TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(snapshot_date, app_name)
);

CREATE INDEX IF NOT EXISTS idx_argocd_health_date ON argocd_health_daily(snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_argocd_health_status ON argocd_health_daily(health_status);
