// Feature: eks-cost-optimization, Property 2: Environment aggregation preserves nodegroup totals
/**
 * Property-based test for `aggregateEnvironments` in
 * `src/lib/eks-cost/node-cost.ts`.
 *
 * Feature: eks-cost-optimization
 * Property 2: Environment aggregation preserves nodegroup totals
 *
 * Contract (see design.md §Node_Cost_Service and Requirements 1.1, 1.2, 1.3,
 * 1.5, 1.6):
 *
 *   For any list of `Nodegroup[]`, `aggregateEnvironments(nodegroups)` groups
 *   them by `environment` and produces one `Environment` per distinct name
 *   found in the input. For every produced environment `env`:
 *
 *     - `env.monthlyCostEur ≈ Σ nodegroups[env].monthlyCostEur`   (± 0.01€)
 *     - `env.nodeCount     = Σ nodegroups[env].nodeCount`         (exact)
 *     - `env.spotCount     = Σ nodegroups[env].spotCount`         (exact)
 *     - `env.spotCoveragePct ∈ [0, 100]`
 *     - `env.cluster ∈ { "dp-dev", "dp-uat", "dp-prd", "dp-tooling" }`
 *
 * The 0.01€ tolerance absorbs the `round2` step the aggregator applies on top
 * of a sum of values that are already 2-decimal rounded — the reference sum
 * itself is not guaranteed to be a 2-decimal number.
 *
 * Uses fast-check with `{ numRuns: 100 }`, `arbNodegroup` (which produces
 * nodegroups from any of the four canonical environments), node:test and
 * node:assert/strict.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.5, 1.6**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { aggregateEnvironments } from "@/lib/eks-cost/node-cost";
import type {
  EnvironmentName,
  Nodegroup,
} from "@/lib/eks-cost/types";
import { arbNodegroup } from "@/lib/eks-cost/__tests__/generators";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Absolute tolerance (in EUR) for the monthly cost aggregation identity. */
const COST_TOLERANCE_EUR = 0.01;

/** The four physical cluster names allowed for a portal-canonical env. */
const VALID_CLUSTERS: readonly string[] = [
  "dp-dev",
  "dp-uat",
  "dp-prod",
  "dp-tooling",
] as const;

/* ------------------------------------------------------------------ */
/*  Property 2                                                         */
/* ------------------------------------------------------------------ */

test("Property 2: aggregateEnvironments preserves nodegroup totals per environment", () => {
  fc.assert(
    fc.property(
      // At least one nodegroup so we always produce at least one environment.
      fc.array(arbNodegroup, { minLength: 1, maxLength: 20 }),
      (nodegroups) => {
        const environments = aggregateEnvironments(nodegroups);

        // Group the input by environment name for the oracle sums.
        const inputByEnv = new Map<EnvironmentName, Nodegroup[]>();
        for (const ng of nodegroups) {
          const list = inputByEnv.get(ng.environment);
          if (list) {
            list.push(ng);
          } else {
            inputByEnv.set(ng.environment, [ng]);
          }
        }

        // One produced environment per distinct env name in the input.
        assert.equal(
          environments.length,
          inputByEnv.size,
          `expected ${inputByEnv.size} environment(s), got ${environments.length}`,
        );

        // Each produced env name appears at most once in the output.
        const seenNames = new Set<EnvironmentName>();
        for (const env of environments) {
          assert.ok(
            !seenNames.has(env.name),
            `environment ${env.name} appears more than once in the output`,
          );
          seenNames.add(env.name);
        }

        for (const env of environments) {
          const inputs = inputByEnv.get(env.name);
          assert.ok(
            inputs && inputs.length > 0,
            `produced environment ${env.name} has no matching input nodegroups`,
          );

          // Cluster is one of the four canonical EKS clusters.
          assert.ok(
            VALID_CLUSTERS.includes(env.cluster),
            `env.cluster=${env.cluster} for ${env.name} is not one of ${VALID_CLUSTERS.join(", ")}`,
          );

          // Monthly cost matches the sum of input nodegroups within 0.01€.
          const expectedMonthly = inputs.reduce(
            (sum, ng) => sum + ng.monthlyCostEur,
            0,
          );
          const monthlyDiff = Math.abs(env.monthlyCostEur - expectedMonthly);
          assert.ok(
            monthlyDiff <= COST_TOLERANCE_EUR,
            `env.monthlyCostEur=${env.monthlyCostEur} differs from Σ inputs=${expectedMonthly} ` +
              `by ${monthlyDiff}€ (>${COST_TOLERANCE_EUR}€) for ${env.name}`,
          );

          // Node and spot counts match exactly.
          const expectedNodeCount = inputs.reduce(
            (sum, ng) => sum + ng.nodeCount,
            0,
          );
          const expectedSpotCount = inputs.reduce(
            (sum, ng) => sum + ng.spotCount,
            0,
          );
          assert.equal(
            env.nodeCount,
            expectedNodeCount,
            `env.nodeCount=${env.nodeCount} != Σ inputs=${expectedNodeCount} for ${env.name}`,
          );
          assert.equal(
            env.spotCount,
            expectedSpotCount,
            `env.spotCount=${env.spotCount} != Σ inputs=${expectedSpotCount} for ${env.name}`,
          );

          // spotCoveragePct stays in the valid range.
          assert.ok(
            env.spotCoveragePct >= 0 && env.spotCoveragePct <= 100,
            `env.spotCoveragePct=${env.spotCoveragePct} outside [0, 100] for ${env.name}`,
          );

          // No NaN/Infinity leaked through the aggregation.
          assert.ok(
            Number.isFinite(env.monthlyCostEur),
            `env.monthlyCostEur is not finite for ${env.name}`,
          );
          assert.ok(
            Number.isFinite(env.spotCoveragePct),
            `env.spotCoveragePct is not finite for ${env.name}`,
          );
        }
      },
    ),
    { numRuns: 100 },
  );
});
