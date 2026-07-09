/**
 * Kubernetes FinOps service powered by OpenCost (Grafana Cloud Prometheus).
 *
 * Source metrics (job=integrations/opencost):
 * - node_total_hourly_cost / node_cpu_hourly_cost / node_ram_hourly_cost
 * - container_cpu_allocation / container_memory_allocation_bytes
 * - container_cpu_usage_seconds_total / container_memory_working_set_bytes (cAdvisor)
 * - kubecost_cluster_management_cost
 * - kubecost_network_{internet,region,zone}_egress_cost
 * - kubecost_load_balancer_cost
 * - kubecost_node_is_spot
 *
 * All costs from OpenCost are USD/hour. We multiply by HOURS_PER_MONTH for
 * monthly run-rate.
 */

import { grafanaMetricsClient } from "@/lib/grafana-metrics";

const HOURS_PER_MONTH = 730; // standard cloud convention

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface ClusterCostBreakdown {
  cluster: string;
  nodeCpuCostHourly: number;
  nodeRamCostHourly: number;
  nodeTotalCostHourly: number;
  mgmtCostHourly: number;
  loadBalancerCostHourly: number;
  egressCostHourly: number;
  egressInternetHourly: number;
  egressRegionHourly: number;
  egressZoneHourly: number;
  totalCostHourly: number;
  totalCostMonthly: number;
  nodeCount: number;
  spotNodeCount: number;
  spotCoveragePct: number;
  cpuAllocatableCores: number;
  cpuAllocatedCores: number;
  cpuUsedCores: number;
  cpuEfficiencyPct: number;
  ramAllocatableGb: number;
  ramAllocatedGb: number;
  ramUsedGb: number;
  ramEfficiencyPct: number;
}

export interface NamespaceAllocation {
  cluster: string;
  namespace: string;
  cpuCostHourly: number;
  ramCostHourly: number;
  totalCostHourly: number;
  totalCostMonthly: number;
  cpuAllocatedCores: number;
  cpuUsedCores: number;
  cpuEfficiencyPct: number;
  ramAllocatedGb: number;
  ramUsedGb: number;
  ramEfficiencyPct: number;
  wasteCostMonthly: number;
}

export interface WorkloadAllocation {
  cluster: string;
  namespace: string;
  workload: string;
  cpuCostHourly: number;
  ramCostHourly: number;
  totalCostHourly: number;
  totalCostMonthly: number;
  podCount: number;
}

export interface LoadBalancerCost {
  cluster: string;
  ingress: string;
  hourly: number;
  monthly: number;
}

export interface RightsizingCandidate {
  cluster: string;
  namespace: string;
  workload: string;
  cpuAllocatedCores: number;
  cpuUsedCores: number;
  cpuEfficiencyPct: number;
  ramAllocatedGb: number;
  ramUsedGb: number;
  ramEfficiencyPct: number;
  monthlyCost: number;
  potentialMonthlySavings: number;
}

export interface K8sFinOpsSummary {
  generatedAt: string;
  totalHourly: number;
  totalMonthly: number;
  totalEgressMonthly: number;
  totalLoadBalancersMonthly: number;
  totalMgmtMonthly: number;
  clusters: ClusterCostBreakdown[];
  topNamespaces: NamespaceAllocation[];
  topWorkloads: WorkloadAllocation[];
  topLoadBalancers: LoadBalancerCost[];
  rightsizingCandidates: RightsizingCandidate[];
  warnings: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

interface VectorSample {
  metric: Record<string, string>;
  value: [number | string, string];
}

async function instant(query: string): Promise<VectorSample[]> {
  try {
    const res = await grafanaMetricsClient.query(query);
    return res.result as unknown as VectorSample[];
  } catch (err) {
    console.warn("[k8s-finops] query failed:", String(err).slice(0, 200), "::", query.replace(/\s+/g, " ").slice(0, 200));
    return [];
  }
}

function num(v: VectorSample | undefined): number {
  if (!v) return 0;
  const n = Number(v.value?.[1] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function indexBy<T>(items: T[], key: (item: T) => string | undefined): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    if (k) map.set(k, item);
  }
  return map;
}

function pct(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

/**
 * Strip the trailing replicaset hash + pod hash from a pod name to recover the
 * workload name. Examples:
 *   `oms-orders-api-7d8f9b8c4-xyz12` -> `oms-orders-api`
 *   `kube-proxy-abc12`               -> `kube-proxy`
 *   `prometheus-0`                   -> `prometheus`
 */
function podToWorkload(pod: string): string {
  if (!pod) return "";
  // Strip `-<10char hash>-<5char hash>` (deployment + replicaset)
  const trimmed = pod.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, "")
    // Strip plain `-<5char hash>` (job/cronjob)
    .replace(/-[a-z0-9]{5}$/, "")
    // Strip `-N` (statefulset ordinal)
    .replace(/-\d+$/, "");
  return trimmed || pod;
}

// ──────────────────────────────────────────────────────────────────────────
// Cluster level
// ──────────────────────────────────────────────────────────────────────────

async function fetchClusterBreakdown(): Promise<ClusterCostBreakdown[]> {
  const queries = {
    nodeCpu: 'sum by (k8s_cluster_name) (node_cpu_hourly_cost)',
    nodeRam: 'sum by (k8s_cluster_name) (node_ram_hourly_cost)',
    nodeTotal: 'sum by (k8s_cluster_name) (node_total_hourly_cost)',
    mgmt: 'sum by (k8s_cluster_name) (kubecost_cluster_management_cost)',
    lb: 'sum by (k8s_cluster_name) (kubecost_load_balancer_cost)',
    egressInternet: 'sum by (k8s_cluster_name) (kubecost_network_internet_egress_cost)',
    egressRegion: 'sum by (k8s_cluster_name) (kubecost_network_region_egress_cost)',
    egressZone: 'sum by (k8s_cluster_name) (kubecost_network_zone_egress_cost)',
    nodeCount: 'count by (k8s_cluster_name) (node_total_hourly_cost)',
    spotCount: 'count by (k8s_cluster_name) (kubecost_node_is_spot > 0)',
    cpuAllocatable: 'sum by (k8s_cluster_name) (kube_node_status_allocatable{resource="cpu"})',
    ramAllocatable: 'sum by (k8s_cluster_name) (kube_node_status_allocatable{resource="memory"} / (1024*1024*1024))',
    cpuAllocated:
      'sum by (k8s_cluster_name) (avg by (k8s_cluster_name, namespace, pod, container) (container_cpu_allocation))',
    ramAllocated:
      'sum by (k8s_cluster_name) (avg by (k8s_cluster_name, namespace, pod, container) (container_memory_allocation_bytes / (1024*1024*1024)))',
    cpuUsed:
      'sum by (k8s_cluster_name) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[1h]))',
    ramUsed:
      'sum by (k8s_cluster_name) (container_memory_working_set_bytes{container!="",container!="POD"} / (1024*1024*1024))',
  };

  const results = await Promise.all(
    Object.entries(queries).map(async ([k, q]) => [k, await instant(q)] as const),
  );
  const data = Object.fromEntries(results) as Record<keyof typeof queries, VectorSample[]>;

  // Discover all clusters
  const clusters = new Set<string>();
  for (const arr of Object.values(data)) {
    for (const s of arr) {
      const c = s.metric.k8s_cluster_name;
      if (c) clusters.add(c);
    }
  }

  const idx = (key: keyof typeof queries) => indexBy(data[key], (s) => s.metric.k8s_cluster_name);
  const indexes = {
    nodeCpu: idx("nodeCpu"),
    nodeRam: idx("nodeRam"),
    nodeTotal: idx("nodeTotal"),
    mgmt: idx("mgmt"),
    lb: idx("lb"),
    egressInternet: idx("egressInternet"),
    egressRegion: idx("egressRegion"),
    egressZone: idx("egressZone"),
    nodeCount: idx("nodeCount"),
    spotCount: idx("spotCount"),
    cpuAllocatable: idx("cpuAllocatable"),
    ramAllocatable: idx("ramAllocatable"),
    cpuAllocated: idx("cpuAllocated"),
    ramAllocated: idx("ramAllocated"),
    cpuUsed: idx("cpuUsed"),
    ramUsed: idx("ramUsed"),
  };

  const breakdowns: ClusterCostBreakdown[] = [];
  for (const cluster of [...clusters].sort()) {
    const get = (key: keyof typeof queries) => num(indexes[key].get(cluster));
    const nodeCpu = get("nodeCpu");
    const nodeRam = get("nodeRam");
    const nodeTotal = get("nodeTotal");
    const mgmt = get("mgmt");
    const lb = get("lb");
    const eInternet = get("egressInternet");
    const eRegion = get("egressRegion");
    const eZone = get("egressZone");
    const egress = eInternet + eRegion + eZone;
    const totalHourly = nodeTotal + mgmt + lb + egress;
    const cpuAllocatable = get("cpuAllocatable");
    const cpuAllocated = get("cpuAllocated");
    const cpuUsed = get("cpuUsed");
    const ramAllocatable = get("ramAllocatable");
    const ramAllocated = get("ramAllocated");
    const ramUsed = get("ramUsed");

    breakdowns.push({
      cluster,
      nodeCpuCostHourly: nodeCpu,
      nodeRamCostHourly: nodeRam,
      nodeTotalCostHourly: nodeTotal,
      mgmtCostHourly: mgmt,
      loadBalancerCostHourly: lb,
      egressCostHourly: egress,
      egressInternetHourly: eInternet,
      egressRegionHourly: eRegion,
      egressZoneHourly: eZone,
      totalCostHourly: totalHourly,
      totalCostMonthly: totalHourly * HOURS_PER_MONTH,
      nodeCount: Math.round(get("nodeCount")),
      spotNodeCount: Math.round(get("spotCount")),
      spotCoveragePct: pct(get("spotCount"), get("nodeCount")),
      cpuAllocatableCores: cpuAllocatable,
      cpuAllocatedCores: cpuAllocated,
      cpuUsedCores: cpuUsed,
      cpuEfficiencyPct: pct(cpuUsed, cpuAllocated),
      ramAllocatableGb: ramAllocatable,
      ramAllocatedGb: ramAllocated,
      ramUsedGb: ramUsed,
      ramEfficiencyPct: pct(ramUsed, ramAllocated),
    });
  }

  return breakdowns;
}

// ──────────────────────────────────────────────────────────────────────────
// Namespace allocation
// ──────────────────────────────────────────────────────────────────────────

async function fetchNamespaceAllocation(): Promise<NamespaceAllocation[]> {
  // CPU cost: cores * $/core/h
  const cpuCostQ = `
    sum by (k8s_cluster_name, namespace) (
      avg by (k8s_cluster_name, namespace, pod, container, node) (container_cpu_allocation)
      * on (k8s_cluster_name, node) group_left()
        avg by (k8s_cluster_name, node) (node_cpu_hourly_cost)
    )`;
  // RAM cost: bytes * ($/GB/h) / GB-bytes — division MUST be inside sum-by to preserve labels
  const ramCostQ = `
    sum by (k8s_cluster_name, namespace) (
      avg by (k8s_cluster_name, namespace, pod, container, node) (container_memory_allocation_bytes / (1024*1024*1024))
      * on (k8s_cluster_name, node) group_left()
        avg by (k8s_cluster_name, node) (node_ram_hourly_cost)
    )`;
  const cpuAllocQ =
    'sum by (k8s_cluster_name, namespace) (avg by (k8s_cluster_name, namespace, pod, container) (container_cpu_allocation))';
  const ramAllocQ =
    'sum by (k8s_cluster_name, namespace) (avg by (k8s_cluster_name, namespace, pod, container) (container_memory_allocation_bytes / (1024*1024*1024)))';
  const cpuUsedQ =
    'sum by (k8s_cluster_name, namespace) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[1h]))';
  const ramUsedQ =
    'sum by (k8s_cluster_name, namespace) (container_memory_working_set_bytes{container!="",container!="POD"} / (1024*1024*1024))';

  const [cpuCost, ramCost, cpuAlloc, ramAlloc, cpuUsed, ramUsed] = await Promise.all(
    [cpuCostQ, ramCostQ, cpuAllocQ, ramAllocQ, cpuUsedQ, ramUsedQ].map(instant),
  );

  const key = (s: VectorSample) => `${s.metric.k8s_cluster_name}::${s.metric.namespace}`;
  const idx = {
    cpuCost: indexBy(cpuCost, key),
    ramCost: indexBy(ramCost, key),
    cpuAlloc: indexBy(cpuAlloc, key),
    ramAlloc: indexBy(ramAlloc, key),
    cpuUsed: indexBy(cpuUsed, key),
    ramUsed: indexBy(ramUsed, key),
  };

  const keys = new Set<string>();
  for (const m of Object.values(idx)) for (const k of m.keys()) keys.add(k);

  const out: NamespaceAllocation[] = [];
  for (const k of keys) {
    const [cluster, namespace] = k.split("::");
    if (!cluster || !namespace) continue;
    const cpuC = num(idx.cpuCost.get(k));
    const ramC = num(idx.ramCost.get(k));
    const total = cpuC + ramC;
    if (total <= 0) continue;
    const cpuA = num(idx.cpuAlloc.get(k));
    const ramA = num(idx.ramAlloc.get(k));
    const cpuU = num(idx.cpuUsed.get(k));
    const ramU = num(idx.ramUsed.get(k));
    const cpuEff = pct(cpuU, cpuA);
    const ramEff = pct(ramU, ramA);
    const wasteCpuFrac = cpuA > 0 ? Math.max(0, (cpuA - cpuU) / cpuA) : 0;
    const wasteRamFrac = ramA > 0 ? Math.max(0, (ramA - ramU) / ramA) : 0;
    const wasteHourly = cpuC * wasteCpuFrac + ramC * wasteRamFrac;

    out.push({
      cluster,
      namespace,
      cpuCostHourly: cpuC,
      ramCostHourly: ramC,
      totalCostHourly: total,
      totalCostMonthly: total * HOURS_PER_MONTH,
      cpuAllocatedCores: cpuA,
      cpuUsedCores: cpuU,
      cpuEfficiencyPct: cpuEff,
      ramAllocatedGb: ramA,
      ramUsedGb: ramU,
      ramEfficiencyPct: ramEff,
      wasteCostMonthly: wasteHourly * HOURS_PER_MONTH,
    });
  }

  out.sort((a, b) => b.totalCostMonthly - a.totalCostMonthly);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Workload allocation (per pod, then aggregated by stripped name)
// ──────────────────────────────────────────────────────────────────────────

async function fetchWorkloadAllocation(): Promise<WorkloadAllocation[]> {
  // Pod-level CPU cost
  const cpuQ = `
    sum by (k8s_cluster_name, namespace, pod) (
      avg by (k8s_cluster_name, namespace, pod, container, node) (container_cpu_allocation)
      * on (k8s_cluster_name, node) group_left()
        avg by (k8s_cluster_name, node) (node_cpu_hourly_cost)
    )`;
  const ramQ = `
    sum by (k8s_cluster_name, namespace, pod) (
      avg by (k8s_cluster_name, namespace, pod, container, node) (container_memory_allocation_bytes / (1024*1024*1024))
      * on (k8s_cluster_name, node) group_left()
        avg by (k8s_cluster_name, node) (node_ram_hourly_cost)
    )`;

  const [cpu, ram] = await Promise.all([instant(cpuQ), instant(ramQ)]);

  type Bucket = {
    cluster: string;
    namespace: string;
    workload: string;
    cpu: number;
    ram: number;
    pods: Set<string>;
  };
  const buckets = new Map<string, Bucket>();

  function add(s: VectorSample, kind: "cpu" | "ram") {
    const cluster = s.metric.k8s_cluster_name;
    const namespace = s.metric.namespace;
    const pod = s.metric.pod;
    const value = num(s);
    if (!cluster || !namespace || !pod || value <= 0) return;
    const workload = podToWorkload(pod);
    const key = `${cluster}::${namespace}::${workload}`;
    let b = buckets.get(key);
    if (!b) {
      b = { cluster, namespace, workload, cpu: 0, ram: 0, pods: new Set() };
      buckets.set(key, b);
    }
    if (kind === "cpu") b.cpu += value;
    else b.ram += value;
    b.pods.add(pod);
  }

  for (const s of cpu) add(s, "cpu");
  for (const s of ram) add(s, "ram");

  const out: WorkloadAllocation[] = [...buckets.values()]
    .map((b) => {
      const total = b.cpu + b.ram;
      return {
        cluster: b.cluster,
        namespace: b.namespace,
        workload: b.workload,
        cpuCostHourly: b.cpu,
        ramCostHourly: b.ram,
        totalCostHourly: total,
        totalCostMonthly: total * HOURS_PER_MONTH,
        podCount: b.pods.size,
      };
    })
    .filter((w) => w.totalCostMonthly > 0)
    .sort((a, b) => b.totalCostMonthly - a.totalCostMonthly);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Load balancers
// ──────────────────────────────────────────────────────────────────────────

async function fetchLoadBalancers(): Promise<LoadBalancerCost[]> {
  const samples = await instant(
    'sum by (k8s_cluster_name, ingress_ip) (kubecost_load_balancer_cost)',
  );
  return samples
    .map((s) => {
      const hourly = num(s);
      return {
        cluster: s.metric.k8s_cluster_name || "unknown",
        ingress: s.metric.ingress_ip || "(no ingress label)",
        hourly,
        monthly: hourly * HOURS_PER_MONTH,
      };
    })
    .filter((lb) => lb.hourly > 0)
    .sort((a, b) => b.monthly - a.monthly);
}

// ──────────────────────────────────────────────────────────────────────────
// Rightsizing candidates (workload-level, simple heuristic)
// ──────────────────────────────────────────────────────────────────────────

async function fetchRightsizingCandidates(): Promise<RightsizingCandidate[]> {
  // Use 7-day p95 of real usage instead of instant rate average.
  // Floor for CPU = 100m (0.1 cores), for RAM = 0.125 GiB (128Mi).
  // Headroom CPU = 50% (target = p95 / 0.5 = p95*2), RAM = 30% (target = p95 / 0.7 = p95*1.43).
  // Cap savings at 70% of current cost (>70% means workload is essentially idle and needs human review).
  const cpuAllocQ =
    'sum by (k8s_cluster_name, namespace, pod) (avg by (k8s_cluster_name, namespace, pod, container) (container_cpu_allocation))';
  const ramAllocQ =
    'sum by (k8s_cluster_name, namespace, pod) (avg by (k8s_cluster_name, namespace, pod, container) (container_memory_allocation_bytes / (1024*1024*1024)))';
  // p95 over 7 days (cores)
  const cpuP95Q =
    'sum by (k8s_cluster_name, namespace, pod) (quantile_over_time(0.95, rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])[7d:5m]))';
  // p95 over 7 days (GiB)
  const ramP95Q =
    'sum by (k8s_cluster_name, namespace, pod) (quantile_over_time(0.95, container_memory_working_set_bytes{container!="",container!="POD"}[7d]) / (1024*1024*1024))';
  // Pod uptime (seconds in last 7d) — used to filter ephemeral jobs/cronjobs
  const upQ =
    'sum by (k8s_cluster_name, namespace, pod) (count_over_time(kube_pod_info[7d]) * 60)';
  const cpuCostQ = `
    sum by (k8s_cluster_name, namespace, pod) (
      avg by (k8s_cluster_name, namespace, pod, container, node) (container_cpu_allocation)
      * on (k8s_cluster_name, node) group_left()
        avg by (k8s_cluster_name, node) (node_cpu_hourly_cost)
    )`;
  const ramCostQ = `
    sum by (k8s_cluster_name, namespace, pod) (
      avg by (k8s_cluster_name, namespace, pod, container, node) (container_memory_allocation_bytes / (1024*1024*1024))
      * on (k8s_cluster_name, node) group_left()
        avg by (k8s_cluster_name, node) (node_ram_hourly_cost)
    )`;

  const [cpuAlloc, ramAlloc, cpuP95, ramP95, upSeries, cpuCost, ramCost] = await Promise.all(
    [cpuAllocQ, ramAllocQ, cpuP95Q, ramP95Q, upQ, cpuCostQ, ramCostQ].map(instant),
  );

  const podKey = (s: VectorSample) => `${s.metric.k8s_cluster_name}::${s.metric.namespace}::${s.metric.pod}`;
  const idx = {
    cpuAlloc: indexBy(cpuAlloc, podKey),
    ramAlloc: indexBy(ramAlloc, podKey),
    cpuP95: indexBy(cpuP95, podKey),
    ramP95: indexBy(ramP95, podKey),
    up: indexBy(upSeries, podKey),
    cpuCost: indexBy(cpuCost, podKey),
    ramCost: indexBy(ramCost, podKey),
  };

  // Roll-up per workload. Use weighted averages where appropriate.
  type Bucket = {
    cluster: string;
    namespace: string;
    workload: string;
    cpuAlloc: number;
    cpuP95: number;
    ramAlloc: number;
    ramP95: number;
    cpuCost: number;
    ramCost: number;
    podCount: number;
    minUptimeMin: number;
  };
  const buckets = new Map<string, Bucket>();
  const allKeys = new Set<string>([
    ...idx.cpuAlloc.keys(),
    ...idx.ramAlloc.keys(),
    ...idx.cpuCost.keys(),
    ...idx.ramCost.keys(),
  ]);

  for (const key of allKeys) {
    const sample =
      idx.cpuCost.get(key) ||
      idx.ramCost.get(key) ||
      idx.cpuAlloc.get(key) ||
      idx.ramAlloc.get(key);
    if (!sample) continue;
    const cluster = sample.metric.k8s_cluster_name;
    const namespace = sample.metric.namespace;
    const pod = sample.metric.pod;
    if (!cluster || !namespace || !pod) continue;
    const workload = podToWorkload(pod);
    const bk = `${cluster}::${namespace}::${workload}`;
    let b = buckets.get(bk);
    if (!b) {
      b = {
        cluster,
        namespace,
        workload,
        cpuAlloc: 0,
        cpuP95: 0,
        ramAlloc: 0,
        ramP95: 0,
        cpuCost: 0,
        ramCost: 0,
        podCount: 0,
        minUptimeMin: Infinity,
      };
      buckets.set(bk, b);
    }
    b.cpuAlloc += num(idx.cpuAlloc.get(key));
    b.ramAlloc += num(idx.ramAlloc.get(key));
    b.cpuP95 += num(idx.cpuP95.get(key));
    b.ramP95 += num(idx.ramP95.get(key));
    b.cpuCost += num(idx.cpuCost.get(key));
    b.ramCost += num(idx.ramCost.get(key));
    const upMin = num(idx.up.get(key));
    if (upMin > 0) b.minUptimeMin = Math.min(b.minUptimeMin, upMin);
    b.podCount += 1;
  }

  // Tunables
  const HEADROOM_CPU = 0.5;       // 50% headroom -> target = p95 / 0.5
  const HEADROOM_RAM = 0.7;       // 30% headroom -> target = p95 / 0.7
  const FLOOR_CPU_PER_POD = 0.1;  // 100m
  const FLOOR_RAM_PER_POD = 0.125; // 128 MiB
  const SAVINGS_CAP = 0.7;        // never report >70% savings; needs human review
  const MIN_UPTIME_MIN = 60;      // skip pods with <60min lifetime in 7d
  const MIN_MONTHLY_COST = 10;    // ignore noise

  const candidates: RightsizingCandidate[] = [];
  for (const b of buckets.values()) {
    const monthlyCost = (b.cpuCost + b.ramCost) * HOURS_PER_MONTH;
    if (monthlyCost < MIN_MONTHLY_COST) continue;
    if (b.minUptimeMin < MIN_UPTIME_MIN) continue;
    const cpuEff = pct(b.cpuP95, b.cpuAlloc);
    const ramEff = pct(b.ramP95, b.ramAlloc);

    // Targets with headroom + per-pod floor
    const podCount = Math.max(1, b.podCount);
    const cpuTarget = Math.max(FLOOR_CPU_PER_POD * podCount, b.cpuP95 / HEADROOM_CPU);
    const ramTarget = Math.max(FLOOR_RAM_PER_POD * podCount, b.ramP95 / HEADROOM_RAM);

    const cpuWasteFrac = b.cpuAlloc > 0 ? Math.max(0, 1 - cpuTarget / b.cpuAlloc) : 0;
    const ramWasteFrac = b.ramAlloc > 0 ? Math.max(0, 1 - ramTarget / b.ramAlloc) : 0;

    const rawSavingsHourly = b.cpuCost * cpuWasteFrac + b.ramCost * ramWasteFrac;
    const cappedSavingsHourly = Math.min(rawSavingsHourly, (b.cpuCost + b.ramCost) * SAVINGS_CAP);
    const potentialMonthlySavings = cappedSavingsHourly * HOURS_PER_MONTH;

    if (potentialMonthlySavings < 5) continue;
    if (cpuEff > 60 && ramEff > 60) continue; // already well sized
    candidates.push({
      cluster: b.cluster,
      namespace: b.namespace,
      workload: b.workload,
      cpuAllocatedCores: b.cpuAlloc,
      cpuUsedCores: b.cpuP95,
      cpuEfficiencyPct: cpuEff,
      ramAllocatedGb: b.ramAlloc,
      ramUsedGb: b.ramP95,
      ramEfficiencyPct: ramEff,
      monthlyCost,
      potentialMonthlySavings,
    });
  }

  candidates.sort((a, b) => b.potentialMonthlySavings - a.potentialMonthlySavings);
  return candidates;
}

// ──────────────────────────────────────────────────────────────────────────
// Public entry point
// ──────────────────────────────────────────────────────────────────────────

export async function fetchK8sFinopsSummary(): Promise<K8sFinOpsSummary> {
  const status = grafanaMetricsClient.getStatus();
  if (!status.ready) {
    throw new Error(
      `Grafana Metrics not ready. Missing env vars: ${status.missing.join(", ")}`,
    );
  }

  const warnings: string[] = [];

  const [clusters, namespaces, workloads, loadBalancers, rightsizing] = await Promise.all([
    fetchClusterBreakdown().catch((err) => {
      warnings.push(`cluster breakdown failed: ${err?.message || err}`);
      return [];
    }),
    fetchNamespaceAllocation().catch((err) => {
      warnings.push(`namespace allocation failed: ${err?.message || err}`);
      return [];
    }),
    fetchWorkloadAllocation().catch((err) => {
      warnings.push(`workload allocation failed: ${err?.message || err}`);
      return [];
    }),
    fetchLoadBalancers().catch((err) => {
      warnings.push(`load balancer cost failed: ${err?.message || err}`);
      return [];
    }),
    fetchRightsizingCandidates().catch((err) => {
      warnings.push(`rightsizing failed: ${err?.message || err}`);
      return [];
    }),
  ]);

  const totalHourly = clusters.reduce((sum, c) => sum + c.totalCostHourly, 0);

  return {
    generatedAt: new Date().toISOString(),
    totalHourly,
    totalMonthly: totalHourly * HOURS_PER_MONTH,
    totalEgressMonthly:
      clusters.reduce((sum, c) => sum + c.egressCostHourly, 0) * HOURS_PER_MONTH,
    totalLoadBalancersMonthly:
      clusters.reduce((sum, c) => sum + c.loadBalancerCostHourly, 0) * HOURS_PER_MONTH,
    totalMgmtMonthly:
      clusters.reduce((sum, c) => sum + c.mgmtCostHourly, 0) * HOURS_PER_MONTH,
    clusters,
    topNamespaces: namespaces.slice(0, 50),
    topWorkloads: workloads.slice(0, 50),
    topLoadBalancers: loadBalancers.slice(0, 30),
    rightsizingCandidates: rightsizing.slice(0, 30),
    warnings,
  };
}
