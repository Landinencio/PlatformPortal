// Feature: eks-cost-optimization, Property 5: Squad aggregation preserves and orders workload totals
/**
 * Property-based test for `aggregateSquadCost(workloads, recommendations)`.
 *
 * Feature: eks-cost-optimization
 * Property 5: Squad aggregation preserves and orders workload totals
 *
 * Contract (see design.md §Node_Cost_Service > aggregateSquadCost and
 * Requirements 2.2, 2.3, 2.4):
 *
 *   1. Partition — every workload contributes to exactly one squad row, so
 *      `Σ squads[].workloadCount == workloads.length`.
 *   2. Cost preservation — `Σ squads[].monthlyCostEur == Σ workloads[].monthlyCostEur`
 *      within 0.01€ per squad bucket (accounts for the `round2` step applied
 *      to each squad total). The tolerance is scaled by the number of squads
 *      to stay honest about accumulated rounding.
 *   3. Order — squads are emitted in DESC order by `monthlyCostEur`.
 *   4. Fallback — workloads with an empty `squad` label are attributed to the
 *      `"sin asignar"` bucket (never dropped, never emitted under an empty
 *      squad name).
 *
 * `estimatedSavingsEur` of `over-*` recommendations feeds
 * `Squad.overprovisioningEur` but does not affect `monthlyCostEur` (which is
 * derived from workloads only), so the recommendations input only needs to be
 * a well-formed array; its individual values do not enter the assertions
 * except via the DESC-order check that squads survive with additional data.
 *
 * Conventions: node:test + node:assert/strict, fast-check ^4, { numRuns: 100 },
 * a `// Feature: ...` header comment on the file.
 *
 * **Validates: Requirements 2.2, 2.3, 2.4**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { aggregateSquadCost } from "@/lib/eks-cost/node-cost";
import type { Workload } from "@/lib/eks-cost/types";

import { arbWorkload, arbRecommendation } from "./generators";

/* ------------------------------------------------------------------ */
/*  Generators — workload variant that exercises the fallback branch    */
/* ------------------------------------------------------------------ */

/**
 * Variant of {@link arbWorkload} that sometimes emits `squad === ""`, so the
 * fallback to `"sin asignar"` is actually visited during property runs.
 * The base generator picks squads from a fixed catalog (including the
 * literal `"sin asignar"`), so without this rewrite we would never test the
 * *empty label* → *fallback* branch explicitly.
 */
const arbWorkloadMaybeEmptySquad: fc.Arbitrary<Workload> = arbWorkload.chain(
  (w) =>
    fc.oneof(
      { arbitrary: fc.constant(w), weight: 4 },
      { arbitrary: fc.constant({ ...w, squad: "" }), weight: 1 },
    ),
);

/* ------------------------------------------------------------------ */
/*  Property 5                                                          */
/* ------------------------------------------------------------------ */

test("Property 5: aggregateSquadCost preserves totals, partitions workloads, orders DESC and falls back to 'sin asignar'", () => {
  fc.assert(
    fc.property(
      fc.array(arbWorkloadMaybeEmptySquad, { minLength: 0, maxLength: 60 }),
      fc.array(arbRecommendation, { minLength: 0, maxLength: 40 }),
      (workloads, recommendations) => {
        const squads = aggregateSquadCost(workloads, recommendations);

        // ---- Structural: no duplicate squad rows in the output. Each squad
        // key must appear at most once (the aggregator uses a Map internally).
        const names = squads.map((s) => s.name);
        assert.equal(
          new Set(names).size,
          names.length,
          `output contains duplicate squad names: ${JSON.stringify(names)}`,
        );

        // ---- Structural: no squad row is emitted under an empty name.
        // Empty squad labels must be normalised to `"sin asignar"` by the
        // aggregator; leaking an empty string as a bucket key would be a bug.
        for (const sq of squads) {
          assert.notEqual(
            sq.name,
            "",
            "aggregateSquadCost emitted a squad row with an empty name",
          );
        }

        // ---- Partition: each workload contributes to exactly one squad, so
        // the sum of `workloadCount` across squads equals the input length.
        const totalWorkloadCount = squads.reduce(
          (sum, sq) => sum + sq.workloadCount,
          0,
        );
        assert.equal(
          totalWorkloadCount,
          workloads.length,
          `partition: Σ workloadCount=${totalWorkloadCount} != workloads.length=${workloads.length}`,
        );

        // ---- Cost preservation: `Σ squads[].monthlyCostEur` matches
        // `Σ workloads[].monthlyCostEur` up to the `round2` error each squad
        // bucket introduces. Bound: 0.005€/squad plus a tiny float epsilon,
        // floored at 0.01€ so the property is meaningful even with 0-1 squads.
        const sumSquads = squads.reduce((sum, sq) => sum + sq.monthlyCostEur, 0);
        const sumWorkloads = workloads.reduce(
          (sum, w) => sum + w.monthlyCostEur,
          0,
        );
        const tolerance = Math.max(0.01, 0.005 * squads.length + 1e-6);
        assert.ok(
          Math.abs(sumSquads - sumWorkloads) < tolerance,
          `cost preservation: |Σsquads=${sumSquads} - Σworkloads=${sumWorkloads}| >= ${tolerance} (squads=${squads.length})`,
        );

        // ---- Order: squads must be emitted DESC by `monthlyCostEur`. Ties
        // are allowed (stable insertion order); we only enforce non-increase.
        for (let i = 1; i < squads.length; i++) {
          assert.ok(
            squads[i - 1].monthlyCostEur >= squads[i].monthlyCostEur,
            `order: squads[${i - 1}].monthlyCostEur=${squads[i - 1].monthlyCostEur} < squads[${i}].monthlyCostEur=${squads[i].monthlyCostEur}`,
          );
        }

        // ---- Fallback: any workload with an empty `squad` label must be
        // absorbed by the `"sin asignar"` bucket. If we generated at least
        // one such workload, the output must contain that bucket AND its
        // `workloadCount` must be at least the number of empty-labelled
        // workloads (the bucket also absorbs explicit `squad === "sin asignar"`).
        const emptySquadWorkloads = workloads.filter((w) => !w.squad);
        if (emptySquadWorkloads.length > 0) {
          const fallback = squads.find((sq) => sq.name === "sin asignar");
          assert.ok(
            fallback,
            `fallback: expected a 'sin asignar' bucket for ${emptySquadWorkloads.length} empty-squad workload(s)`,
          );
          assert.ok(
            fallback!.workloadCount >= emptySquadWorkloads.length,
            `fallback: 'sin asignar'.workloadCount=${fallback!.workloadCount} < empty-squad workloads=${emptySquadWorkloads.length}`,
          );
        }
      },
    ),
    { numRuns: 100 },
  );
});
