// Feature: eks-cost-optimization, Property 4: Attribution is conservative per node
/**
 * Property-based test for the conservative-cap invariant of
 * `attributeWorkloadCostToNodegroup`.
 *
 * Feature: eks-cost-optimization
 * Property 4: Attribution is conservative per node
 *
 * Contract (see design.md §Node_Cost_Service and Requirement 2.1):
 *
 *   For every (cluster, nodegroup) key present in `workloadsByNodegroup`
 *   for which a matching Nodegroup exists in the input list:
 *
 *     Σ (w.monthlyCostEur ∀ w ∈ workloadsByNodegroup.get(key))
 *       ≤ ng.monthlyCostEur + 0.005 * ng.monthlyCostEur
 *
 *     -- OR --
 *
 *     `warnings` contains an entry with `code === "metrics-partial-fail"`
 *     whose `message` references the same key.
 *
 * The 0.5% tolerance absorbs the system daemonsets (kube-proxy, aws-node,
 * ebs-csi, alloy, ...) that live on every node but do not appear as regular
 * workloads. When the sum genuinely exceeds the nodegroup cost the
 * aggregator MUST NOT mutate the numbers — it only records a
 * `metrics-partial-fail` warning so the UI can flag the discrepancy.
 *
 * Additional invariants exercised alongside the OR-cap:
 *
 *   - Workloads whose resolved nodegroup is `"unknown"` (or empty) are
 *     dropped from the map and surface a single aggregated
 *     `no-nodegroup-label` warning (Requirement 2.1: unattributable costs
 *     stay visible, they are never silently dropped).
 *   - `workloadsByNodegroup` never contains `NaN` / `Infinity` monetary
 *     values (defensive against upstream data errors).
 *
 * Conventions: node:test + node:assert/strict, fast-check ^4,
 * { numRuns: 100 }, header comment `// Feature: ...`.
 *
 * **Validates: Requirements 2.1**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { attributeWorkloadCostToNodegroup } from "@/lib/eks-cost/node-cost";
import type { Nodegroup, Workload } from "@/lib/eks-cost/types";
import { arbNodegroup, arbWorkload } from "./generators";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** 0.5% tolerance for system daemonsets on top of the nodegroup cost. */
const CAP_TOLERANCE = 0.005;

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Deduplicate a list of nodegroups by their canonical `<cluster>/<name>`
 * key. Keeps the first occurrence so the key→ng lookup in the property
 * body is unambiguous (the aggregator uses last-write-wins in its internal
 * map, but that is an implementation detail we do not want to depend on).
 */
function dedupeNodegroups(rawNgs: Nodegroup[]): Nodegroup[] {
  const seen = new Set<string>();
  const out: Nodegroup[] = [];
  for (const ng of rawNgs) {
    const key = `${ng.cluster}/${ng.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ng);
  }
  return out;
}

/**
 * Re-home a workload onto a target nodegroup so the aggregator's
 * `<cluster>/<nodegroup>` key match fires and the property actually
 * exercises the cap. Preserves every other field, including the workload's
 * monthly cost (which is what drives the sum vs cap comparison).
 */
function pinToNodegroup(w: Workload, ng: Nodegroup): Workload {
  return {
    ...w,
    cluster: ng.cluster,
    environment: ng.environment,
    nodegroup: ng.name,
  };
}

/* ------------------------------------------------------------------ */
/*  Property 4 — main OR-cap invariant                                 */
/* ------------------------------------------------------------------ */

test("Property 4: attribution stays within the nodegroup cost + 0.5% or emits metrics-partial-fail", () => {
  fc.assert(
    fc.property(
      fc.array(arbNodegroup, { minLength: 1, maxLength: 5 }),
      fc.array(arbWorkload, { minLength: 0, maxLength: 25 }),
      (rawNgs, rawWorkloads) => {
        const nodegroups = dedupeNodegroups(rawNgs);
        // Deterministic mix that exercises the three interesting code paths:
        //   - i % 6 === 5 → force nodegroup="unknown" (no-nodegroup-label path)
        //   - i % 4 === 0 → leave the generated workload as-is (may or may
        //     not accidentally match a nodegroup's short name; when it does
        //     not, it falls off the map and the OR-cap does not apply)
        //   - otherwise    → pin to a real nodegroup so the sum vs cap
        //     invariant is actually stressed
        const workloads: Workload[] = rawWorkloads.map((w, i) => {
          if (i % 6 === 5) return { ...w, nodegroup: "unknown" };
          if (i % 4 === 0) return w;
          const ng = nodegroups[i % nodegroups.length];
          return pinToNodegroup(w, ng);
        });

        const { workloadsByNodegroup, warnings } =
          attributeWorkloadCostToNodegroup(workloads, nodegroups);

        // Rebuild the cluster/name → ng map exactly the way the aggregator
        // does, so we can look up the cap for every key in the result.
        const nodegroupByKey = new Map<string, Nodegroup>();
        for (const ng of nodegroups) {
          nodegroupByKey.set(`${ng.cluster}/${ng.name}`, ng);
        }

        /* --- OR-cap invariant --- */
        for (const [key, list] of workloadsByNodegroup.entries()) {
          const ng = nodegroupByKey.get(key);
          if (!ng) {
            // The workload's short nodegroup name collides with no real
            // nodegroup — the aggregator does not enforce a cap here, so
            // this branch is out of scope for Property 4.
            continue;
          }
          const total = list.reduce((s, w) => s + w.monthlyCostEur, 0);
          const cap = ng.monthlyCostEur * (1 + CAP_TOLERANCE);
          const hasWarning = warnings.some(
            (w) =>
              w.code === "metrics-partial-fail" && w.message.includes(key),
          );
          assert.ok(
            total <= cap || hasWarning,
            `Attribution not conservative for ${key}: total=${total}, ` +
              `cap=${cap} (ng.monthlyCostEur=${ng.monthlyCostEur}), ` +
              `metrics-partial-fail=${hasWarning}`,
          );
        }

        /* --- no "unknown" workload leaks into the map --- */
        for (const [, list] of workloadsByNodegroup.entries()) {
          for (const w of list) {
            assert.notEqual(
              w.nodegroup,
              "unknown",
              "unknown-nodegroup workload leaked into workloadsByNodegroup",
            );
            assert.notEqual(
              w.nodegroup,
              "",
              "empty-nodegroup workload leaked into workloadsByNodegroup",
            );
          }
        }

        /* --- no-nodegroup-label warning is aggregated (0 or 1) --- */
        const unknownCount = workloads.filter(
          (w) => !w.nodegroup || w.nodegroup === "unknown",
        ).length;
        const noLabelWarnings = warnings.filter(
          (w) => w.code === "no-nodegroup-label",
        );
        if (unknownCount > 0) {
          assert.equal(
            noLabelWarnings.length,
            1,
            `expected exactly one aggregated no-nodegroup-label warning for ` +
              `${unknownCount} unknown workload(s), got ${noLabelWarnings.length}`,
          );
        } else {
          assert.equal(
            noLabelWarnings.length,
            0,
            "no-nodegroup-label warning emitted with zero unknown workloads",
          );
        }

        /* --- no NaN / Infinity slips through the attribution --- */
        for (const [, list] of workloadsByNodegroup.entries()) {
          for (const w of list) {
            assert.ok(
              Number.isFinite(w.monthlyCostEur),
              `non-finite monthlyCostEur ${w.monthlyCostEur} for ${w.workload}`,
            );
          }
        }
      },
    ),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 4 — cap is actually exercised (warning path)              */
/* ------------------------------------------------------------------ */

/**
 * Complementary property that DELIBERATELY constructs scenarios where the
 * workload sum exceeds the nodegroup cost, to make sure the
 * `metrics-partial-fail` warning is not just theoretical.
 *
 * Strategy: pick one arbitrary nodegroup, clamp its `monthlyCostEur` to a
 * tiny value (1€), and re-home every generated workload onto it with a
 * cost of 100€. The sum is then guaranteed to exceed the cap by orders of
 * magnitude — the aggregator MUST surface a `metrics-partial-fail` warning
 * whose message references the `<cluster>/<name>` key.
 */
test("Property 4 (warning path): metrics-partial-fail is emitted whenever the sum exceeds the cap", () => {
  fc.assert(
    fc.property(
      arbNodegroup,
      fc.array(arbWorkload, { minLength: 1, maxLength: 10 }),
      (baseNg, rawWorkloads) => {
        // Force a nodegroup with a tiny cost so the sum trivially exceeds it.
        const ng: Nodegroup = { ...baseNg, monthlyCostEur: 1 };
        // Re-home every workload onto that nodegroup with a cost of 100€.
        const workloads: Workload[] = rawWorkloads.map((w) => ({
          ...pinToNodegroup(w, ng),
          monthlyCostEur: 100,
        }));

        const { workloadsByNodegroup, warnings } =
          attributeWorkloadCostToNodegroup(workloads, [ng]);
        const key = `${ng.cluster}/${ng.name}`;
        const list = workloadsByNodegroup.get(key);

        // Every workload was routed to the single nodegroup.
        assert.ok(
          list && list.length === workloads.length,
          `expected ${workloads.length} workloads at ${key}, got ${list?.length ?? 0}`,
        );
        const total = list!.reduce((s, w) => s + w.monthlyCostEur, 0);
        // Sanity: our construction actually blew past the cap.
        assert.ok(
          total > ng.monthlyCostEur * (1 + CAP_TOLERANCE),
          `test construction did not exceed the cap: total=${total}, cap=${ng.monthlyCostEur}`,
        );
        // Contract: `metrics-partial-fail` is emitted and references the key.
        const hasWarning = warnings.some(
          (w) => w.code === "metrics-partial-fail" && w.message.includes(key),
        );
        assert.ok(
          hasWarning,
          `metrics-partial-fail warning expected for ${key} ` +
            `(total=${total}, ng.monthlyCostEur=${ng.monthlyCostEur}); ` +
            `got warnings=${JSON.stringify(warnings)}`,
        );
      },
    ),
    { numRuns: 100 },
  );
});
