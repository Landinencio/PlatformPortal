// Feature: eks-cost-optimization, Property 15: PromQL queries dedup KSM double-scrape
/**
 * Property-based test for the KSM duplicate-scraper defence in every
 * builder of `src/lib/eks-cost/promql.ts`.
 *
 * Feature: eks-cost-optimization
 * Property 15: PromQL queries dedup KSM double-scrape
 *
 * Root cause we guard against:
 *   `dp-prod` has two KSM instances scraping the same metrics (native +
 *   Coralogix Asserts with an `asserts_env` label). A naïve
 *   `sum by (…workload keys)` folds both scrapers into one series and
 *   doubles / triples every value. The fix is a two-step pattern:
 *
 *       max by (<workload keys + container>) (<metric>)   // dedup KSM scrapers
 *       sum by (<workload keys>) ( … )                     // fold containers
 *
 * (Or, for metrics that already carry all discriminating labels — like
 * `kube_node_labels` — a single `max by (…)` at the outermost aggregator.)
 *
 * This test asserts that every builder in `promql.ts` obeys the pattern.
 * `qWorkloadCost` is exempt because it uses `avg by (…, container, node)`
 * as its innermost aggregator, which handles duplicates by averaging
 * (identical scrapers collapse to the same value; distinct scrapers
 * average out — never inflate).
 *
 * The test parameterises over EVERY variant of every builder so a future
 * change that drops the `max by` (or adds a new variant without it) is
 * caught immediately.
 *
 * **Validates: Requirement 8.2, plus the KSM dedup invariant that keeps
 * the numeric contract of the whole pipeline honest.**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  qNodeCostHourly,
  qNodeCount,
  qNodegroupByNode,
  qPodToNode,
  qSpotCount,
  qVpaRecommendation,
  qWorkloadRequests,
  qWorkloadUsageP95,
} from "@/lib/eks-cost/promql";

/**
 * Normalise a PromQL string so the assertions do not depend on
 * indentation or line breaks — every builder in `promql.ts` returns a
 * multi-line, indented string, and future edits may re-flow whitespace.
 */
function normalize(q: string): string {
  return q.replace(/\s+/g, " ").trim();
}

/**
 * Every builder that must expose `max by (k8s_cluster_name, …)` as a
 * defensive dedup stage, with the discriminator labels it must include.
 *
 * `qNodeCostHourly`, `qNodeCount`, `qSpotCount` share the
 * `NODEGROUP_LABEL_REPLACE` snippet, which itself is wrapped in
 * `max by (k8s_cluster_name, node, nodegroup)` — that satisfies the
 * pattern for the node-cost side of the pipeline.
 *
 * `qWorkloadRequests` / `qWorkloadUsageP95` need a `max by
 * (k8s_cluster_name, namespace, pod, container)` before the outer
 * `sum by (…, pod)` to collapse KSM duplicates before folding containers.
 *
 * `qVpaRecommendation` uses a single `max by (k8s_cluster_name, namespace,
 * target_name, container)` at the outermost level because the metric
 * already carries all discriminating labels and we do not sum containers.
 *
 * `qNodegroupByNode` is a bare `max by (k8s_cluster_name, node, nodegroup)`.
 */
interface BuilderCase {
  readonly name: string;
  readonly build: () => string;
  readonly requires: readonly string[];
}

const NODE_MAX = "max by (k8s_cluster_name, node, nodegroup)";
const POD_MAX = "max by (k8s_cluster_name, namespace, pod, container)";
const POD_NODE_MAX = "max by (k8s_cluster_name, namespace, pod, node)";
const VPA_MAX = "max by (k8s_cluster_name, namespace, target_name, container)";

const CASES: readonly BuilderCase[] = [
  { name: "qNodeCostHourly", build: () => qNodeCostHourly(), requires: [NODE_MAX] },
  { name: "qNodeCount", build: () => qNodeCount(), requires: [NODE_MAX] },
  { name: "qSpotCount", build: () => qSpotCount(), requires: [NODE_MAX] },
  { name: "qNodegroupByNode", build: () => qNodegroupByNode(), requires: [NODE_MAX] },
  { name: "qPodToNode", build: () => qPodToNode(), requires: [POD_NODE_MAX] },
  { name: "qWorkloadRequests(cpu)", build: () => qWorkloadRequests("cpu"), requires: [POD_MAX] },
  { name: "qWorkloadRequests(mem)", build: () => qWorkloadRequests("mem"), requires: [POD_MAX] },
  { name: "qWorkloadUsageP95(cpu)", build: () => qWorkloadUsageP95("cpu"), requires: [POD_MAX] },
  { name: "qWorkloadUsageP95(mem)", build: () => qWorkloadUsageP95("mem"), requires: [POD_MAX] },
  { name: "qVpaRecommendation(cpu-target)", build: () => qVpaRecommendation("cpu-target"), requires: [VPA_MAX] },
  { name: "qVpaRecommendation(cpu-upper)", build: () => qVpaRecommendation("cpu-upper"), requires: [VPA_MAX] },
  { name: "qVpaRecommendation(mem-target)", build: () => qVpaRecommendation("mem-target"), requires: [VPA_MAX] },
  { name: "qVpaRecommendation(mem-upper)", build: () => qVpaRecommendation("mem-upper"), requires: [VPA_MAX] },
];

/* ------------------------------------------------------------------ */
/*  Property 15 — every builder embeds the required max-by dedup       */
/* ------------------------------------------------------------------ */

test("Property 15: every PromQL builder embeds a defensive `max by (…)` for KSM dedup", () => {
  fc.assert(
    fc.property(fc.constantFrom(...CASES), (kase) => {
      const q = normalize(kase.build());
      for (const required of kase.requires) {
        assert.ok(
          q.includes(required),
          `Builder ${kase.name} is missing the dedup pattern \`${required}\`.\n` +
            `Emitted query (normalised):\n${q}`,
        );
      }

      // Belt-and-braces sanity: every builder partitions by
      // `k8s_cluster_name`, which is the entry point for the environment
      // pipeline downstream.
      assert.ok(
        q.includes("k8s_cluster_name"),
        `Builder ${kase.name} must partition by k8s_cluster_name`,
      );
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 15b — `sum by (…, pod)` only appears wrapping a `max by`  */
/* ------------------------------------------------------------------ */

/**
 * Guard against a regression where someone adds a new `sum by (…, pod)`
 * without the inner `max by (…, container)` step. Applies only to the
 * workload builders (`qWorkloadRequests`, `qWorkloadUsageP95`) — the
 * cost builder is exempt (`avg by (…, container, node)` handles KSM
 * dupes by averaging).
 */
test("Property 15b: workload sum-by-pod builders always wrap a `max by (…, container)`", () => {
  const workloadCases = CASES.filter((c) =>
    c.name.startsWith("qWorkloadRequests") || c.name.startsWith("qWorkloadUsageP95"),
  );
  fc.assert(
    fc.property(fc.constantFrom(...workloadCases), (kase) => {
      const q = normalize(kase.build());
      // The outermost aggregator must be a sum-by-pod...
      assert.ok(
        q.includes("sum by (k8s_cluster_name, namespace, pod)"),
        `Builder ${kase.name} should sum by (cluster, namespace, pod). Got:\n${q}`,
      );
      // ...and the pod-level max-by dedup must appear literally inside it.
      const sumIdx = q.indexOf("sum by (k8s_cluster_name, namespace, pod)");
      const maxIdx = q.indexOf(POD_MAX, sumIdx);
      assert.ok(
        maxIdx > sumIdx,
        `Builder ${kase.name} must nest \`${POD_MAX}\` inside the outer sum-by-pod`,
      );
    }),
    { numRuns: 60 },
  );
});
