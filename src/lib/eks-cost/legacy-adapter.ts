/**
 * Legacy adapter — Fase 3 cutover.
 *
 * Pure, deterministic mapping from the new {@link AllocationResponse}
 * (produced by `fetchEksCostSummary`) into the legacy
 * {@link K8sFinOpsSummary} shape that the deprecated
 * `GET /api/finops/k8s-allocation` endpoint keeps serving for two
 * releases (design.md §Backend > `/api/finops/k8s-allocation` legacy).
 *
 * Contract highlights:
 *
 *   - No side effects, no network calls. The function receives a fully
 *     computed response and re-shapes it in memory.
 *   - Fields that the new model does not track (`nodeCpuCostHourly`,
 *     `nodeRamCostHourly`, `mgmtCostHourly`, `loadBalancerCostHourly`,
 *     `egress*`, allocatable cores/GB) are set to `0` — the legacy
 *     dashboard treats missing dimensions as unavailable.
 *   - `topLoadBalancers` is always `[]`; the new model attributes cost
 *     to workloads/nodegroups, not to load balancers.
 *   - `rightsizingCandidates` is derived from `over-*` recommendations
 *     only (`under-*` are risk warnings, not savings) and merges
 *     `over-cpu` + `over-mem` for the same `(cluster, namespace,
 *     workload)` into a single legacy candidate, adding their savings.
 *
 * See:
 *   - `.kiro/specs/eks-cost-optimization/design.md` §Backend > legacy alias
 *   - `.kiro/specs/eks-cost-optimization/tasks.md` §Fase 3 > task 15.1
 *   - Requirements 9.1, 9.2
 */

import type { AllocationResponse, Workload } from "@/lib/eks-cost/types";
import type {
  ClusterCostBreakdown,
  K8sFinOpsSummary,
  NamespaceAllocation,
  RightsizingCandidate,
  WorkloadAllocation,
} from "@/lib/k8s-finops";

/**
 * Cloud-FinOps convention (aligned with OpenCost + AWS): monthly = hourly × 730.
 * Kept local to this module so the adapter has zero non-type imports from
 * the new backend surface.
 */
const HOURS_PER_MONTH = 730;

/** Percent with one-decimal rounding, matching legacy `k8s-finops.pct`. */
function pct(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

/** Convert bytes to GiB (2^30) — legacy field unit. */
function bytesToGiB(bytes: number): number {
  return bytes / (1024 * 1024 * 1024);
}

/** Deterministic composite key across cluster+namespace(+workload). */
const KEY_SEP = "\u0000";

/**
 * Re-shape a new-style {@link AllocationResponse} into the legacy
 * {@link K8sFinOpsSummary} contract.
 *
 * Deterministic and pure: identical input → identical output.
 */
export function legacyAdapter(response: AllocationResponse): K8sFinOpsSummary {
  // Index workloads for O(1) lookup while building rightsizing candidates.
  const workloadIdx = new Map<string, Workload>();
  for (const w of response.workloads) {
    workloadIdx.set(`${w.cluster}${KEY_SEP}${w.namespace}${KEY_SEP}${w.workload}`, w);
  }

  // Aggregate CPU/RAM allocation + p95 usage by (cluster, namespace) and by
  // cluster. The new model exposes these only per-workload; we roll them up
  // to preserve the legacy `NamespaceAllocation` and `ClusterCostBreakdown`
  // fields (allocated/used cores + GB + efficiency).
  interface NsBucket {
    cluster: string;
    namespace: string;
    totalCostMonthly: number;
    cpuAllocatedCores: number;
    cpuUsedCores: number;
    ramAllocatedGb: number;
    ramUsedGb: number;
  }
  interface ClusterBucket {
    cluster: string;
    cpuAllocatedCores: number;
    cpuUsedCores: number;
    ramAllocatedGb: number;
    ramUsedGb: number;
  }

  const nsBuckets = new Map<string, NsBucket>();
  const clusterBuckets = new Map<string, ClusterBucket>();

  for (const w of response.workloads) {
    const nsKey = `${w.cluster}${KEY_SEP}${w.namespace}`;
    let ns = nsBuckets.get(nsKey);
    if (!ns) {
      ns = {
        cluster: w.cluster,
        namespace: w.namespace,
        totalCostMonthly: 0,
        cpuAllocatedCores: 0,
        cpuUsedCores: 0,
        ramAllocatedGb: 0,
        ramUsedGb: 0,
      };
      nsBuckets.set(nsKey, ns);
    }
    ns.totalCostMonthly += w.monthlyCostEur;
    ns.cpuAllocatedCores += w.cpuRequestCores;
    ns.cpuUsedCores += w.cpuUsageP95Cores;
    ns.ramAllocatedGb += bytesToGiB(w.memRequestBytes);
    ns.ramUsedGb += bytesToGiB(w.memUsageP95Bytes);

    let c = clusterBuckets.get(w.cluster);
    if (!c) {
      c = {
        cluster: w.cluster,
        cpuAllocatedCores: 0,
        cpuUsedCores: 0,
        ramAllocatedGb: 0,
        ramUsedGb: 0,
      };
      clusterBuckets.set(w.cluster, c);
    }
    c.cpuAllocatedCores += w.cpuRequestCores;
    c.cpuUsedCores += w.cpuUsageP95Cores;
    c.ramAllocatedGb += bytesToGiB(w.memRequestBytes);
    c.ramUsedGb += bytesToGiB(w.memUsageP95Bytes);
  }

  // ── clusters: derive from environments[] grouping ────────────────────
  const clusters: ClusterCostBreakdown[] = response.environments.map((env) => {
    const totalHourly = env.monthlyCostEur / HOURS_PER_MONTH;
    const cb = clusterBuckets.get(env.cluster);
    const cpuAllocated = cb?.cpuAllocatedCores ?? 0;
    const cpuUsed = cb?.cpuUsedCores ?? 0;
    const ramAllocated = cb?.ramAllocatedGb ?? 0;
    const ramUsed = cb?.ramUsedGb ?? 0;
    return {
      cluster: env.cluster,
      // The new model doesn't split node cost by CPU vs RAM, nor tracks
      // mgmt/LB/egress separately — they land under `totalCostHourly`.
      nodeCpuCostHourly: 0,
      nodeRamCostHourly: 0,
      nodeTotalCostHourly: totalHourly,
      mgmtCostHourly: 0,
      loadBalancerCostHourly: 0,
      egressCostHourly: 0,
      egressInternetHourly: 0,
      egressRegionHourly: 0,
      egressZoneHourly: 0,
      totalCostHourly: totalHourly,
      totalCostMonthly: env.monthlyCostEur,
      nodeCount: env.nodeCount,
      spotNodeCount: env.spotCount,
      spotCoveragePct: env.spotCoveragePct,
      // `allocatable` is a node-level metric absent from the new pipeline;
      // `allocated` and `used` are rolled up from workloads.
      cpuAllocatableCores: 0,
      cpuAllocatedCores: cpuAllocated,
      cpuUsedCores: cpuUsed,
      cpuEfficiencyPct: pct(cpuUsed, cpuAllocated),
      ramAllocatableGb: 0,
      ramAllocatedGb: ramAllocated,
      ramUsedGb: ramUsed,
      ramEfficiencyPct: pct(ramUsed, ramAllocated),
    };
  });

  // ── topNamespaces: group workloads by (cluster, namespace) DESC ──────
  const topNamespaces: NamespaceAllocation[] = [...nsBuckets.values()]
    .map((ns) => {
      const totalHourly = ns.totalCostMonthly / HOURS_PER_MONTH;
      const wasteCpuFrac =
        ns.cpuAllocatedCores > 0
          ? Math.max(0, (ns.cpuAllocatedCores - ns.cpuUsedCores) / ns.cpuAllocatedCores)
          : 0;
      const wasteRamFrac =
        ns.ramAllocatedGb > 0
          ? Math.max(0, (ns.ramAllocatedGb - ns.ramUsedGb) / ns.ramAllocatedGb)
          : 0;
      // The new model gives us a single monthly cost per workload without
      // the CPU/RAM split. Distribute waste evenly across the two halves so
      // `wasteCostMonthly` stays representative when both are inefficient
      // (matches the intent of legacy `wasteHourly = cpuC*fracCpu + ramC*fracRam`).
      const halfHourly = totalHourly / 2;
      const wasteHourly = halfHourly * wasteCpuFrac + halfHourly * wasteRamFrac;
      return {
        cluster: ns.cluster,
        namespace: ns.namespace,
        cpuCostHourly: 0,
        ramCostHourly: 0,
        totalCostHourly: totalHourly,
        totalCostMonthly: ns.totalCostMonthly,
        cpuAllocatedCores: ns.cpuAllocatedCores,
        cpuUsedCores: ns.cpuUsedCores,
        cpuEfficiencyPct: pct(ns.cpuUsedCores, ns.cpuAllocatedCores),
        ramAllocatedGb: ns.ramAllocatedGb,
        ramUsedGb: ns.ramUsedGb,
        ramEfficiencyPct: pct(ns.ramUsedGb, ns.ramAllocatedGb),
        wasteCostMonthly: wasteHourly * HOURS_PER_MONTH,
      };
    })
    .sort((a, b) => b.totalCostMonthly - a.totalCostMonthly);

  // ── topWorkloads: 1:1 from workloads[], already top-N capped by fachada ──
  const topWorkloads: WorkloadAllocation[] = response.workloads
    .map((w) => ({
      cluster: w.cluster,
      namespace: w.namespace,
      workload: w.workload,
      // No CPU/RAM split in the new model — full cost lives in `total*`.
      cpuCostHourly: 0,
      ramCostHourly: 0,
      totalCostHourly: w.monthlyCostEur / HOURS_PER_MONTH,
      totalCostMonthly: w.monthlyCostEur,
      podCount: w.podCount,
    }))
    .sort((a, b) => b.totalCostMonthly - a.totalCostMonthly);

  // ── rightsizingCandidates: merge over-* recommendations per workload ─
  interface CandidateBucket {
    cluster: string;
    namespace: string;
    workload: string;
    savings: number;
  }
  const candidateBuckets = new Map<string, CandidateBucket>();
  for (const rec of response.recommendations) {
    // Legacy candidates represent savings opportunities. `under-*` carry
    // `estimatedSavingsEur === 0` and are risk signals only — skipped.
    if (!rec.kind.startsWith("over-")) continue;
    const key = `${rec.cluster}${KEY_SEP}${rec.namespace}${KEY_SEP}${rec.workload}`;
    let b = candidateBuckets.get(key);
    if (!b) {
      b = {
        cluster: rec.cluster,
        namespace: rec.namespace,
        workload: rec.workload,
        savings: 0,
      };
      candidateBuckets.set(key, b);
    }
    b.savings += rec.estimatedSavingsEur;
  }
  const rightsizingCandidates: RightsizingCandidate[] = [...candidateBuckets.values()]
    .map((c) => {
      const w = workloadIdx.get(`${c.cluster}${KEY_SEP}${c.namespace}${KEY_SEP}${c.workload}`);
      const cpuAlloc = w?.cpuRequestCores ?? 0;
      const cpuUsed = w?.cpuUsageP95Cores ?? 0;
      const ramAllocGb = w ? bytesToGiB(w.memRequestBytes) : 0;
      const ramUsedGb = w ? bytesToGiB(w.memUsageP95Bytes) : 0;
      return {
        cluster: c.cluster,
        namespace: c.namespace,
        workload: c.workload,
        cpuAllocatedCores: cpuAlloc,
        cpuUsedCores: cpuUsed,
        cpuEfficiencyPct: pct(cpuUsed, cpuAlloc),
        ramAllocatedGb: ramAllocGb,
        ramUsedGb: ramUsedGb,
        ramEfficiencyPct: pct(ramUsedGb, ramAllocGb),
        monthlyCost: w?.monthlyCostEur ?? 0,
        potentialMonthlySavings: c.savings,
      };
    })
    .sort((a, b) => b.potentialMonthlySavings - a.potentialMonthlySavings);

  return {
    generatedAt: response.generatedAt,
    // Reverse the projection so legacy consumers keep seeing hourly = monthly / 730.
    totalHourly: response.totalMonthlyEur / HOURS_PER_MONTH,
    totalMonthly: response.totalMonthlyEur,
    // Dimensions dropped by the new model.
    totalEgressMonthly: 0,
    totalLoadBalancersMonthly: 0,
    totalMgmtMonthly: 0,
    clusters,
    topNamespaces,
    topWorkloads,
    // The new model doesn't track load balancers separately (cost is
    // absorbed into workload / nodegroup attribution).
    topLoadBalancers: [],
    rightsizingCandidates,
    // The legacy contract carries plain strings; flatten `Warning` objects
    // preserving code + source so operators can still diagnose partials.
    warnings: response.warnings.map((w) => `${w.code}: ${w.message} (${w.source})`),
  };
}
