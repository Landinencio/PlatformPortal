/**
 * Kubernetes Metrics Service
 * 
 * Queries Prometheus/Grafana for real Kubernetes deployment data:
 * - Rollout events (kube_deployment_metadata_generation changes)
 * - Failure indicators (unavailable replicas, container restarts)
 * - ArgoCD health status
 * 
 * This gives us ground-truth deployment data independent of GitLab pipelines.
 */

import { grafanaMetricsClient } from "./grafana-metrics";
import { format, subDays, startOfDay, addDays } from "date-fns";

// Only production cluster
const PROD_CLUSTER = "dp-prod";

/** Default namespaces considered infrastructure (excluded from app metrics). */
const DEFAULT_INFRA_NAMESPACES = new Set([
  "kube-system", "cert-manager", "external-secrets", "external-dns",
  "keda", "gatekeeper-system", "aws-load-balancer-controller",
  "nfs-provisioner", "k6-operator-system", "monitoring", "prometheus",
  "kube-green", "k8sgpt-operator-system", "harbor", "argocd",
  "gitlab-runner", "pact-broker", "dependencytrack", "ollama",
  "synthetic-monitoring", "grafana", "tech-radar",
]);

/** Module-level flag to log namespace list only once. */
let _namespacesLogged = false;

/**
 * Parses a comma-separated string into a Set of trimmed, non-empty, deduplicated values.
 * Exported for testing.
 */
export function parseNamespacesEnv(envValue: string): Set<string> {
  const values = envValue
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return new Set(values);
}

/**
 * Returns the set of infrastructure namespaces to exclude from application metrics.
 * Reads from K8S_INFRA_NAMESPACES env var (comma-separated) with fallback to hardcoded defaults.
 * Logs the active namespace list on first invocation.
 */
export function getInfraNamespaces(): Set<string> {
  const envValue = process.env.K8S_INFRA_NAMESPACES;
  let namespaces: Set<string>;

  if (envValue !== undefined && envValue.trim().length > 0) {
    namespaces = parseNamespacesEnv(envValue);
  } else {
    namespaces = DEFAULT_INFRA_NAMESPACES;
  }

  if (!_namespacesLogged) {
    _namespacesLogged = true;
    console.log(
      `[k8s-metrics] Active infra namespaces (${namespaces.size}): ${[...namespaces].join(", ")}`
    );
  }

  return namespaces;
}

export interface K8sRolloutEvent {
  namespace: string;
  deployment: string;
  timestamp: Date;
  rolloutCount: number;
}

export interface K8sFailureIndicator {
  namespace: string;
  deployment: string;
  unavailableReplicas: number;
  containerRestarts: number;
}

export interface ArgoHealthSnapshot {
  appName: string;
  namespace: string;
  healthStatus: string;
  syncStatus: string;
  repo: string | null;
}

export interface K8sDailySnapshot {
  date: string;
  rollouts: K8sRolloutEvent[];
  failures: K8sFailureIndicator[];
  argoHealth: ArgoHealthSnapshot[];
  summary: {
    totalRollouts: number;
    totalDeployments: number;
    totalNamespaces: number;
    healthyApps: number;
    degradedApps: number;
    unavailableDeployments: number;
    highRestartDeployments: number;
  };
}

/**
 * Get real deployment rollouts from Kubernetes for a specific day.
 * Uses changes in kube_deployment_metadata_generation which increments
 * on every spec change (= real rollout).
 */
export async function getK8sRollouts(date: Date): Promise<K8sRolloutEvent[]> {
  const dayStart = startOfDay(date);
  const dayEnd = addDays(dayStart, 1);

  // Query generation changes in 1h windows across the day
  const result = await grafanaMetricsClient.queryRange<{
    namespace?: string;
    deployment?: string;
  }>(
    'changes(kube_deployment_metadata_generation{k8s_cluster_name="' + PROD_CLUSTER + '"}[1h])',
    { start: dayStart, end: dayEnd, step: "3600" }
  );

  const rollouts: K8sRolloutEvent[] = [];

  for (const series of result.result) {
    const ns = series.metric.namespace || "";
    const deploy = series.metric.deployment || "";

    // Skip infra namespaces
    if (getInfraNamespaces().has(ns)) continue;

    for (const [ts, val] of series.values) {
      const count = parseFloat(val);
      if (count <= 0) continue;

      rollouts.push({
        namespace: ns,
        deployment: deploy,
        timestamp: new Date(Number(ts) * 1000),
        rolloutCount: Math.round(count),
      });
    }
  }

  return rollouts;
}

/**
 * Get failure indicators: unavailable replicas and container restarts.
 * High restarts or unavailable replicas after a rollout = deployment failure.
 */
export async function getK8sFailures(date: Date): Promise<K8sFailureIndicator[]> {
  const dayStart = startOfDay(date);
  const dayEnd = addDays(dayStart, 1);

  // Unavailable replicas at end of day
  const unavailableResult = await grafanaMetricsClient.query<{
    namespace?: string;
    deployment?: string;
  }>(
    'kube_deployment_status_replicas_unavailable{k8s_cluster_name="' + PROD_CLUSTER + '"} > 0',
    { time: dayEnd }
  );

  // Container restarts during the day (increase over 24h)
  const restartsResult = await grafanaMetricsClient.query<{
    namespace?: string;
    pod?: string;
  }>(
    'increase(kube_pod_container_status_restarts_total{k8s_cluster_name="' + PROD_CLUSTER + '"}[24h]) > 5',
    { time: dayEnd }
  );

  // Build a map of namespace/deployment -> failure info
  const failureMap = new Map<string, K8sFailureIndicator>();

  for (const series of unavailableResult.result) {
    const ns = series.metric.namespace || "";
    const deploy = series.metric.deployment || "";
    if (getInfraNamespaces().has(ns)) continue;

    const key = `${ns}/${deploy}`;
    if (!failureMap.has(key)) {
      failureMap.set(key, { namespace: ns, deployment: deploy, unavailableReplicas: 0, containerRestarts: 0 });
    }
    failureMap.get(key)!.unavailableReplicas = parseInt(String(series.value[1])) || 0;
  }

  // Map pod restarts to deployments (pod name usually starts with deployment name)
  for (const series of restartsResult.result) {
    const ns = series.metric.namespace || "";
    const podName = series.metric.pod || "";
    if (getInfraNamespaces().has(ns)) continue;

    // Extract deployment name from pod (remove replicaset hash and pod hash)
    const parts = podName.split("-");
    // Deployment name is everything except last 2 segments (replicaset-hash, pod-hash)
    const deployName = parts.length > 2 ? parts.slice(0, -2).join("-") : podName;
    const key = `${ns}/${deployName}`;

    if (!failureMap.has(key)) {
      failureMap.set(key, { namespace: ns, deployment: deployName, unavailableReplicas: 0, containerRestarts: 0 });
    }
    failureMap.get(key)!.containerRestarts += Math.round(parseFloat(String(series.value[1])));
  }

  return Array.from(failureMap.values());
}

/**
 * Get ArgoCD health status for all apps.
 */
export async function getArgoHealth(date?: Date): Promise<ArgoHealthSnapshot[]> {
  const queryTime = date ? addDays(startOfDay(date), 1) : undefined;

  const result = await grafanaMetricsClient.query<{
    name?: string;
    dest_namespace?: string;
    health_status?: string;
    sync_status?: string;
    repo?: string;
  }>(
    'argocd_app_info{k8s_cluster_name="' + PROD_CLUSTER + '"}',
    queryTime ? { time: queryTime } : {}
  );

  return result.result.map((series) => ({
    appName: series.metric.name || "unknown",
    namespace: series.metric.dest_namespace || "unknown",
    healthStatus: series.metric.health_status || "Unknown",
    syncStatus: series.metric.sync_status || "Unknown",
    repo: series.metric.repo || null,
  }));
}

/**
 * Get a complete daily snapshot of K8s deployment metrics.
 */
export async function getK8sDailySnapshot(date: Date): Promise<K8sDailySnapshot> {
  const [rollouts, failures, argoHealth] = await Promise.all([
    getK8sRollouts(date),
    getK8sFailures(date),
    getArgoHealth(date),
  ]);

  const uniqueDeployments = new Set(rollouts.map((r) => `${r.namespace}/${r.deployment}`));
  const uniqueNamespaces = new Set(rollouts.map((r) => r.namespace));
  const totalRollouts = rollouts.reduce((sum, r) => sum + r.rolloutCount, 0);

  return {
    date: format(date, "yyyy-MM-dd"),
    rollouts,
    failures,
    argoHealth,
    summary: {
      totalRollouts,
      totalDeployments: uniqueDeployments.size,
      totalNamespaces: uniqueNamespaces.size,
      healthyApps: argoHealth.filter((a) => a.healthStatus === "Healthy").length,
      degradedApps: argoHealth.filter((a) => a.healthStatus === "Degraded").length,
      unavailableDeployments: failures.filter((f) => f.unavailableReplicas > 0).length,
      highRestartDeployments: failures.filter((f) => f.containerRestarts > 10).length,
    },
  };
}
