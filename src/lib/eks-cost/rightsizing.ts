/**
 * Rightsizing engine for the EKS Cost Optimization module.
 *
 * This module holds the pure helpers that turn raw workload metrics
 * (requests, p95 usage, VPA upperbound) into `Recommendation[]` and the
 * ready-to-copy YAML block the UI surfaces.
 *
 * Modules touched by this file evolve together with `node-cost.ts` and
 * `k8s-units.ts`; nothing here performs I/O of its own (fetch orchestration
 * lives in `fetchRecommendations`, added by task 5.11).
 *
 * Canonical formulas (Requirements 3.4, 3.5, 3.6):
 *
 *   podCount    = max(1, workload.podCount)
 *   target_cpu  = max(floorCpuPerPod  * podCount, p95_cpu_7d / headroomCpu)
 *   target_mem  = max(floorMemPerPod * podCount, p95_mem_7d / headroomMem)
 *   target_mem  = max(target_mem, vpaMemUpperBytes)   when non-null  (anti-OOM)
 *
 * `headroomCpu = 0.5` yields 50% headroom on top of p95 CPU usage.
 * `headroomMem = 0.7` yields ~30% headroom on top of p95 memory usage.
 *
 * See:
 *   - `.kiro/specs/eks-cost-optimization/design.md` §Backend > rightsizing.ts
 *   - `.kiro/specs/eks-cost-optimization/requirements.md` — Requirements 3.4, 3.5, 3.6, 5.6, 10.3
 */

import { Recommendation, RecommendationKind, Workload } from "@/lib/eks-cost/types";

/**
 * Tunable parameters for the rightsizing pipeline. Defaults match the
 * heuristics validated in the legacy `k8s-finops.ts` and captured in the
 * design doc under §Rightsizing.
 */
export interface RightsizingParams {
  /**
   * Fractional headroom for CPU. The target is `p95_cpu / headroomCpu`, so
   * `0.5` leaves 50% headroom above observed p95 usage. Default: `0.5`.
   */
  headroomCpu: number;
  /**
   * Fractional headroom for memory. Default: `0.7` (~30% headroom).
   */
  headroomMem: number;
  /**
   * Minimum CPU target per pod (in cores). Default: `0.1` cores (100m).
   */
  floorCpuPerPod: number;
  /**
   * Minimum memory target per pod (in bytes). Default: `128 MiB`
   * (`128 * 1024 * 1024`).
   */
  floorMemPerPod: number;
  /**
   * Maximum fraction of the current monthly cost that a single recommendation
   * can claim as savings (Requirement 5.2). Default: `0.7`.
   */
  savingsCapFraction: number;
  /**
   * Minimum accumulated uptime (in minutes over the 7-day window) for a
   * workload to be considered by the rightsizing pipeline (Requirement 3.7).
   * Default: `60`.
   */
  minUptimeMinutes: number;
  /**
   * Minimum monthly cost (in EUR) below which a workload does not produce
   * a recommendation. Default: `10`.
   */
  minMonthlyCostEur: number;
}

/**
 * Canonical defaults for {@link RightsizingParams}. Every field matches the
 * design document exactly. Consumers can spread and override selectively.
 */
export const DEFAULT_RIGHTSIZING_PARAMS: RightsizingParams = {
  headroomCpu: 0.5,
  headroomMem: 0.7,
  floorCpuPerPod: 0.1,
  floorMemPerPod: 128 * 1024 * 1024,
  savingsCapFraction: 0.7,
  minUptimeMinutes: 60,
  minMonthlyCostEur: 10,
};

/**
 * Compute the recommended CPU target (in cores) for a workload.
 *
 * The result is the maximum of two lower bounds:
 *   - a hard floor of `floorCpuPerPod * podCount`,
 *   - the observed p95 CPU divided by the headroom fraction.
 *
 * `podCount` is clamped to at least `1` so that a workload observed with
 * `podCount === 0` (transient) still yields a meaningful floor.
 */
export function computeCpuTarget(w: Workload, p: RightsizingParams): number {
  const podCount = Math.max(1, w.podCount);
  const floor = p.floorCpuPerPod * podCount;
  const usageBased = w.cpuUsageP95Cores / p.headroomCpu;
  return Math.max(floor, usageBased);
}

/**
 * Compute the recommended memory target (in bytes) for a workload.
 *
 * The result is the maximum of three lower bounds:
 *   - a hard floor of `floorMemPerPod * podCount`,
 *   - the observed p95 memory divided by the headroom fraction,
 *   - the VPA memory upper-bound when available (Requirement 3.6, anti-OOM).
 */
export function computeMemTarget(
  w: Workload,
  vpaMemUpperBytes: number | null,
  p: RightsizingParams,
): number {
  const podCount = Math.max(1, w.podCount);
  const floor = p.floorMemPerPod * podCount;
  const usageBased = w.memUsageP95Bytes / p.headroomMem;
  let target = Math.max(floor, usageBased);
  if (vpaMemUpperBytes !== null) {
    target = Math.max(target, vpaMemUpperBytes);
  }
  return target;
}

/**
 * Strip characters that would break a YAML line comment or leak into a
 * multi-line value: newlines and carriage returns are removed; the result is
 * trimmed. Everything else is preserved so human-readable reasons stay
 * legible.
 *
 * @internal
 */
function sanitizeYamlLine(input: string): string {
  return input.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Build the canonical `resources:` YAML block emitted alongside every
 * recommendation. Values are interpolated verbatim — the caller is
 * responsible for producing them with `k8s-units.ts` (`formatCpu` /
 * `formatMemory`), so this helper never rounds or reformats.
 *
 * Canonical shape (design §Backend > rightsizing.ts):
 *
 * ```yaml
 * # EKS Cost recommendation for <namespace>/<workload>
 * # reason: <reason line>
 * resources:
 *   requests:
 *     cpu: "<cpuReq>"
 *     memory: "<memReq>"
 *   limits:
 *     memory: "<memReq>"
 * ```
 *
 * Design invariants (Requirements 5.6, 10.3):
 *
 *   - `requests.cpu`, `requests.memory` and `limits.memory` are **always**
 *     present.
 *   - `limits.cpu` is **never** emitted — coherent with the QoS Guaranteed
 *     practice of not capping CPU on latency-sensitive workloads.
 *   - The output is parseable YAML. Values are quoted so parsers such as
 *     `js-yaml` return them as strings (Property 11 in task 5.10 verifies
 *     round-trip via `parseCpu` / `parseMemory`); without quotes an
 *     integer-looking CPU like `2` would parse as a number.
 *
 * The function is pure: no I/O, no globals. Newlines and carriage returns
 * inside any input are collapsed to spaces so a stray line break in the
 * `reason` (or a hostile namespace/workload string) cannot inject
 * additional YAML lines. No secrets or PII are added by this helper — it
 * only interpolates its arguments.
 *
 * @param workload  Workload identifier (e.g. Deployment name).
 * @param namespace Kubernetes namespace of the workload.
 * @param cpuReq    Recommended CPU request already formatted (e.g. `"500m"`).
 * @param memReq    Recommended memory request already formatted
 *                  (e.g. `"512Mi"`).
 * @param reason    Optional single-line explanation for the recommendation.
 *                  Defaults to `"rightsizing recommendation"`.
 * @returns A YAML string ready to paste into a Helm values file or a
 *          Kubernetes manifest.
 *
 * @example
 * buildYamlBlock("oms-orders-api", "oms", "100m", "320Mi",
 *   "p95 memory usage is 210Mi over 7d, allocated 1Gi")
 * // # EKS Cost recommendation for oms/oms-orders-api
 * // # reason: p95 memory usage is 210Mi over 7d, allocated 1Gi
 * // resources:
 * //   requests:
 * //     cpu: "100m"
 * //     memory: "320Mi"
 * //   limits:
 * //     memory: "320Mi"
 */
export function buildYamlBlock(
  workload: string,
  namespace: string,
  cpuReq: string,
  memReq: string,
  reason?: string,
): string {
  const safeWorkload = sanitizeYamlLine(workload);
  const safeNamespace = sanitizeYamlLine(namespace);
  const safeCpu = sanitizeYamlLine(cpuReq);
  const safeMem = sanitizeYamlLine(memReq);
  const safeReason = sanitizeYamlLine(reason ?? "rightsizing recommendation");
  return [
    `# EKS Cost recommendation for ${safeNamespace}/${safeWorkload}`,
    `# reason: ${safeReason}`,
    `resources:`,
    `  requests:`,
    `    cpu: "${safeCpu}"`,
    `    memory: "${safeMem}"`,
    `  limits:`,
    `    memory: "${safeMem}"`,
  ].join("\n");
}

/**
 * Options accepted by {@link classifyOverUnder}.
 *
 * The uptime filter is off by default: only when the caller supplies
 * `uptimeMinutes` does the classifier consider it. This keeps the pure
 * classifier composable with sites that do not have uptime data (unit
 * tests, property tests, backfills) while still honouring Requirement 3.7
 * for the production pipeline in `fetchRecommendations`.
 */
export interface ClassifyOptions {
  /**
   * Minimum accumulated uptime, in minutes over the 7-day window, for a
   * workload to be considered by the rightsizing pipeline (Requirement 3.7,
   * default `60`). Workloads observed for less than this threshold are
   * excluded (`classifyOverUnder` returns `[]`) to avoid false positives on
   * CronJobs and short-lived Jobs.
   */
  minUptimeMinutes?: number;
  /**
   * Observed accumulated uptime of the workload, in minutes over the
   * 7-day window. When omitted, the uptime filter is skipped entirely.
   */
  uptimeMinutes?: number;
}

/**
 * Classify a workload against a pair of pre-computed CPU and memory
 * targets, emitting the set of {@link RecommendationKind}s that apply.
 *
 * Emission rules (design §Backend > rightsizing.ts, Requirements 3.2, 3.3,
 * 4.1, 4.2):
 *
 *   - `"over-cpu"`  iff `w.cpuRequestCores  > cpuTarget`
 *   - `"over-mem"`  iff `w.memRequestBytes  > memTarget`
 *   - `"under-cpu"` iff `w.cpuUsageP95Cores > w.cpuRequestCores`
 *   - `"under-mem"` iff `w.memUsageP95Bytes > w.memRequestBytes`
 *
 * `over-*` and `under-*` on the same dimension are mutually exclusive per
 * workload — a natural consequence of the canonical target formula
 * (`target = max(floor, p95 / headroom)` with `headroom < 1` yields
 * `target > p95`, so `request > target` and `p95 > request` cannot both
 * hold when targets come from {@link computeCpuTarget} /
 * {@link computeMemTarget}).
 *
 * Priority between `under-cpu` and `under-mem` (Requirement 4.3) is not
 * applied here: that is the job of `priorityFilter` (task 5.7), which
 * operates on the fully-materialised `Recommendation[]` produced by
 * `fetchRecommendations`.
 *
 * Uptime filter (Requirement 3.7): if `opts.uptimeMinutes` is supplied and
 * strictly less than `opts.minUptimeMinutes ?? 60`, the classifier returns
 * `[]` — coherent with excluding CronJobs and short-lived Jobs from the
 * rightsizing pipeline. When `opts.uptimeMinutes` is omitted the filter is
 * skipped so callers without uptime data can still use the classifier.
 *
 * The function is pure: no I/O, no globals, deterministic in its inputs.
 *
 * @param w         Workload metrics (canonical SI units — cores + bytes).
 * @param cpuTarget Recommended CPU target for the workload, in cores.
 * @param memTarget Recommended memory target for the workload, in bytes.
 * @param opts      Optional uptime filter — see {@link ClassifyOptions}.
 * @returns A (possibly empty) array of {@link RecommendationKind} values,
 *          in the canonical order `over-cpu`, `over-mem`, `under-cpu`,
 *          `under-mem`.
 */
export function classifyOverUnder(
  w: Workload,
  cpuTarget: number,
  memTarget: number,
  opts?: ClassifyOptions,
): RecommendationKind[] {
  if (opts?.uptimeMinutes !== undefined) {
    const threshold =
      opts.minUptimeMinutes ?? DEFAULT_RIGHTSIZING_PARAMS.minUptimeMinutes;
    if (opts.uptimeMinutes < threshold) {
      return [];
    }
  }
  const kinds: RecommendationKind[] = [];
  if (w.cpuRequestCores > cpuTarget) {
    kinds.push("over-cpu");
  }
  if (w.memRequestBytes > memTarget) {
    kinds.push("over-mem");
  }
  if (w.cpuUsageP95Cores > w.cpuRequestCores) {
    kinds.push("under-cpu");
  }
  if (w.memUsageP95Bytes > w.memRequestBytes) {
    kinds.push("under-mem");
  }
  return kinds;
}

/**
 * Estimate the monthly savings (EUR) of moving a workload from its current
 * resource allocation to the recommended target on a single dimension
 * (CPU cores or memory bytes).
 *
 * Formula (design §Backend > rightsizing.ts, Requirements 5.1, 5.2):
 *
 *   rawSavings = ((currentValue - targetValue) / currentValue) * monthlyCost
 *   savings    = clamp(rawSavings, 0, monthlyCost * cap)
 *
 * The cap defaults to {@link DEFAULT_RIGHTSIZING_PARAMS.savingsCapFraction}
 * (`0.7`), aligned with Requirement 5.2: a single recommendation cannot
 * claim more than 70% of the current monthly cost as savings, no matter
 * how aggressive the target.
 *
 * Guard clauses (design §Backend > rightsizing.ts):
 *
 *   - `currentValue <= 0`                     → `0` (nothing allocated, nothing to save; also avoids /0)
 *   - `targetValue >= currentValue`           → `0` (staying put or increasing yields no savings)
 *   - `monthlyCost <= 0`                      → `0` (no cost → no savings)
 *   - any input NaN / non-finite               → `0` (defensive; keeps callers total)
 *
 * The function satisfies **Property 9** (proved by
 * `rightsizing.prop09.property.test.ts`, task 5.6):
 *
 *   1. `estimateSavings(...) >= 0`.
 *   2. `estimateSavings(...) <= monthlyCost * cap` (when `cap >= 0`).
 *   3. `estimateSavings(current, current, monthlyCost, cap) === 0`.
 *   4. Monotone in `targetValue`: if `target2 <= target1` then
 *      `estimateSavings(current, target2, ...) >= estimateSavings(current, target1, ...)`.
 *
 * The function is pure: no I/O, no globals, deterministic in its inputs.
 *
 * @param currentValue Current allocation on the dimension (cores or bytes; SI canonical).
 * @param targetValue  Recommended target on the same dimension.
 * @param monthlyCost  Full monthly cost of the workload on that dimension (EUR).
 * @param cap          Maximum fraction of `monthlyCost` claimable as savings.
 *                     Defaults to `DEFAULT_RIGHTSIZING_PARAMS.savingsCapFraction`
 *                     (`0.7`, Requirement 5.2).
 * @returns The estimated monthly savings in EUR, always in
 *          `[0, monthlyCost * max(0, cap)]`.
 */
export function estimateSavings(
  currentValue: number,
  targetValue: number,
  monthlyCost: number,
  cap: number = DEFAULT_RIGHTSIZING_PARAMS.savingsCapFraction,
): number {
  if (
    !Number.isFinite(currentValue) ||
    !Number.isFinite(targetValue) ||
    !Number.isFinite(monthlyCost) ||
    !Number.isFinite(cap)
  ) {
    return 0;
  }
  if (monthlyCost <= 0) return 0;
  if (currentValue <= 0) return 0;
  if (targetValue >= currentValue) return 0;

  const safeCap = Math.max(0, cap);
  const rawSavings = ((currentValue - targetValue) / currentValue) * monthlyCost;
  const capLimit = monthlyCost * safeCap;
  const capped = Math.min(rawSavings, capLimit);
  return Math.max(0, capped);
}

/**
 * Apply the OOM-risk priority rule between `under-cpu` and `under-mem`
 * recommendations.
 *
 * Rule (design §Backend > rightsizing.ts, Requirement 4.3):
 *
 *   When a `(cluster, namespace, workload)` triple has **simultaneously**
 *   an `under-cpu` **and** an `under-mem` recommendation, only the
 *   `under-mem` one is emitted — memory pressure is more dangerous
 *   (OOMKilled → hard pod restart) than CPU throttling (soft degradation),
 *   so surfacing memory first prevents the on-call from acting on the
 *   less urgent signal and leaves CPU to a later iteration once memory
 *   is stabilised.
 *
 * Scope of the rule:
 *
 *   - `over-cpu` and `over-mem` recommendations are **never** dropped by
 *     this filter — they represent savings, not risk, and can coexist
 *     with any other kind on the same workload.
 *   - `under-cpu` is dropped **only** when an `under-mem` exists for the
 *     exact same `(cluster, namespace, workload)` triple. An isolated
 *     `under-cpu` (no matching `under-mem`) is preserved.
 *   - Input order is preserved for every recommendation that survives
 *     the filter. This keeps downstream ordering (e.g. `estimatedSavingsEur`
 *     DESC in `fetchRecommendations`) stable and makes the function safe
 *     to compose before or after sorting.
 *
 * The function is pure: no I/O, no globals, deterministic in its inputs.
 * It runs in O(n) with a single map of triples that carry an `under-mem`
 * recommendation.
 *
 * @param recs Input recommendations, typically produced by
 *             `fetchRecommendations` from the classified workloads.
 * @returns A new array containing the same recommendations minus the
 *          `under-cpu` entries that are shadowed by an `under-mem`
 *          on the same `(cluster, namespace, workload)`.
 *
 * @example
 * priorityFilter([
 *   { kind: "over-cpu", cluster: "dp-prd", namespace: "oms", workload: "api", ... },
 *   { kind: "under-cpu", cluster: "dp-prd", namespace: "oms", workload: "api", ... },
 *   { kind: "under-mem", cluster: "dp-prd", namespace: "oms", workload: "api", ... },
 * ])
 * // → [over-cpu, under-mem]   (under-cpu dropped: same triple has under-mem)
 */
export function priorityFilter(recs: Recommendation[]): Recommendation[] {
  const hasUnderMem = new Set<string>();
  for (const r of recs) {
    if (r.kind === "under-mem") {
      hasUnderMem.add(`${r.cluster}\u0000${r.namespace}\u0000${r.workload}`);
    }
  }
  return recs.filter((r) => {
    if (r.kind !== "under-cpu") return true;
    const key = `${r.cluster}\u0000${r.namespace}\u0000${r.workload}`;
    return !hasUnderMem.has(key);
  });
}

/* ------------------------------------------------------------------ */
/*  Orchestrator (task 5.11)                                           */
/* ------------------------------------------------------------------ */

import { NodeCostContext } from "@/lib/eks-cost/node-cost";
import { qVpaRecommendation } from "@/lib/eks-cost/promql";
import { formatCpu, formatMemory, roundCpu, roundMemory } from "@/lib/eks-cost/k8s-units";
import type { Warning as EksWarning } from "@/lib/eks-cost/types";

/**
 * Fraction of workloads above which the pipeline emits a single aggregated
 * `vpa-missing` warning (design §Backend > rightsizing.ts).
 * 0.95 → warn only when >95% of workloads lack a VPA entry — i.e. the VPA
 * pipeline is effectively down. VPA is only rolled out in some namespaces
 * (see steering §5 VPA pipeline: mostly dev/uat/prod websites/oms/marketplace,
 * tooling has zero VPAs by design), so a lower threshold produced permanent
 * noise. This warning is still filtered out of the UI by
 * `UI_VISIBLE_WARNING_CODES` in `eks-cost-dashboard.tsx`, but keeping it
 * strictly for real failures makes it useful for debugging.
 */
const VPA_MISSING_WARN_FRACTION = 0.95;

/** Cap output at 100 recommendations, mirroring the fachada in `index.ts`. */
const RECOMMENDATIONS_TOP_N = 100;

/** Sentinel used to build the `Map` key `<cluster>::<namespace>::<workload>`. */
const KEY_SEP = "\u0000";

const keyOf = (cluster: string, namespace: string, workload: string): string =>
  `${cluster}${KEY_SEP}${namespace}${KEY_SEP}${workload}`;

/** Truncate a query for structured logging (never leak tokens or full URLs). */
function shortSnippet(query: string): string {
  return query.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Strip common controller suffixes from a VPA `target_name` so it lines up
 * with the workload name produced by `normalizeWorkloadName(pod)` in
 * `node-cost.fetchWorkloads`.
 *
 * The VPA emits `target_name` as `<workload>-<controller-kind>` in many of
 * our namespaces (e.g. `my-orders-headless-deployment`,
 * `sonarqube-statefulset`) while pods are named `<workload>-<hash>-<hash>`.
 * We keep the base workload identity by dropping the trailing controller
 * suffix; anything without a known suffix is passed through unchanged.
 *
 * @internal
 */
function stripControllerSuffix(target: string): string {
  return target.replace(
    /-(deployment|statefulset|daemonset|replicaset|rollout)$/i,
    "",
  );
}

/**
 * Fetch the VPA memory upper-bound per `(cluster, namespace, workload)`
 * from Grafana. The join key on the workload side is
 * `stripControllerSuffix(target_name)` — the Deployment/StatefulSet the
 * VPA object points at (label `target_name`), with any `-deployment` /
 * `-statefulset` / `-daemonset` suffix removed so it matches the
 * pod-derived workload name produced by `node-cost.fetchWorkloads`.
 *
 * Wraps the query in `try/catch`; on failure emits a single
 * `metrics-partial-fail` warning and returns an empty map so the caller can
 * fall back to `vpaMemUpper = null` for every workload.
 *
 * @internal
 */
async function fetchVpaMemUpper(
  ctx: NodeCostContext,
  warnings: EksWarning[],
): Promise<{ map: Map<string, number>; ok: boolean }> {
  const source = "rightsizing.fetchRecommendations";
  const query = qVpaRecommendation("mem-upper");
  const started = Date.now();
  try {
    const { result } = await ctx.metrics.query(query);
    const map = new Map<string, number>();
    for (const row of result) {
      const cluster = row.metric.k8s_cluster_name;
      const namespace = row.metric.namespace;
      const target = row.metric.target_name;
      if (!cluster || !namespace || !target) continue;
      const stripped = stripControllerSuffix(target);
      const raw = Number(row.value?.[1] ?? 0);
      if (!Number.isFinite(raw) || raw <= 0) continue;
      // We index the VPA upperbound under BOTH the raw `target_name` and
      // the controller-stripped variant. Many of our namespaces (n8n,
      // harbor, sonarqube, platformportal, oms, etc.) emit VPAs whose
      // `target_name` already matches the Deployment name 1:1 (no
      // `-deployment` suffix), while others carry the suffix or a variant
      // like `-headless`. The lookup side (`fetchRecommendations`) tries
      // several key variants against this map, so a rich key set here
      // maximises join coverage without loosening the identity of the
      // recommendation.
      const rawKey = keyOf(cluster, namespace, target);
      const strippedKey = keyOf(cluster, namespace, stripped);
      const prevRaw = map.get(rawKey);
      if (prevRaw === undefined || raw > prevRaw) {
        map.set(rawKey, raw);
      }
      if (stripped !== target) {
        const prevStripped = map.get(strippedKey);
        if (prevStripped === undefined || raw > prevStripped) {
          map.set(strippedKey, raw);
        }
      }
    }
    console.info(
      `[eks-cost] vpaMemUpper ok in ${Date.now() - started}ms rows=${result.length} :: ${shortSnippet(query)}`,
    );
    return { map, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[eks-cost] vpaMemUpper failed after ${Date.now() - started}ms: ${message.slice(0, 200)} :: ${shortSnippet(query)}`,
    );
    warnings.push({
      code: "metrics-partial-fail",
      message: `Query "vpaMemUpper" failed: ${message.slice(0, 200)}`,
      source,
    });
    return { map: new Map(), ok: false };
  }
}

/**
 * Build the human-readable single-line `reason` string surfaced next to
 * every recommendation. Values are shown **per pod** so the numbers align
 * with what the user sees in the workload's manifest (a Deployment with
 * N replicas declares resources per pod, not for the whole workload).
 *
 * Format: `"p95 mem is 200Mi/pod; you request 512Mi/pod; recommended 256Mi/pod"`.
 *
 * @internal
 */
function buildReason(
  kind: RecommendationKind,
  workload: Workload,
  cpuTargetPerPod: number,
  memTargetPerPod: number,
  currentCpuPerPod: number,
  currentMemPerPod: number,
  p95CpuPerPod: number,
  p95MemPerPod: number,
): string {
  switch (kind) {
    case "over-cpu":
      return `p95 CPU es ${formatCpu(p95CpuPerPod)}/pod; requests ${formatCpu(currentCpuPerPod)}/pod; recomendado ${formatCpu(cpuTargetPerPod)}/pod`;
    case "over-mem":
      return `p95 memoria es ${formatMemory(p95MemPerPod)}/pod; requests ${formatMemory(currentMemPerPod)}/pod; recomendado ${formatMemory(memTargetPerPod)}/pod`;
    case "under-cpu":
      return `p95 CPU es ${formatCpu(p95CpuPerPod)}/pod; requests ${formatCpu(currentCpuPerPod)}/pod están por debajo; recomendado ${formatCpu(cpuTargetPerPod)}/pod`;
    case "under-mem":
      return `p95 memoria es ${formatMemory(p95MemPerPod)}/pod; requests ${formatMemory(currentMemPerPod)}/pod están por debajo; recomendado ${formatMemory(memTargetPerPod)}/pod`;
  }
}

/**
 * Materialise a single {@link Recommendation} for a workload/kind pair.
 *
 * Two units of measurement coexist and matter here:
 *
 *   - **Totales** (across all replicas) — used for the € impact.
 *     `estimatedSavingsEur` is derived from
 *     `estimateSavings(currentTotal, targetTotal, workload.monthlyCostEur, ...)`
 *     because the monthly cost we track is the sum over every pod of the
 *     workload; the savings need to be on the same axis.
 *
 *   - **Por pod** (divided by `podCount`) — used for every value shown
 *     to the user (`currentRequest.k8s`, `recommendedRequest.k8s`, the
 *     `reason` string and the `unitYamlBlock`). This is the number the
 *     operator will paste into the manifest, and it lines up with what
 *     `kubectl describe deployment` shows for `resources.requests`.
 *
 *   - `unitYamlBlock` always carries `requests.cpu`, `requests.memory`
 *     and `limits.memory` (Requirement 5.6, 10.3). The dimension NOT
 *     touched by this recommendation is passed through at its current
 *     per-pod allocation.
 *
 * @internal
 */
function buildRecommendation(
  kind: RecommendationKind,
  workload: Workload,
  cpuTargetCores: number,
  memTargetBytes: number,
  params: RightsizingParams,
): Recommendation {
  const podCount = Math.max(1, workload.podCount);
  const isCpu = kind === "over-cpu" || kind === "under-cpu";

  // Totals — used for € computation only.
  const currentTotal = isCpu
    ? workload.cpuRequestCores
    : workload.memRequestBytes;
  const targetTotal = isCpu ? cpuTargetCores : memTargetBytes;

  const estimatedSavingsEur = round2Rec(
    estimateSavings(
      currentTotal,
      targetTotal,
      workload.monthlyCostEur,
      params.savingsCapFraction,
    ),
  );

  // Per-pod projections — what the user sees, what goes into the YAML.
  const cpuRequestPerPod = workload.cpuRequestCores / podCount;
  const memRequestPerPod = workload.memRequestBytes / podCount;
  const cpuTargetPerPodRaw = cpuTargetCores / podCount;
  const memTargetPerPodRaw = memTargetBytes / podCount;
  const cpuTargetPerPod = roundCpu(cpuTargetPerPodRaw);
  const memTargetPerPod = roundMemory(memTargetPerPodRaw);
  const cpuP95PerPod = workload.cpuUsageP95Cores / podCount;
  const memP95PerPod = workload.memUsageP95Bytes / podCount;

  const currentPerPodValue = isCpu ? cpuRequestPerPod : memRequestPerPod;
  const targetPerPodValue = isCpu ? cpuTargetPerPod : memTargetPerPod;

  const currentK8s = isCpu
    ? formatCpu(cpuRequestPerPod)
    : formatMemory(memRequestPerPod);
  const recommendedK8s = isCpu
    ? formatCpu(cpuTargetPerPod)
    : formatMemory(memTargetPerPod);

  // The YAML block always carries per-pod cpu + memory; the "other"
  // dimension keeps its current per-pod allocation so the block is a
  // complete, apply-safe patch.
  const cpuYaml = isCpu ? recommendedK8s : formatCpu(cpuRequestPerPod);
  const memYaml = isCpu ? formatMemory(memRequestPerPod) : recommendedK8s;

  const reason = buildReason(
    kind,
    workload,
    cpuTargetPerPod,
    memTargetPerPod,
    cpuRequestPerPod,
    memRequestPerPod,
    cpuP95PerPod,
    memP95PerPod,
  );
  const unitYamlBlock = buildYamlBlock(
    workload.workload,
    workload.namespace,
    cpuYaml,
    memYaml,
    reason,
  );

  return {
    cluster: workload.cluster,
    environment: workload.environment,
    namespace: workload.namespace,
    workload: workload.workload,
    nodegroup: workload.nodegroup,
    squad: workload.squad,
    kind,
    currentRequest: { value: currentPerPodValue, k8s: currentK8s },
    recommendedRequest: { value: targetPerPodValue, k8s: recommendedK8s },
    estimatedSavingsEur,
    unitYamlBlock,
    reason,
  };
}

/** Round to 2 decimals (EUR). Local helper to avoid cross-module imports. */
function round2Rec(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Orchestrate the rightsizing pipeline for a batch of workloads.
 *
 * Pipeline (design §Backend > rightsizing.ts):
 *
 *   1. Fetch the VPA memory upper-bound from Grafana keyed by
 *      `(cluster, namespace, workload)`. Individual query failure never
 *      surfaces as a 5xx: it is turned into a `metrics-partial-fail`
 *      warning and the pipeline continues with `vpaMemUpper = null` for
 *      every workload.
 *
 *   2. For each workload:
 *        - Drop it when `w.monthlyCostEur < params.minMonthlyCostEur`
 *          (default `10€`) — noise floor to avoid recommending on tiny
 *          workloads whose cost signal is dominated by aggregation error.
 *        - Compute `cpuTarget = computeCpuTarget(w, params)` and
 *          `memTarget = computeMemTarget(w, vpaMemUpper, params)`.
 *        - `kinds = classifyOverUnder(w, cpuTarget, memTarget)`. The
 *          uptime filter (Requirement 3.7) lives inside the classifier
 *          when uptime data is available; the workloads produced by
 *          `fetchWorkloads` today do not carry uptime, so this
 *          orchestrator leaves that filter to the classifier's defaults.
 *        - For each kind, build a full {@link Recommendation} with
 *          canonical SI values, capped savings, and the copy-paste YAML
 *          block. `estimatedSavingsEur` is `0` for `under-*` (higher
 *          target than current) and non-negative for `over-*`.
 *
 *   3. Apply {@link priorityFilter} so `under-mem` shadows `under-cpu`
 *      on the same `(cluster, namespace, workload)` triple
 *      (Requirement 4.3, task 5.7).
 *
 *   4. Track VPA coverage: if the VPA query succeeded but more than
 *      {@link VPA_MISSING_WARN_FRACTION} (30%) of the surveyed workloads
 *      lack a VPA entry, emit a single aggregated `vpa-missing` warning.
 *      Skipped when the VPA fetch itself failed — that failure was
 *      already reported as a `metrics-partial-fail` warning by
 *      {@link fetchVpaMemUpper}, so avoiding a second warning keeps the
 *      response tidy.
 *
 *   5. Sort `recommendations` DESC by `estimatedSavingsEur` and cap at
 *      100 entries (matches the fachada in `index.ts`, aligned with the
 *      design's `top-100 by estimatedSavingsEur DESC`).
 *
 * The function is total — it never throws. Per-query failures are surfaced
 * as {@link EksWarning} entries alongside the recommendations, and the
 * caller is expected to propagate them into {@link AllocationResponse}.
 *
 * Note on the "under-*" savings contract: `estimateSavings(current, target,
 * ...)` returns `0` when `target >= current` (the under-provisioning case
 * always raises the request). The sort by `estimatedSavingsEur` therefore
 * pushes `under-*` recommendations to the bottom of the list; the UI
 * displays them separately as risk signals, not savings.
 *
 * @param ctx       Injected {@link NodeCostContext} (metrics client, FX rate,
 *                  hours/month, clock).
 * @param params    Rightsizing knobs — typically
 *                  {@link DEFAULT_RIGHTSIZING_PARAMS}.
 * @param workloads Attributed workloads produced by
 *                  `node-cost.fetchWorkloads`.
 * @returns The generated recommendations (top-100 by savings, DESC)
 *          plus the pipeline warnings.
 */
export async function fetchRecommendations(
  ctx: NodeCostContext,
  params: RightsizingParams,
  workloads: Workload[],
): Promise<{ recommendations: Recommendation[]; warnings: EksWarning[] }> {
  const warnings: EksWarning[] = [];

  // Step 1 — VPA memory upperbound with partial-fail semantics.
  const { map: vpaByKey, ok: vpaOk } = await fetchVpaMemUpper(ctx, warnings);

  // Steps 2 — classify + materialise recommendations.
  const raw: Recommendation[] = [];
  let coveredWorkloads = 0;
  let surveyed = 0;

  for (const w of workloads) {
    if (w.monthlyCostEur < params.minMonthlyCostEur) {
      continue;
    }
    surveyed += 1;

    // The workload name produced by `node-cost.fetchWorkloads` comes from
    // `normalizeWorkloadName(pod)`, which returns the Deployment/StatefulSet
    // identity (no controller suffix). VPA `target_name` labels observed in
    // the estate come in three flavours: (a) exact match with the workload
    // name (n8n, harbor, sonarqube, platformportal, oms, etc.); (b) with a
    // trailing `-deployment` / `-statefulset` / `-daemonset` suffix; and
    // (c) with a `-headless` variant on stateful services. We probe the
    // Map with all of them so the join hits regardless of which flavour
    // the VPA operator emits.
    const baseKey = keyOf(w.cluster, w.namespace, w.workload);
    const vpaMemUpper =
      vpaByKey.get(baseKey) ??
      vpaByKey.get(keyOf(w.cluster, w.namespace, `${w.workload}-deployment`)) ??
      vpaByKey.get(keyOf(w.cluster, w.namespace, `${w.workload}-statefulset`)) ??
      vpaByKey.get(keyOf(w.cluster, w.namespace, `${w.workload}-daemonset`)) ??
      vpaByKey.get(keyOf(w.cluster, w.namespace, `${w.workload}-headless`)) ??
      null;
    if (vpaMemUpper !== null) coveredWorkloads += 1;

    const cpuTarget = computeCpuTarget(w, params);
    const memTarget = computeMemTarget(w, vpaMemUpper, params);
    const kinds = classifyOverUnder(w, cpuTarget, memTarget);

    for (const kind of kinds) {
      raw.push(buildRecommendation(kind, w, cpuTarget, memTarget, params));
    }
  }

  // Step 3 — OOM-priority filter (under-mem shadows under-cpu).
  const prioritized = priorityFilter(raw);

  // Step 4 — VPA coverage warning.
  if (vpaOk && surveyed > 0) {
    const missingFraction = (surveyed - coveredWorkloads) / surveyed;
    if (missingFraction > VPA_MISSING_WARN_FRACTION) {
      const missing = surveyed - coveredWorkloads;
      const pct = Math.round(missingFraction * 100);
      warnings.push({
        code: "vpa-missing",
        message: `${missing} of ${surveyed} surveyed workloads (${pct}%) lack a VPA recommendation`,
        source: "rightsizing.fetchRecommendations",
      });
    }
  }

  // Step 5 — order DESC by estimated savings, cap at 100.
  prioritized.sort((a, b) => b.estimatedSavingsEur - a.estimatedSavingsEur);
  const recommendations = prioritized.slice(0, RECOMMENDATIONS_TOP_N);

  return { recommendations, warnings };
}
