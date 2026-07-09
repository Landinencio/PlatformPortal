/**
 * VPA recommendation analysis powered by VerticalPodAutoscaler CRDs exposed
 * as Prometheus metrics via a standalone kube-state-metrics + CustomResourceState
 * deployment in each cluster (see ops/k8s/ksm-vpa-standalone.yaml).
 *
 * Metrics consumed (label `k8s_cluster_name` added by Alloy):
 *   - kube_customresource_verticalpodautoscaler_recommendation_cpu_target_cores
 *   - kube_customresource_verticalpodautoscaler_recommendation_cpu_lowerbound_cores
 *   - kube_customresource_verticalpodautoscaler_recommendation_cpu_upperbound_cores
 *   - kube_customresource_verticalpodautoscaler_recommendation_memory_target_bytes
 *   - kube_customresource_verticalpodautoscaler_recommendation_memory_lowerbound_bytes
 *   - kube_customresource_verticalpodautoscaler_recommendation_memory_upperbound_bytes
 *   - kube_pod_container_resource_requests
 *   - kube_pod_container_resource_limits
 *   - kube_horizontalpodautoscaler_info  (HPA conflict detection)
 *   - node_ram_hourly_cost / node_cpu_hourly_cost (OpenCost — for savings)
 *
 * Status classification (from the Python reference script ratio_label):
 *   ratio = request / target
 *   ratio >= 3   -> SOBRE (red)         "🔴 SOBRE"
 *   ratio >= 1.5 -> sobre (amber)       "🟠 sobre"
 *   ratio >= 0.7 -> ok (green)          "🟢 ok"
 *   ratio >= 0.4 -> infra (yellow)      "🟡 infra"
 *   otherwise    -> INFRA (red)         "🔴 INFRA"
 *
 * Decisions encoded here:
 *   - Memory copy-to-yaml uses upperBound (avoids OOM)
 *   - CPU copy-to-yaml uses target (efficiency)
 *   - Sidecars (istio-proxy, linkerd-proxy, cloudsql-proxy, oauth2-proxy,
 *     vault-agent) are excluded by default; UI can opt-in.
 *   - Savings are computed using a weighted-avg node cost per cluster,
 *     reusing OpenCost data from k8s-finops (no hardcoded $/GiB).
 */

import { grafanaMetricsClient } from "@/lib/grafana-metrics";

export const VPA_HOURS_PER_MONTH = 730;

const KNOWN_SIDECARS = new Set([
  "istio-proxy",
  "linkerd-proxy",
  "cloudsql-proxy",
  "oauth2-proxy",
  "vault-agent",
  "vault-agent-init",
  "envoy",
]);

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type VpaStatus = "SOBRE" | "sobre" | "ok" | "infra" | "INFRA" | "unknown";

export interface VpaRecommendationRow {
  cluster: string;
  namespace: string;
  /** Deployment / StatefulSet / DaemonSet name from VPA targetRef. */
  workload: string;
  /** kind from targetRef (typically Deployment). */
  workloadKind: string;
  container: string;
  /** Squad/team derived from namespace (when known). null if not mapped. */
  squad: string | null;
  /** Whether the container is a known sidecar. */
  isSidecar: boolean;
  /** Whether the workload also has an HPA (potential VPA/HPA conflict). */
  hasHpa: boolean;

  // CPU
  cpuRequest: number | null; // cores
  cpuLimit: number | null;
  cpuTarget: number | null; // VPA recommendation
  cpuLower: number | null;
  cpuUpper: number | null;
  cpuRatio: number | null; // request / target (1.0 = perfect)
  cpuStatus: VpaStatus;

  // Memory
  memRequest: number | null; // bytes
  memLimit: number | null;
  memTarget: number | null;
  memLower: number | null;
  memUpper: number | null;
  memRatio: number | null;
  memStatus: VpaStatus;

  // Savings (USD/month, only memory for now since CPU pricing is more nuanced)
  potentialMemSavingsMonthly: number; // > 0 if over-provisioned, 0 otherwise
  potentialCpuSavingsMonthly: number;
  potentialTotalSavingsMonthly: number;

  // The status used for sorting / global classification (worst of the two).
  worstStatus: VpaStatus;
  worstRatio: number;
}

export interface VpaSquadAggregate {
  cluster: string;
  squad: string;
  rowCount: number;
  overprovisionedCount: number;
  underprovisionedCount: number;
  okCount: number;
  potentialMonthlySavings: number;
  totalMemRequestGb: number;
  totalMemTargetGb: number;
}

export interface VpaSummary {
  generatedAt: string;
  clusters: string[];
  /** Number of rows per status, across all selected clusters. */
  statusCounts: Record<VpaStatus, number>;
  totalPotentialMonthlySavings: number;
  rows: VpaRecommendationRow[];
  bySquad: VpaSquadAggregate[];
  /** Warnings emitted during the build (missing data, partial coverage…). */
  warnings: string[];
}

export interface VpaFilters {
  clusters?: string[]; // empty/undefined = all
  includeSidecars?: boolean; // default false
  /** Status filter applied AFTER classification. */
  statuses?: VpaStatus[];
}

// ──────────────────────────────────────────────────────────────────────────
// PromQL helpers
// ──────────────────────────────────────────────────────────────────────────

interface Sample {
  metric: Record<string, string>;
  value: [number, string];
}

async function instant(query: string): Promise<Sample[]> {
  try {
    const res = await grafanaMetricsClient.query(query);
    return res.result as unknown as Sample[];
  } catch (err) {
    console.warn("[k8s-vpa] query failed:", String(err).slice(0, 200), "::", query.replace(/\s+/g, " ").slice(0, 200));
    return [];
  }
}

function num(v: Sample | undefined): number | null {
  if (!v) return null;
  const n = Number(v.value?.[1] ?? NaN);
  return Number.isFinite(n) ? n : null;
}

// ──────────────────────────────────────────────────────────────────────────
// Classification
// ──────────────────────────────────────────────────────────────────────────

/**
 * Replicates the Python `ratio_label()` from the reference script.
 * Returns the status label and the ratio.
 */
export function classifyRatio(req: number | null, rec: number | null): { status: VpaStatus; ratio: number } {
  if (req == null || rec == null || rec <= 0) return { status: "unknown", ratio: 0 };
  const r = req / rec;
  if (r >= 3) return { status: "SOBRE", ratio: r };
  if (r >= 1.5) return { status: "sobre", ratio: r };
  if (r >= 0.7) return { status: "ok", ratio: r };
  if (r >= 0.4) return { status: "infra", ratio: r };
  return { status: "INFRA", ratio: r };
}

const STATUS_RANK: Record<VpaStatus, number> = {
  unknown: 0,
  ok: 1,
  sobre: 2,
  infra: 2,
  SOBRE: 3,
  INFRA: 3,
};

function worstOf(a: VpaStatus, b: VpaStatus): VpaStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

// ──────────────────────────────────────────────────────────────────────────
// Squad mapping (best-effort, namespace -> squad)
// ──────────────────────────────────────────────────────────────────────────
//
// We piggyback on the same heuristics used by the rest of the portal.
// A more exhaustive mapping lives in `k8s_workload_mapping` table; we keep
// this lightweight in-memory map for the v1 dashboard so we don't add a DB
// hop per request.
const NAMESPACE_TO_SQUAD: Record<string, string> = {
  oms: "OMS",
  "oms-erp-connector": "OMS",
  basket: "Digital",
  checkout: "Digital",
  payments: "Digital",
  loyalty: "Digital",
  customers: "Digital",
  products: "Digital",
  pricing: "Digital",
  shipping: "Digital",
  returns: "Digital",
  stores: "Digital",
  marketplace: "Marketplace",
  auth: "Digital",
  identifiers: "Digital",
  comerzzia: "Comerzzia",
  czz: "Comerzzia",
  animalis: "Animalis",
  helios: "Helios",
  websites: "Frontend",
  "front-vue": "Frontend",
  "vue-ssr": "Frontend",
  mobile: "Mobile",
  core: "Core",
  "data-science": "Data",
  // Tooling
  argocd: "SRE",
  "cloud-agent": "SRE",
  "cert-manager": "SRE",
  "kube-system": "SRE",
  monitoring: "SRE",
  prometheus: "SRE",
  promtail: "SRE",
  "ingress-nginx": "SRE",
  karpenter: "SRE",
  awx: "SRE",
  "awx-ansible": "SRE",
  harbor: "SRE",
  sonarqube: "SRE",
  grafana: "SRE",
  "external-secrets": "SRE",
  crossplane: "SRE",
  keda: "SRE",
  n8n: "SRE",
  "synthetic-monitoring": "SRE",
  dependencytrack: "SRE",
  mattermost: "SRE",
  "tech-radar": "SRE",
  platformportal: "SRE",
  "k6-tests": "SRE",
};

function squadFor(namespace: string): string | null {
  return NAMESPACE_TO_SQUAD[namespace] ?? null;
}

// ──────────────────────────────────────────────────────────────────────────
// Data fetchers
// ──────────────────────────────────────────────────────────────────────────

interface VpaRecommendationSet {
  cpuTarget: number | null;
  cpuLower: number | null;
  cpuUpper: number | null;
  memTarget: number | null;
  memLower: number | null;
  memUpper: number | null;
  workloadKind: string;
  workload: string;
}

const VPA_KEY = (cluster: string, namespace: string, workload: string, container: string) =>
  `${cluster}|${namespace}|${workload}|${container}`;

async function fetchVpaRecommendations(): Promise<Map<string, VpaRecommendationSet>> {
  // Six metrics with the same label set; we merge them by (cluster, namespace,
  // target_name, container).
  const metrics: Array<[string, "cpuTarget" | "cpuLower" | "cpuUpper" | "memTarget" | "memLower" | "memUpper"]> = [
    ["kube_customresource_verticalpodautoscaler_recommendation_cpu_target_cores", "cpuTarget"],
    ["kube_customresource_verticalpodautoscaler_recommendation_cpu_lowerbound_cores", "cpuLower"],
    ["kube_customresource_verticalpodautoscaler_recommendation_cpu_upperbound_cores", "cpuUpper"],
    ["kube_customresource_verticalpodautoscaler_recommendation_memory_target_bytes", "memTarget"],
    ["kube_customresource_verticalpodautoscaler_recommendation_memory_lowerbound_bytes", "memLower"],
    ["kube_customresource_verticalpodautoscaler_recommendation_memory_upperbound_bytes", "memUpper"],
  ];
  const out = new Map<string, VpaRecommendationSet>();

  for (const [metric, field] of metrics) {
    const samples = await instant(metric);
    for (const s of samples) {
      const cluster = s.metric.k8s_cluster_name || s.metric.cluster || "unknown";
      const namespace = s.metric.namespace || "";
      const workload = s.metric.target_name || s.metric.target || "";
      const container = s.metric.container || "";
      const workloadKind = s.metric.target_kind || "Deployment";
      if (!namespace || !workload || !container) continue;

      const k = VPA_KEY(cluster, namespace, workload, container);
      let entry = out.get(k);
      if (!entry) {
        entry = {
          cpuTarget: null,
          cpuLower: null,
          cpuUpper: null,
          memTarget: null,
          memLower: null,
          memUpper: null,
          workloadKind,
          workload,
        };
        out.set(k, entry);
      }
      entry[field] = num(s);
      if (workloadKind) entry.workloadKind = workloadKind;
    }
  }

  return out;
}

interface PodResourceMap {
  // (cluster|namespace|workload|container) -> { request, limit }
  cpuRequest: Map<string, number>;
  cpuLimit: Map<string, number>;
  memRequest: Map<string, number>;
  memLimit: Map<string, number>;
}

/**
 * Fetch container request/limit from kube_pod_container_resource_{requests,limits}
 * and pivot from `pod` to a workload key. We use a small heuristic to derive the
 * workload name from the pod name (same approach as k8s-finops).
 *
 * NOTE: VPA uses targetRef which yields the *deployment* name. The metric
 * `kube_pod_container_resource_requests` carries `pod` (replica). We strip the
 * trailing replicaset hash + pod hash to recover the deployment name, then
 * compare against the VPA target name with substring fallback (some workloads
 * embed extra prefixes in their pod template).
 */
function podToWorkload(pod: string): string {
  if (!pod) return "";
  return pod
    .replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, "")
    .replace(/-[a-z0-9]{5}$/, "")
    .replace(/-\d+$/, "");
}

async function fetchPodResources(): Promise<PodResourceMap> {
  const cpuReqQ = `avg by (k8s_cluster_name, namespace, pod, container) (kube_pod_container_resource_requests{resource="cpu"})`;
  const cpuLimQ = `avg by (k8s_cluster_name, namespace, pod, container) (kube_pod_container_resource_limits{resource="cpu"})`;
  const memReqQ = `avg by (k8s_cluster_name, namespace, pod, container) (kube_pod_container_resource_requests{resource="memory"})`;
  const memLimQ = `avg by (k8s_cluster_name, namespace, pod, container) (kube_pod_container_resource_limits{resource="memory"})`;

  const [cpuReq, cpuLim, memReq, memLim] = await Promise.all([
    instant(cpuReqQ),
    instant(cpuLimQ),
    instant(memReqQ),
    instant(memLimQ),
  ]);

  const build = (samples: Sample[]) => {
    // Group by (cluster|namespace|workload|container) averaging across pods.
    const acc = new Map<string, { sum: number; count: number }>();
    for (const s of samples) {
      const cluster = s.metric.k8s_cluster_name || "unknown";
      const namespace = s.metric.namespace || "";
      const pod = s.metric.pod || "";
      const container = s.metric.container || "";
      if (!namespace || !pod || !container) continue;
      const workload = podToWorkload(pod);
      const k = VPA_KEY(cluster, namespace, workload, container);
      const v = num(s);
      if (v == null) continue;
      const cur = acc.get(k) ?? { sum: 0, count: 0 };
      cur.sum += v;
      cur.count += 1;
      acc.set(k, cur);
    }
    const out = new Map<string, number>();
    for (const [k, v] of acc) out.set(k, v.count > 0 ? v.sum / v.count : 0);
    return out;
  };

  return {
    cpuRequest: build(cpuReq),
    cpuLimit: build(cpuLim),
    memRequest: build(memReq),
    memLimit: build(memLim),
  };
}

async function fetchHpaSet(): Promise<Set<string>> {
  // Returns a set of `cluster|namespace|workload` keys for any workload that
  // has an HPA pointing at it.
  const samples = await instant(`kube_horizontalpodautoscaler_info`);
  const out = new Set<string>();
  for (const s of samples) {
    const cluster = s.metric.k8s_cluster_name || "unknown";
    const namespace = s.metric.namespace || "";
    const targetName = s.metric.scaletargetref_name || s.metric.target_name || "";
    if (!namespace || !targetName) continue;
    out.add(`${cluster}|${namespace}|${targetName}`);
  }
  return out;
}

/**
 * Get a per-cluster weighted-average $/GiB-month for memory and $/core-month for CPU.
 * We use the OpenCost node hourly costs (already validated in the EKS Allocation tab).
 */
async function fetchUnitCostsByCluster(): Promise<Map<string, { memUsdPerGbMonth: number; cpuUsdPerCoreMonth: number }>> {
  // node_cpu_hourly_cost / node_ram_hourly_cost are emitted per node by OpenCost.
  // Compute weighted-average across nodes per cluster.
  const cpuQ = `avg by (k8s_cluster_name) (node_cpu_hourly_cost)`;
  const ramQ = `avg by (k8s_cluster_name) (node_ram_hourly_cost)`;
  const [cpu, ram] = await Promise.all([instant(cpuQ), instant(ramQ)]);
  const out = new Map<string, { memUsdPerGbMonth: number; cpuUsdPerCoreMonth: number }>();
  for (const s of cpu) {
    const cluster = s.metric.k8s_cluster_name || "unknown";
    const v = num(s) ?? 0;
    const cur = out.get(cluster) ?? { memUsdPerGbMonth: 0, cpuUsdPerCoreMonth: 0 };
    cur.cpuUsdPerCoreMonth = v * VPA_HOURS_PER_MONTH;
    out.set(cluster, cur);
  }
  for (const s of ram) {
    const cluster = s.metric.k8s_cluster_name || "unknown";
    const v = num(s) ?? 0;
    const cur = out.get(cluster) ?? { memUsdPerGbMonth: 0, cpuUsdPerCoreMonth: 0 };
    cur.memUsdPerGbMonth = v * VPA_HOURS_PER_MONTH;
    out.set(cluster, cur);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

export async function fetchVpaSummary(filters: VpaFilters = {}): Promise<VpaSummary> {
  const includeSidecars = filters.includeSidecars ?? false;
  const clusterFilter = filters.clusters && filters.clusters.length > 0 ? new Set(filters.clusters) : null;

  const [recs, podRes, hpas, unitCosts] = await Promise.all([
    fetchVpaRecommendations(),
    fetchPodResources(),
    fetchHpaSet(),
    fetchUnitCostsByCluster(),
  ]);

  const warnings: string[] = [];
  if (recs.size === 0) {
    warnings.push(
      "No hay recomendaciones VPA disponibles. Verifica que el VPA recommender esté desplegado y que las métricas kube_customresource_verticalpodautoscaler_* lleguen a Grafana Cloud.",
    );
  }

  const rows: VpaRecommendationRow[] = [];
  for (const [key, rec] of recs) {
    const [cluster, namespace, workload, container] = key.split("|");
    if (clusterFilter && !clusterFilter.has(cluster)) continue;
    const isSidecar = KNOWN_SIDECARS.has(container);
    if (!includeSidecars && isSidecar) continue;

    const cpuReq = podRes.cpuRequest.get(key) ?? null;
    const cpuLim = podRes.cpuLimit.get(key) ?? null;
    const memReq = podRes.memRequest.get(key) ?? null;
    const memLim = podRes.memLimit.get(key) ?? null;

    const cpu = classifyRatio(cpuReq, rec.cpuTarget);
    const mem = classifyRatio(memReq, rec.memTarget);

    const unit = unitCosts.get(cluster) ?? { memUsdPerGbMonth: 0, cpuUsdPerCoreMonth: 0 };

    let memSavings = 0;
    if (memReq != null && rec.memTarget != null && memReq > rec.memTarget) {
      // Save the difference, in GB-month.
      const diffGb = (memReq - rec.memTarget) / (1024 * 1024 * 1024);
      memSavings = Math.max(0, diffGb * unit.memUsdPerGbMonth);
    }

    let cpuSavings = 0;
    if (cpuReq != null && rec.cpuTarget != null && cpuReq > rec.cpuTarget) {
      cpuSavings = Math.max(0, (cpuReq - rec.cpuTarget) * unit.cpuUsdPerCoreMonth);
    }

    const worst = worstOf(cpu.status, mem.status);
    const worstRatio = Math.max(
      mem.status !== "unknown" ? mem.ratio : 0,
      cpu.status !== "unknown" ? cpu.ratio : 0,
    );

    const hasHpa = hpas.has(`${cluster}|${namespace}|${workload}`);

    rows.push({
      cluster,
      namespace,
      workload,
      workloadKind: rec.workloadKind || "Deployment",
      container,
      squad: squadFor(namespace),
      isSidecar,
      hasHpa,
      cpuRequest: cpuReq,
      cpuLimit: cpuLim,
      cpuTarget: rec.cpuTarget,
      cpuLower: rec.cpuLower,
      cpuUpper: rec.cpuUpper,
      cpuRatio: cpu.status === "unknown" ? null : cpu.ratio,
      cpuStatus: cpu.status,
      memRequest: memReq,
      memLimit: memLim,
      memTarget: rec.memTarget,
      memLower: rec.memLower,
      memUpper: rec.memUpper,
      memRatio: mem.status === "unknown" ? null : mem.ratio,
      memStatus: mem.status,
      potentialMemSavingsMonthly: Math.round(memSavings * 100) / 100,
      potentialCpuSavingsMonthly: Math.round(cpuSavings * 100) / 100,
      potentialTotalSavingsMonthly: Math.round((memSavings + cpuSavings) * 100) / 100,
      worstStatus: worst,
      worstRatio,
    });
  }

  // Apply status filter if any
  const filtered = filters.statuses && filters.statuses.length > 0
    ? rows.filter((r) => filters.statuses!.includes(r.worstStatus))
    : rows;

  // Sort: worst-status-first, then highest savings.
  filtered.sort((a, b) => {
    const ds = STATUS_RANK[b.worstStatus] - STATUS_RANK[a.worstStatus];
    if (ds !== 0) return ds;
    return b.potentialTotalSavingsMonthly - a.potentialTotalSavingsMonthly;
  });

  // Build per-status counts.
  const statusCounts: Record<VpaStatus, number> = {
    SOBRE: 0,
    sobre: 0,
    ok: 0,
    infra: 0,
    INFRA: 0,
    unknown: 0,
  };
  for (const r of filtered) statusCounts[r.worstStatus]++;

  // Squad aggregates
  const squadAcc = new Map<string, VpaSquadAggregate>();
  for (const r of filtered) {
    if (!r.squad) continue;
    const k = `${r.cluster}|${r.squad}`;
    let cur = squadAcc.get(k);
    if (!cur) {
      cur = {
        cluster: r.cluster,
        squad: r.squad,
        rowCount: 0,
        overprovisionedCount: 0,
        underprovisionedCount: 0,
        okCount: 0,
        potentialMonthlySavings: 0,
        totalMemRequestGb: 0,
        totalMemTargetGb: 0,
      };
      squadAcc.set(k, cur);
    }
    cur.rowCount++;
    if (r.worstStatus === "SOBRE" || r.worstStatus === "sobre") cur.overprovisionedCount++;
    else if (r.worstStatus === "INFRA" || r.worstStatus === "infra") cur.underprovisionedCount++;
    else if (r.worstStatus === "ok") cur.okCount++;
    cur.potentialMonthlySavings += r.potentialTotalSavingsMonthly;
    if (r.memRequest != null) cur.totalMemRequestGb += r.memRequest / (1024 * 1024 * 1024);
    if (r.memTarget != null) cur.totalMemTargetGb += r.memTarget / (1024 * 1024 * 1024);
  }
  const bySquad = Array.from(squadAcc.values()).sort((a, b) => b.potentialMonthlySavings - a.potentialMonthlySavings);
  for (const s of bySquad) {
    s.potentialMonthlySavings = Math.round(s.potentialMonthlySavings * 100) / 100;
    s.totalMemRequestGb = Math.round(s.totalMemRequestGb * 100) / 100;
    s.totalMemTargetGb = Math.round(s.totalMemTargetGb * 100) / 100;
  }

  const totalSavings = filtered.reduce((s, r) => s + r.potentialTotalSavingsMonthly, 0);
  const clusters = Array.from(new Set(filtered.map((r) => r.cluster))).sort();

  return {
    generatedAt: new Date().toISOString(),
    clusters,
    statusCounts,
    totalPotentialMonthlySavings: Math.round(totalSavings * 100) / 100,
    rows: filtered,
    bySquad,
    warnings,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// YAML helper for "copy suggested values"
// ──────────────────────────────────────────────────────────────────────────

/**
 * Convert bytes to a human Mi/Gi suffix used in k8s manifests.
 * We round upward to a sensible step (8Mi for memory, 50m for CPU).
 */
function fmtBytesK8s(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${Math.ceil(bytes / (1024 * 1024 * 1024) * 10) / 10}Gi`;
  }
  // round up to next 16Mi
  const mib = bytes / (1024 * 1024);
  const stepped = Math.ceil(mib / 16) * 16;
  return `${stepped}Mi`;
}

function fmtCoresK8s(cores: number): string {
  if (cores >= 1) return `${Math.round(cores * 100) / 100}`;
  // millicores, round up to 25m
  const milli = Math.ceil(cores * 1000 / 25) * 25;
  return `${milli}m`;
}

/**
 * Build a YAML snippet ready to paste under `resources:` of a Helm chart values
 * file. Memory uses upperBound (defensive against OOM); CPU uses target (cost).
 */
export function buildResourcesYaml(row: VpaRecommendationRow): string {
  const cpuReq = row.cpuTarget != null ? fmtCoresK8s(row.cpuTarget) : null;
  const memReq = row.memUpper != null
    ? fmtBytesK8s(row.memUpper)
    : row.memTarget != null
      ? fmtBytesK8s(row.memTarget)
      : null;
  // Default limit policy: cpu = no limit, memory = upperBound (or 1.5x of request as fallback).
  const memLim = memReq;
  const lines: string[] = [];
  lines.push(`# VPA recommendation for ${row.namespace}/${row.workload} (${row.container})`);
  lines.push(`# cluster=${row.cluster} status_cpu=${row.cpuStatus} status_mem=${row.memStatus}`);
  lines.push(`resources:`);
  lines.push(`  requests:`);
  if (cpuReq) lines.push(`    cpu: ${cpuReq}`);
  if (memReq) lines.push(`    memory: ${memReq}`);
  if (memLim) {
    lines.push(`  limits:`);
    lines.push(`    memory: ${memLim}`);
  }
  return lines.join("\n");
}
