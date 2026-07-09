/**
 * PromQL query builders for the EKS Cost Optimization module.
 *
 * These are **pure functions** — they only compose query strings, never fetch.
 * Keeping them pure enables snapshot testing (task 3.2) and guarantees that
 * two invariants of the design are always preserved:
 *
 *   1. Every query partitions by `(k8s_cluster_name, …)` so results can be
 *      grouped per EKS cluster / environment downstream.
 *
 *   2. Byte-scale divisions (`/(1024*1024*1024)`) live **inside** the
 *      innermost `sum by (…)` / `avg by (…)`. Doing the division outside
 *      would strip labels used in the join (portal gotcha #7).
 *
 * Additionally, spot counts follow the Mimir gotcha #6: filter with
 * `> 0` and wrap in `count by (…)`. Using `kubecost_node_is_spot == 1`
 * directly does not work reliably on Mimir.
 *
 * See:
 *   - `.kiro/specs/eks-cost-optimization/design.md` §Data Models > PromQL canónico
 *   - `.kiro/steering/portal-architecture.md` §10 gotchas #6, #7
 */

/**
 * Hours per month used for `hourly * 730` → monthly cost. Standard cloud
 * convention (also used by `k8s-finops.ts`). Kept here so that any consumer
 * of a PromQL builder has the constant at hand.
 */
export const HOURS_PER_MONTH = 730;

/**
 * Reusable snippet that re-projects the canonical EKS nodegroup label
 * (`label_eks_amazonaws_com_nodegroup`, as exposed by kube-state-metrics on
 * `kube_node_labels`) to a shorter series label called `nodegroup`.
 *
 * Deduplicated with `max by (k8s_cluster_name, node, nodegroup)` because
 * some clusters (notably `dp-prod`) have two KSM instances scraping the
 * same nodes with different `job`/`asserts_env` labels — without the
 * `max by` the downstream `group_left(nodegroup)` join fails with
 * `found duplicate series for the match group`.
 *
 * Kept as a private constant so every query that needs the nodegroup label
 * uses the exact same projection (important for query snapshots and for the
 * `on (…) group_left(nodegroup)` joins to line up).
 */
const NODEGROUP_LABEL_REPLACE = `max by (k8s_cluster_name, node, nodegroup) (
      label_replace(
        kube_node_labels,
        "nodegroup",
        "$1",
        "label_eks_amazonaws_com_nodegroup",
        "(.+)"
      )
    )`;

/**
 * Hourly cost of nodes, grouped by `(k8s_cluster_name, nodegroup)`.
 *
 * `node_total_hourly_cost` is emitted per node by OpenCost. We join with
 * `kube_node_labels` to bring the nodegroup label onto every sample. Nodes
 * without a nodegroup label fall out of the result set (the caller emits
 * a `no-nodegroup-label` warning when this happens).
 */
export function qNodeCostHourly(): string {
  return `sum by (k8s_cluster_name, nodegroup) (
  node_total_hourly_cost
  * on (k8s_cluster_name, node) group_left(nodegroup)
    ${NODEGROUP_LABEL_REPLACE}
)`;
}

/**
 * Count of nodes per `(k8s_cluster_name, nodegroup)`. Derived from
 * `kube_node_labels` (one sample per node) with the nodegroup projection.
 */
export function qNodeCount(): string {
  return `count by (k8s_cluster_name, nodegroup) (
  ${NODEGROUP_LABEL_REPLACE}
)`;
}

/**
 * Count of spot nodes per `(k8s_cluster_name, nodegroup)`.
 *
 * Uses `kubecost_node_is_spot > 0` (Mimir gotcha #6). The multiplication by
 * `kube_node_labels` (via `label_replace`) brings the nodegroup label onto
 * each spot-node sample so the outer `count by` can group correctly.
 */
export function qSpotCount(): string {
  return `count by (k8s_cluster_name, nodegroup) (
  (kubecost_node_is_spot > 0)
  * on (k8s_cluster_name, node) group_left(nodegroup)
    ${NODEGROUP_LABEL_REPLACE}
)`;
}

/**
 * Hourly cost attributed to each workload for either the CPU or RAM
 * dimension, keyed by `(k8s_cluster_name, namespace, pod)`.
 *
 * For `kind === "ram"` the byte-scale division `/(1024*1024*1024)` sits
 * **inside** the innermost `avg by (…)` (portal gotcha #7). Doing it
 * outside would strip the labels used in the `on (k8s_cluster_name, node)`
 * join and break attribution.
 *
 * The inner `avg by (…, container, node)` already collapses duplicate
 * KSM scrapers so the outer `sum` never triples containers in `dp-prod`
 * (same bug pattern as `qWorkloadRequests` — see that comment for the
 * root cause).
 */
export function qWorkloadCost(kind: "cpu" | "ram"): string {
  if (kind === "cpu") {
    return `sum by (k8s_cluster_name, namespace, pod) (
  avg by (k8s_cluster_name, namespace, pod, container, node)
    (container_cpu_allocation)
  * on (k8s_cluster_name, node) group_left()
    avg by (k8s_cluster_name, node) (node_cpu_hourly_cost)
)`;
  }
  return `sum by (k8s_cluster_name, namespace, pod) (
  avg by (k8s_cluster_name, namespace, pod, container, node)
    (container_memory_allocation_bytes / (1024*1024*1024))
  * on (k8s_cluster_name, node) group_left()
    avg by (k8s_cluster_name, node) (node_ram_hourly_cost)
)`;
}

/**
 * Current workload requests summed at the pod level:
 *   - `kind === "cpu"` → cores.
 *   - `kind === "mem"` → bytes.
 *
 * The inner `max by (…, container)` collapses duplicate series that appear
 * in `dp-prod` (two KSM instances scraping — native + Coralogix Asserts
 * with `asserts_env`) before the outer `sum` folds containers into a pod.
 * Without the `max` step the sum triples every value in prod.
 *
 * Filters out sidecars named `POD` and empty container labels (cAdvisor
 * emits synthetic series for these).
 */
export function qWorkloadRequests(kind: "cpu" | "mem"): string {
  const resource = kind === "cpu" ? "cpu" : "memory";
  return `sum by (k8s_cluster_name, namespace, pod) (
  max by (k8s_cluster_name, namespace, pod, container) (
    kube_pod_container_resource_requests{resource="${resource}",container!="",container!="POD"}
  )
)`;
}

/**
 * p95 usage over 3 days for a workload:
 *   - `kind === "cpu"` → cores (rate on
 *     `container_cpu_usage_seconds_total`, 5m subquery step over 3d).
 *   - `kind === "mem"` → bytes (`container_memory_working_set_bytes`).
 *
 * Window narrowed from 7d to 3d after production timeouts (`This operation
 * was aborted`) — the wider window pushed the query past Grafana Cloud's
 * ~30 s deadline. 3d covers a full week's weekday+weekend pattern and
 * stays inside the deadline; the resulting target only differs from the
 * 7d one on workloads whose usage changes dramatically week-to-week,
 * which is exactly the case we want to react to sooner anyway.
 *
 * Deduplicated with `max by (…, container)` for the same reason as
 * {@link qWorkloadRequests}: cAdvisor is only scraped once, but future
 * multi-scraper setups (or a mis-configured Alloy) could double the
 * container-level series. The `max` is defensive at negligible cost.
 *
 * Filters out sidecars named `POD` and empty container labels, then sums by
 * `(k8s_cluster_name, namespace, pod)` so the result lines up with
 * `qWorkloadRequests` and `qWorkloadCost`.
 */
export function qWorkloadUsageP95(kind: "cpu" | "mem"): string {
  if (kind === "cpu") {
    return `sum by (k8s_cluster_name, namespace, pod) (
  max by (k8s_cluster_name, namespace, pod, container) (
    quantile_over_time(0.95,
      rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])
      [3d:5m]
    )
  )
)`;
  }
  return `sum by (k8s_cluster_name, namespace, pod) (
  max by (k8s_cluster_name, namespace, pod, container) (
    quantile_over_time(0.95,
      container_memory_working_set_bytes{container!="",container!="POD"}[3d]
    )
  )
)`;
}

/**
 * VPA recommendation lookup keyed by
 * `(k8s_cluster_name, namespace, target_name, container)`.
 *
 * `target_name` is the Deployment/StatefulSet name the VPA points at
 * (e.g. `my-orders-headless-deployment`). We use that label — NOT
 * `verticalpodautoscaler`, which is the internal pod name of the KSM
 * scraper — because callers match VPA rows by the workload's
 * Deployment/StatefulSet identity, not by the KSM pod identity.
 *
 * The inner `max by (…)` deduplicates the two KSM-vpa scrapers running in
 * `dp-prod` (native + Coralogix Asserts with `asserts_env`). Without it a
 * plain `sum by` would double every upper-bound and the anti-OOM floor
 * would push memory recommendations way too high.
 *
 * The four kinds map to the four VPA-recommender metrics emitted by the
 * standalone `ksm-vpa` deployment (portal §5, VPA pipeline):
 *   - `cpu-target` — steady-state target CPU (cores).
 *   - `cpu-upper`  — upper-bound CPU (cores).
 *   - `mem-target` — steady-state target memory (bytes).
 *   - `mem-upper`  — upper-bound memory (bytes). Used by
 *     `rightsizing.computeMemTarget` as an anti-OOM floor.
 */
export function qVpaRecommendation(
  kind: "cpu-target" | "cpu-upper" | "mem-target" | "mem-upper",
): string {
  const metric = {
    "cpu-target":
      "kube_customresource_verticalpodautoscaler_recommendation_cpu_target_cores",
    "cpu-upper":
      "kube_customresource_verticalpodautoscaler_recommendation_cpu_upperbound_cores",
    "mem-target":
      "kube_customresource_verticalpodautoscaler_recommendation_memory_target_bytes",
    "mem-upper":
      "kube_customresource_verticalpodautoscaler_recommendation_memory_upperbound_bytes",
  }[kind];

  return `max by (k8s_cluster_name, namespace, target_name, container) (
  ${metric}
)`;
}

/**
 * Node → nodegroup mapping used by the workload-to-nodegroup attribution
 * step (`node-cost.attributeWorkloadCostToNodegroup`).
 *
 * Returns one series per `(k8s_cluster_name, node)` with a `nodegroup`
 * label re-projected from the canonical EKS label. The caller counts, for
 * each workload, how many of its pods run on each nodegroup and picks the
 * dominant one.
 */
export function qNodegroupByNode(): string {
  return `max by (k8s_cluster_name, node, nodegroup) (
  ${NODEGROUP_LABEL_REPLACE}
)`;
}

/**
 * Pod → node mapping: one row per `(k8s_cluster_name, namespace, pod, node)`.
 *
 * Powered by KSM `kube_pod_info`, which carries the node the pod was
 * scheduled onto. Combined with {@link qNodegroupByNode}, this lets the
 * pipeline attribute each individual pod to its actual nodegroup — the
 * previous "majority nodegroup per cluster" heuristic broke the
 * `?nodegroup=…` filter because every workload in a cluster ended up
 * with the same tag.
 *
 * Deduplicated with `max by (…, node)` because `dp-prod` runs two KSM
 * scrapers (native + Coralogix Asserts) that emit `kube_pod_info` twice.
 * `node!=""` filters out pending / unscheduled pods that would leak
 * through with an empty node label.
 */
export function qPodToNode(): string {
  return `max by (k8s_cluster_name, namespace, pod, node) (
  kube_pod_info{node!=""}
)`;
}
