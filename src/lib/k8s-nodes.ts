/**
 * Node-level FinOps analysis: which EC2 instances back our EKS clusters,
 * grouped by nodegroup, with real utilization vs allocation, and a
 * NODEGROUP-level recommendation (a single instance type per managed node
 * group is the operational unit; you cannot change one node in isolation).
 *
 * Data sources (Grafana Cloud Prometheus):
 *   - node_total_hourly_cost (OpenCost) — labels: k8s_cluster_name, node, instance_type, region
 *   - kubecost_node_is_spot (OpenCost)
 *   - kube_node_status_capacity / kube_node_status_allocatable (KSM)
 *   - kube_pod_info (KSM) — this is how we attach (namespace,pod) -> node
 *   - kube_pod_container_resource_requests / _limits (KSM)
 *   - kube_node_labels (KSM) — provides label_eks_amazonaws_com_nodegroup
 *   - container_cpu_usage_seconds_total (cAdvisor) — has `node` label natively
 *   - container_memory_working_set_bytes (cAdvisor) — has `node` label natively
 */

import { grafanaMetricsClient } from "@/lib/grafana-metrics";

export const HOURS_PER_MONTH = 730;

const UNDER_UTIL_REQ = 0.55; // both CPU+RAM request below this -> over-provisioned
const HIGH_UTIL_REQ = 0.85; // requests near or above 85% -> too tight, can't downsize
const HIGH_UTIL_USE = 0.7; // actual usage above 70% sustained -> consider larger
const HEADROOM = 1.3; // 30% headroom when validating "fits in smaller type"

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type NodegroupRecommendationKind =
  | "ok"
  | "downsize_type"
  | "scale_in_count"
  | "scale_out_count"
  | "consider_spot"
  | "no_data";

export interface PodOnNode {
  namespace: string;
  pod: string;
  cpuRequest: number; // cores
  ramRequest: number; // bytes
}

export interface NodeAnalysis {
  cluster: string;
  nodegroup: string | null;
  node: string;
  instanceType: string;
  region: string;
  isSpot: boolean;

  cpuAllocatable: number; // cores
  cpuRequested: number; // sum of pod requests on this node
  cpuUsedP95: number; // p95 24h
  cpuRequestPct: number;
  cpuUsagePct: number;

  ramAllocatableBytes: number;
  ramRequestedBytes: number;
  ramUsedP95Bytes: number;
  ramRequestPct: number;
  ramUsagePct: number;

  podCount: number;

  costHourly: number;
  costMonthly: number;
}

export interface NodegroupRecommendation {
  kind: NodegroupRecommendationKind;
  headline: string;
  detail: string;
  // Concrete suggestion when applicable
  suggestedInstanceType: string | null;
  suggestedNodeCount: number | null;
  estimatedMonthlySavings: number;
  // What blocks a more aggressive recommendation
  blockers: string[];
}

export interface NodegroupAnalysis {
  cluster: string;
  nodegroup: string;
  nodeCount: number;
  spotCount: number;
  // Most common instance type in the NG (managed NGs typically have one)
  primaryInstanceType: string;
  instanceTypes: Record<string, number>;

  // Aggregates across the NG (peak across nodes for "do we have headroom?")
  totalCpuAllocatable: number;
  totalCpuRequested: number;
  peakCpuUsedP95: number; // sum across nodes? no — we use peak-hour aggregate
  totalRamAllocatable: number;
  totalRamRequestedBytes: number;
  peakRamUsedP95Bytes: number;

  // Largest pod request — the limiting factor when downsizing
  maxPodCpuRequest: number;
  maxPodRamRequest: number;

  avgCpuRequestPct: number;
  avgCpuUsagePct: number;
  avgRamRequestPct: number;
  avgRamUsagePct: number;
  totalCostMonthly: number;

  recommendation: NodegroupRecommendation;
  nodes: NodeAnalysis[];
}

export interface NodesSummary {
  generatedAt: string;
  clusters: string[];
  totalNodes: number;
  totalSpotNodes: number;
  totalCostMonthly: number;
  estimatedMonthlySavings: number;
  nodegroups: NodegroupAnalysis[];
  warnings: string[];
}

export interface NodesFilters {
  cluster?: string;
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
    console.warn("[k8s-nodes] query failed:", String(err).slice(0, 200), "::", query.replace(/\s+/g, " ").slice(0, 200));
    return [];
  }
}

function num(v: Sample | undefined): number {
  if (!v) return 0;
  const n = Number(v.value?.[1] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function pct(part: number, total: number): number {
  if (!total || !Number.isFinite(part) || !Number.isFinite(total)) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function nodeKey(cluster: string, node: string): string {
  return `${cluster}|${node}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Instance catalog (eu-west-1 on-demand, approximate prices)
// ──────────────────────────────────────────────────────────────────────────

export interface InstanceSpec {
  type: string;
  family: string;
  cpu: number;
  memGb: number;
  approxOnDemandUsdHour: number;
  generation: number;
}

export const INSTANCE_CATALOG: InstanceSpec[] = [
  // m6i / m7i (general purpose, current gen)
  { type: "m6i.large", family: "m6i", cpu: 2, memGb: 8, approxOnDemandUsdHour: 0.106, generation: 6 },
  { type: "m6i.xlarge", family: "m6i", cpu: 4, memGb: 16, approxOnDemandUsdHour: 0.212, generation: 6 },
  { type: "m6i.2xlarge", family: "m6i", cpu: 8, memGb: 32, approxOnDemandUsdHour: 0.424, generation: 6 },
  { type: "m6i.4xlarge", family: "m6i", cpu: 16, memGb: 64, approxOnDemandUsdHour: 0.848, generation: 6 },
  { type: "m6i.8xlarge", family: "m6i", cpu: 32, memGb: 128, approxOnDemandUsdHour: 1.696, generation: 6 },
  { type: "m7i.large", family: "m7i", cpu: 2, memGb: 8, approxOnDemandUsdHour: 0.111, generation: 7 },
  { type: "m7i.xlarge", family: "m7i", cpu: 4, memGb: 16, approxOnDemandUsdHour: 0.222, generation: 7 },
  { type: "m7i.2xlarge", family: "m7i", cpu: 8, memGb: 32, approxOnDemandUsdHour: 0.444, generation: 7 },
  { type: "m7i.4xlarge", family: "m7i", cpu: 16, memGb: 64, approxOnDemandUsdHour: 0.889, generation: 7 },
  { type: "m7i.8xlarge", family: "m7i", cpu: 32, memGb: 128, approxOnDemandUsdHour: 1.778, generation: 7 },
  // m5
  { type: "m5.large", family: "m5", cpu: 2, memGb: 8, approxOnDemandUsdHour: 0.107, generation: 5 },
  { type: "m5.xlarge", family: "m5", cpu: 4, memGb: 16, approxOnDemandUsdHour: 0.214, generation: 5 },
  { type: "m5.2xlarge", family: "m5", cpu: 8, memGb: 32, approxOnDemandUsdHour: 0.428, generation: 5 },
  { type: "m5.4xlarge", family: "m5", cpu: 16, memGb: 64, approxOnDemandUsdHour: 0.856, generation: 5 },
  // r6i / r7i (memory-optimized)
  { type: "r6i.large", family: "r6i", cpu: 2, memGb: 16, approxOnDemandUsdHour: 0.139, generation: 6 },
  { type: "r6i.xlarge", family: "r6i", cpu: 4, memGb: 32, approxOnDemandUsdHour: 0.279, generation: 6 },
  { type: "r6i.2xlarge", family: "r6i", cpu: 8, memGb: 64, approxOnDemandUsdHour: 0.557, generation: 6 },
  { type: "r6i.4xlarge", family: "r6i", cpu: 16, memGb: 128, approxOnDemandUsdHour: 1.114, generation: 6 },
  { type: "r7i.large", family: "r7i", cpu: 2, memGb: 16, approxOnDemandUsdHour: 0.146, generation: 7 },
  { type: "r7i.xlarge", family: "r7i", cpu: 4, memGb: 32, approxOnDemandUsdHour: 0.293, generation: 7 },
  { type: "r7i.2xlarge", family: "r7i", cpu: 8, memGb: 64, approxOnDemandUsdHour: 0.585, generation: 7 },
  // c6i (compute-optimized)
  { type: "c6i.large", family: "c6i", cpu: 2, memGb: 4, approxOnDemandUsdHour: 0.094, generation: 6 },
  { type: "c6i.xlarge", family: "c6i", cpu: 4, memGb: 8, approxOnDemandUsdHour: 0.187, generation: 6 },
  { type: "c6i.2xlarge", family: "c6i", cpu: 8, memGb: 16, approxOnDemandUsdHour: 0.374, generation: 6 },
  // t3 (burstable, baseline)
  { type: "t3.medium", family: "t3", cpu: 2, memGb: 4, approxOnDemandUsdHour: 0.043, generation: 3 },
  { type: "t3.large", family: "t3", cpu: 2, memGb: 8, approxOnDemandUsdHour: 0.086, generation: 3 },
  { type: "t3.xlarge", family: "t3", cpu: 4, memGb: 16, approxOnDemandUsdHour: 0.171, generation: 3 },
  { type: "t3.2xlarge", family: "t3", cpu: 8, memGb: 32, approxOnDemandUsdHour: 0.342, generation: 3 },
];

export function findInstance(type: string): InstanceSpec | undefined {
  return INSTANCE_CATALOG.find((i) => i.type === type);
}

// ──────────────────────────────────────────────────────────────────────────
// Data fetching
// ──────────────────────────────────────────────────────────────────────────

async function fetchNodesAndPods(filters: NodesFilters): Promise<{
  nodes: Map<string, NodeAnalysis>;
  podsPerNode: Map<string, PodOnNode[]>; // key = nodeKey
}> {
  const cf = filters.cluster && filters.cluster !== "all"
    ? `,k8s_cluster_name="${filters.cluster}"`
    : "";

  // ── Per-node basics
  const costQ = `node_total_hourly_cost{job="integrations/opencost"${cf}}`;
  const cpuAllocatableQ = `kube_node_status_allocatable{resource="cpu"${cf}}`;
  const ramAllocatableQ = `kube_node_status_allocatable{resource="memory"${cf}}`;
  const isSpotQ = `kubecost_node_is_spot{job="integrations/opencost"${cf}}`;
  const labelsQ = `kube_node_labels{${cf ? cf.slice(1) : ""}}`.replace("{}", "");

  // ── Pod count per node — only Running pods, attribute by `node`
  // kube_pod_info has: namespace, pod, node, host_ip, pod_ip, ...
  const podCountQ = `count by (k8s_cluster_name, node) (kube_pod_info{node!=""${cf}})`;

  // ── REQUESTS attributed to the right node (THE KEY FIX)
  // kube_pod_container_resource_requests has labels: namespace, pod, container, resource
  // It does NOT have `node`. We must join with kube_pod_info(namespace, pod) -> node.
  const cpuRequestPerNodeQ = `
    sum by (k8s_cluster_name, node) (
      kube_pod_container_resource_requests{resource="cpu"${cf}}
      * on (k8s_cluster_name, namespace, pod) group_left(node)
        kube_pod_info{node!=""${cf}}
    )
  `;
  const ramRequestPerNodeQ = `
    sum by (k8s_cluster_name, node) (
      kube_pod_container_resource_requests{resource="memory"${cf}}
      * on (k8s_cluster_name, namespace, pod) group_left(node)
        kube_pod_info{node!=""${cf}}
    )
  `;

  // ── ACTUAL USAGE p95 over 24h (cAdvisor — has `node` label natively)
  const cpuUsedP95Q = `
    quantile_over_time(0.95,
      sum by (k8s_cluster_name, node) (
        rate(container_cpu_usage_seconds_total{container!="",container!="POD"${cf}}[5m])
      )[24h:5m]
    )
  `;
  const ramUsedP95Q = `
    quantile_over_time(0.95,
      sum by (k8s_cluster_name, node) (
        container_memory_working_set_bytes{container!="",container!="POD"${cf}}
      )[24h:5m]
    )
  `;

  // ── PER-POD requests (so we can compute "max pod size" per nodegroup)
  const podCpuQ = `
    sum by (k8s_cluster_name, namespace, pod, node) (
      kube_pod_container_resource_requests{resource="cpu"${cf}}
      * on (k8s_cluster_name, namespace, pod) group_left(node)
        kube_pod_info{node!=""${cf}}
    )
  `;
  const podRamQ = `
    sum by (k8s_cluster_name, namespace, pod, node) (
      kube_pod_container_resource_requests{resource="memory"${cf}}
      * on (k8s_cluster_name, namespace, pod) group_left(node)
        kube_pod_info{node!=""${cf}}
    )
  `;

  const [
    cost,
    cpuAllocatable,
    ramAllocatable,
    isSpot,
    labels,
    podCount,
    cpuReqByNode,
    ramReqByNode,
    cpuUsed,
    ramUsed,
    podCpu,
    podRam,
  ] = await Promise.all([
    instant(costQ),
    instant(cpuAllocatableQ),
    instant(ramAllocatableQ),
    instant(isSpotQ),
    instant(labelsQ),
    instant(podCountQ),
    instant(cpuRequestPerNodeQ),
    instant(ramRequestPerNodeQ),
    instant(cpuUsedP95Q),
    instant(ramUsedP95Q),
    instant(podCpuQ),
    instant(podRamQ),
  ]);

  const nodes = new Map<string, NodeAnalysis>();
  const podsPerNode = new Map<string, PodOnNode[]>();

  // Seed nodes from cost (canonical source)
  for (const s of cost) {
    const cluster = s.metric.k8s_cluster_name || "unknown";
    const node = s.metric.node || "";
    if (!node) continue;
    const k = nodeKey(cluster, node);
    nodes.set(k, {
      cluster,
      nodegroup: null,
      node,
      instanceType: s.metric.instance_type || "?",
      region: s.metric.region || "eu-west-1",
      isSpot: false,
      cpuAllocatable: 0,
      cpuRequested: 0,
      cpuUsedP95: 0,
      cpuRequestPct: 0,
      cpuUsagePct: 0,
      ramAllocatableBytes: 0,
      ramRequestedBytes: 0,
      ramUsedP95Bytes: 0,
      ramRequestPct: 0,
      ramUsagePct: 0,
      podCount: 0,
      costHourly: num(s),
      costMonthly: 0,
    });
  }

  const upsertNode = (samples: Sample[], setter: (n: NodeAnalysis, v: number) => void) => {
    for (const s of samples) {
      const cluster = s.metric.k8s_cluster_name || "unknown";
      const node = s.metric.node || "";
      if (!node) continue;
      const n = nodes.get(nodeKey(cluster, node));
      if (!n) continue;
      setter(n, num(s));
    }
  };

  upsertNode(cpuAllocatable, (n, v) => { n.cpuAllocatable = v; });
  upsertNode(ramAllocatable, (n, v) => { n.ramAllocatableBytes = v; });
  upsertNode(podCount, (n, v) => { n.podCount = v; });
  upsertNode(cpuReqByNode, (n, v) => { n.cpuRequested = v; });
  upsertNode(ramReqByNode, (n, v) => { n.ramRequestedBytes = v; });
  upsertNode(cpuUsed, (n, v) => { n.cpuUsedP95 = v; });
  upsertNode(ramUsed, (n, v) => { n.ramUsedP95Bytes = v; });

  // Spot
  for (const s of isSpot) {
    const cluster = s.metric.k8s_cluster_name || "unknown";
    const node = s.metric.node || "";
    if (!node) continue;
    const n = nodes.get(nodeKey(cluster, node));
    if (n && num(s) > 0) n.isSpot = true;
  }

  // Nodegroup labels
  for (const s of labels) {
    const cluster = s.metric.k8s_cluster_name || "unknown";
    const node = s.metric.node || "";
    if (!node) continue;
    const n = nodes.get(nodeKey(cluster, node));
    if (!n) continue;
    n.nodegroup = s.metric.label_eks_amazonaws_com_nodegroup
      || s.metric.label_alpha_eksctl_io_nodegroup_name
      || null;
  }

  // Compute derived %s and per-node pod lists
  for (const n of nodes.values()) {
    n.cpuRequestPct = pct(n.cpuRequested, n.cpuAllocatable);
    n.cpuUsagePct = pct(n.cpuUsedP95, n.cpuAllocatable);
    n.ramRequestPct = pct(n.ramRequestedBytes, n.ramAllocatableBytes);
    n.ramUsagePct = pct(n.ramUsedP95Bytes, n.ramAllocatableBytes);
    n.costMonthly = Math.round(n.costHourly * HOURS_PER_MONTH * 100) / 100;
  }

  // Build pod list per node (used for max-pod-fits validation)
  // We merge cpu and ram pod requests by (cluster, ns, pod, node)
  const podMap = new Map<string, PodOnNode>();
  const upsertPod = (samples: Sample[], setter: (p: PodOnNode, v: number) => void) => {
    for (const s of samples) {
      const cluster = s.metric.k8s_cluster_name || "unknown";
      const namespace = s.metric.namespace || "";
      const pod = s.metric.pod || "";
      const node = s.metric.node || "";
      if (!namespace || !pod || !node) continue;
      const k = `${cluster}|${node}|${namespace}|${pod}`;
      let p = podMap.get(k);
      if (!p) {
        p = { namespace, pod, cpuRequest: 0, ramRequest: 0 };
        podMap.set(k, p);
      }
      setter(p, num(s));
    }
  };
  upsertPod(podCpu, (p, v) => { p.cpuRequest = v; });
  upsertPod(podRam, (p, v) => { p.ramRequest = v; });

  for (const [k, p] of podMap) {
    const [cluster, node] = k.split("|");
    const nodeKeyStr = nodeKey(cluster, node);
    let arr = podsPerNode.get(nodeKeyStr);
    if (!arr) {
      arr = [];
      podsPerNode.set(nodeKeyStr, arr);
    }
    arr.push(p);
  }

  return { nodes, podsPerNode };
}

// ──────────────────────────────────────────────────────────────────────────
// Recommendation logic at NODEGROUP level
// ──────────────────────────────────────────────────────────────────────────

function fmt$(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  return `$${Math.round(n)}`;
}

interface FitCheck {
  ok: boolean;
  reason: string;
  newNodeCount: number;
}

/**
 * Validate that all current pods fit in the proposed instance type with HEADROOM.
 * Returns the minimum number of nodes of `target` needed.
 *
 * Heuristic bin-packing:
 *   - Each pod must fit in a single new node (largest pod request must <= target's allocatable).
 *   - Sum of all pod requests * HEADROOM divided by node capacity gives the rough count.
 */
function validateFit(
  target: InstanceSpec,
  pods: PodOnNode[],
): FitCheck {
  if (pods.length === 0) {
    return { ok: false, reason: "Sin información de pods", newNodeCount: 0 };
  }

  // Allocatable is typically ~94% of capacity in EKS (kubelet/system reserve).
  const targetCpuAllocatable = target.cpu * 0.94;
  const targetRamAllocatableBytes = target.memGb * 1024 ** 3 * 0.94;

  // Largest pod must fit in a single node
  let maxCpu = 0;
  let maxRam = 0;
  let limitingPod: string | null = null;
  for (const p of pods) {
    if (p.cpuRequest * HEADROOM > targetCpuAllocatable) {
      maxCpu = Math.max(maxCpu, p.cpuRequest);
      limitingPod = `${p.namespace}/${p.pod}`;
    }
    if (p.ramRequest * HEADROOM > targetRamAllocatableBytes) {
      maxRam = Math.max(maxRam, p.ramRequest);
      limitingPod = `${p.namespace}/${p.pod}`;
    }
  }
  if (limitingPod) {
    return {
      ok: false,
      reason: `El pod ${limitingPod} no cabe en ${target.type} con margen del 30%`,
      newNodeCount: 0,
    };
  }

  // Sum pod requests, add 30% headroom, see how many `target` nodes we need
  const sumCpu = pods.reduce((s, p) => s + p.cpuRequest, 0) * HEADROOM;
  const sumRam = pods.reduce((s, p) => s + p.ramRequest, 0) * HEADROOM;
  const cpuNodes = Math.ceil(sumCpu / targetCpuAllocatable);
  const ramNodes = Math.ceil(sumRam / targetRamAllocatableBytes);
  const newCount = Math.max(cpuNodes, ramNodes, 1);

  return { ok: true, reason: "OK", newNodeCount: newCount };
}

function buildNodegroupRecommendation(g: NodegroupAnalysis, allPods: PodOnNode[]): NodegroupRecommendation {
  const blockers: string[] = [];

  // Edge: no data
  if (g.totalCpuAllocatable === 0 || g.totalRamAllocatable === 0) {
    return {
      kind: "no_data",
      headline: "Sin datos suficientes",
      detail: "No hay métricas de capacidad. Verifica KSM y cAdvisor en este cluster.",
      suggestedInstanceType: null,
      suggestedNodeCount: null,
      estimatedMonthlySavings: 0,
      blockers,
    };
  }

  const reqCpuPct = g.totalCpuRequested / g.totalCpuAllocatable;
  const reqRamPct = g.totalRamRequestedBytes / g.totalRamAllocatable;
  const usePeakCpu = g.peakCpuUsedP95;
  const usePeakRam = g.peakRamUsedP95Bytes;
  const useCpuPct = usePeakCpu / g.totalCpuAllocatable;
  const useRamPct = usePeakRam / g.totalRamAllocatable;

  const overSized = reqCpuPct < UNDER_UTIL_REQ && reqRamPct < UNDER_UTIL_REQ
    && useCpuPct < UNDER_UTIL_REQ && useRamPct < UNDER_UTIL_REQ;
  const tooTight = reqCpuPct > HIGH_UTIL_REQ || reqRamPct > HIGH_UTIL_REQ
    || useCpuPct > HIGH_UTIL_USE || useRamPct > HIGH_UTIL_USE;

  // Discover the dominant family/generation
  const current = findInstance(g.primaryInstanceType);
  if (!current) {
    blockers.push(`Tipo "${g.primaryInstanceType}" no está en el catálogo. No puedo proponer alternativas concretas.`);
  }

  if (tooTight) {
    return {
      kind: "scale_out_count",
      headline: "Sin margen, considerar nodo extra o tipo mayor",
      detail: `Requests/uso por encima del 70-85% en CPU o RAM. Riesgo de pressure y throttling. Añade un nodo o sube de tipo.`,
      suggestedInstanceType: null,
      suggestedNodeCount: g.nodeCount + 1,
      estimatedMonthlySavings: 0,
      blockers,
    };
  }

  if (overSized && current) {
    // Try smaller candidates within same family, then within other generations
    const candidates = INSTANCE_CATALOG
      .filter((i) => i.family === current.family && i.cpu < current.cpu)
      .sort((a, b) => b.cpu - a.cpu);

    for (const cand of candidates) {
      const fit = validateFit(cand, allPods);
      if (!fit.ok) {
        blockers.push(`${cand.type} descartado: ${fit.reason}`);
        continue;
      }
      const newMonthly = cand.approxOnDemandUsdHour * fit.newNodeCount * HOURS_PER_MONTH;
      const currentMonthly = g.totalCostMonthly;
      const savings = currentMonthly - newMonthly;
      if (savings <= 0) continue;
      return {
        kind: "downsize_type",
        headline: `Migrar a ${fit.newNodeCount}× ${cand.type}`,
        detail: `Uso pico CPU/RAM <55%. Caben los ${allPods.length} pods en ${fit.newNodeCount} nodos de ${cand.type} (${cand.cpu}vCPU/${cand.memGb}GiB) con 30% de margen. Ahorro vs ${g.nodeCount}× ${current.type}: ${fmt$(savings)}/mes.`,
        suggestedInstanceType: cand.type,
        suggestedNodeCount: fit.newNodeCount,
        estimatedMonthlySavings: Math.round(savings),
        blockers,
      };
    }

    // No type change works — try to scale-in count instead
    if (g.nodeCount > 1) {
      const newCount = Math.max(1, g.nodeCount - 1);
      const fit = validateFit(current, allPods);
      if (fit.ok && fit.newNodeCount < g.nodeCount) {
        const savings = (g.nodeCount - fit.newNodeCount) * current.approxOnDemandUsdHour * HOURS_PER_MONTH;
        return {
          kind: "scale_in_count",
          headline: `Reducir a ${fit.newNodeCount}× ${current.type}`,
          detail: `Los pods caben en ${fit.newNodeCount} nodos del mismo tipo con margen. Ahorro: ${fmt$(savings)}/mes. (Si es un Managed NG, ajusta el desired count del ASG.)`,
          suggestedInstanceType: current.type,
          suggestedNodeCount: fit.newNodeCount,
          estimatedMonthlySavings: Math.round(savings),
          blockers,
        };
      }
    }

    // Spot fallback
    if (!g.nodes.every((n) => n.isSpot)) {
      const spotSavings = g.totalCostMonthly * 0.6; // ~60% spot discount typical
      return {
        kind: "consider_spot",
        headline: "Migrar a Spot (workloads tolerantes)",
        detail: `Uso bajo y nodos on-demand. Para workloads tolerantes a interrupción (jobs, dev, replicas no-críticas) Spot ahorra ~60%. Ahorro estimado: ${fmt$(spotSavings)}/mes.`,
        suggestedInstanceType: g.primaryInstanceType,
        suggestedNodeCount: g.nodeCount,
        estimatedMonthlySavings: Math.round(spotSavings),
        blockers,
      };
    }
  }

  return {
    kind: "ok",
    headline: "Bien dimensionado",
    detail: "Utilización de requests y uso real dentro de rango óptimo. No hay un cambio claro que aporte ahorro sin riesgo.",
    suggestedInstanceType: null,
    suggestedNodeCount: null,
    estimatedMonthlySavings: 0,
    blockers,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Main aggregation
// ──────────────────────────────────────────────────────────────────────────

export async function fetchNodesSummary(filters: NodesFilters = {}): Promise<NodesSummary> {
  const { nodes, podsPerNode } = await fetchNodesAndPods(filters);

  // Group nodes by (cluster, nodegroup)
  const ngMap = new Map<string, NodegroupAnalysis>();
  for (const n of nodes.values()) {
    const ng = n.nodegroup || "(sin nodegroup)";
    const key = `${n.cluster}|${ng}`;
    let g = ngMap.get(key);
    if (!g) {
      g = {
        cluster: n.cluster,
        nodegroup: ng,
        nodeCount: 0,
        spotCount: 0,
        primaryInstanceType: n.instanceType,
        instanceTypes: {},
        totalCpuAllocatable: 0,
        totalCpuRequested: 0,
        peakCpuUsedP95: 0,
        totalRamAllocatable: 0,
        totalRamRequestedBytes: 0,
        peakRamUsedP95Bytes: 0,
        maxPodCpuRequest: 0,
        maxPodRamRequest: 0,
        avgCpuRequestPct: 0,
        avgCpuUsagePct: 0,
        avgRamRequestPct: 0,
        avgRamUsagePct: 0,
        totalCostMonthly: 0,
        recommendation: { kind: "ok", headline: "", detail: "", suggestedInstanceType: null, suggestedNodeCount: null, estimatedMonthlySavings: 0, blockers: [] },
        nodes: [],
      };
      ngMap.set(key, g);
    }
    g.nodes.push(n);
    g.nodeCount++;
    if (n.isSpot) g.spotCount++;
    g.instanceTypes[n.instanceType] = (g.instanceTypes[n.instanceType] ?? 0) + 1;
    g.totalCpuAllocatable += n.cpuAllocatable;
    g.totalCpuRequested += n.cpuRequested;
    g.peakCpuUsedP95 += n.cpuUsedP95; // sum of node-p95s; conservative
    g.totalRamAllocatable += n.ramAllocatableBytes;
    g.totalRamRequestedBytes += n.ramRequestedBytes;
    g.peakRamUsedP95Bytes += n.ramUsedP95Bytes;
    g.totalCostMonthly += n.costMonthly;
    g.avgCpuRequestPct += n.cpuRequestPct;
    g.avgCpuUsagePct += n.cpuUsagePct;
    g.avgRamRequestPct += n.ramRequestPct;
    g.avgRamUsagePct += n.ramUsagePct;
  }

  // Finalise per-NG aggregates + recommendation
  for (const g of ngMap.values()) {
    if (g.nodeCount > 0) {
      g.avgCpuRequestPct = Math.round(g.avgCpuRequestPct / g.nodeCount * 10) / 10;
      g.avgCpuUsagePct = Math.round(g.avgCpuUsagePct / g.nodeCount * 10) / 10;
      g.avgRamRequestPct = Math.round(g.avgRamRequestPct / g.nodeCount * 10) / 10;
      g.avgRamUsagePct = Math.round(g.avgRamUsagePct / g.nodeCount * 10) / 10;
    }
    g.totalCostMonthly = Math.round(g.totalCostMonthly * 100) / 100;
    // Pick the most common type as primary
    const sorted = Object.entries(g.instanceTypes).sort(([, a], [, b]) => b - a);
    g.primaryInstanceType = sorted[0]?.[0] ?? g.primaryInstanceType;

    // Collect all pods on the NG (limiting factors)
    const allPods: PodOnNode[] = [];
    for (const n of g.nodes) {
      const k = nodeKey(n.cluster, n.node);
      const arr = podsPerNode.get(k) ?? [];
      for (const p of arr) allPods.push(p);
    }
    if (allPods.length > 0) {
      g.maxPodCpuRequest = Math.max(...allPods.map((p) => p.cpuRequest));
      g.maxPodRamRequest = Math.max(...allPods.map((p) => p.ramRequest));
    }

    g.recommendation = buildNodegroupRecommendation(g, allPods);
  }

  const nodegroups = Array.from(ngMap.values())
    .sort((a, b) => b.recommendation.estimatedMonthlySavings - a.recommendation.estimatedMonthlySavings);
  const totalNodes = Array.from(nodes.values()).length;
  const totalSpot = Array.from(nodes.values()).filter((n) => n.isSpot).length;
  const totalCost = nodegroups.reduce((s, g) => s + g.totalCostMonthly, 0);
  const totalSavings = nodegroups.reduce((s, g) => s + g.recommendation.estimatedMonthlySavings, 0);
  const clusters = Array.from(new Set(nodegroups.map((g) => g.cluster))).sort();

  return {
    generatedAt: new Date().toISOString(),
    clusters,
    totalNodes,
    totalSpotNodes: totalSpot,
    totalCostMonthly: Math.round(totalCost * 100) / 100,
    estimatedMonthlySavings: Math.round(totalSavings),
    nodegroups,
    warnings: totalNodes === 0
      ? ["Sin datos de nodos. Verifica que OpenCost y kube-state-metrics estén operativos."]
      : [],
  };
}

/**
 * Find a single nodegroup analysis by (cluster, nodegroup name) — used by the
 * Bedrock analyzer to deep-dive a single NG without re-fetching everything.
 */
export async function fetchNodegroup(cluster: string, nodegroup: string): Promise<NodegroupAnalysis | null> {
  const summary = await fetchNodesSummary({ cluster });
  return summary.nodegroups.find((g) => g.nodegroup === nodegroup) ?? null;
}
