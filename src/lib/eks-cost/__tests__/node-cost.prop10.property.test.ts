// Feature: eks-cost-optimization, Property 10: Excess nodes equal overprovisioning divided by average node cost
/**
 * Property-based test for `computeExcessNodes(ng)`.
 *
 * Feature: eks-cost-optimization
 * Property 10: Excess nodes equal overprovisioning divided by average node cost
 *
 * Contract (see design.md §5 and Requirement 5.5 — the "N nodos de más"
 * label shown next to the nodegroup breakdown chart):
 *
 *     excessNodes = Math.floor(overprovisioningEur / avgNodeCostEur)
 *                     when avgNodeCostEur > 0
 *                 = 0
 *                     otherwise (degenerate case: nodeCount === 0 ⇒
 *                     avgNodeCostEur === 0, so we cannot divide)
 *
 * Additional invariant (Requirement 5.5): the result is always a
 * non-negative integer — a count of nodes cannot be fractional nor negative.
 *
 * The property is exercised over `arbNodegroup`, which by construction
 * generates nodegroups spanning the full valid input space:
 *   - `nodeCount` ∈ [0, 40] → covers the `nodeCount === 0` degenerate case
 *     (which implies `avgNodeCostEur === 0`).
 *   - `overprovisioningFraction` ∈ [0, 1] → covers the
 *     `overprovisioningEur === 0` degenerate case when the fraction rounds
 *     to zero.
 *
 * Conventions: node:test + node:assert/strict, fast-check ^4, { numRuns: 100 },
 * a `// Feature: ...` header comment on the file.
 *
 * **Validates: Requirements 5.5**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { computeExcessNodes } from "@/lib/eks-cost/node-cost";
import { arbNodegroup } from "@/lib/eks-cost/__tests__/generators";

/* ------------------------------------------------------------------ */
/*  Property 10                                                        */
/* ------------------------------------------------------------------ */

test("Property 10: excessNodes = floor(overprovisioning / avgNodeCost) with degenerate cases returning 0", () => {
  fc.assert(
    fc.property(arbNodegroup, (ng) => {
      const result = computeExcessNodes(ng);

      // Universal invariant: the count of nodes is a non-negative integer.
      assert.ok(
        Number.isInteger(result),
        `computeExcessNodes must return an integer; got ${result}`,
      );
      assert.ok(
        result >= 0,
        `computeExcessNodes must be non-negative; got ${result} for ` +
          `ng={overprovisioningEur=${ng.overprovisioningEur}, avgNodeCostEur=${ng.avgNodeCostEur}}`,
      );

      // Main formula vs degenerate branch, aligned with the implementation:
      //   avgNodeCostEur > 0  →  floor(overprovisioning / avgNodeCost)
      //   avgNodeCostEur <= 0 →  0
      if (ng.avgNodeCostEur > 0) {
        const expected = Math.floor(ng.overprovisioningEur / ng.avgNodeCostEur);
        assert.equal(
          result,
          expected,
          `computeExcessNodes(${JSON.stringify({
            overprovisioningEur: ng.overprovisioningEur,
            avgNodeCostEur: ng.avgNodeCostEur,
          })}) = ${result}, expected ${expected}`,
        );
      } else {
        assert.equal(
          result,
          0,
          `degenerate case avgNodeCostEur <= 0 must yield 0; got ${result}`,
        );
      }

      // Degenerate case: nodeCount === 0 forces avgNodeCostEur === 0 by
      // definition (`monthlyCostEur / nodeCount` is undefined), so the
      // fallback branch above must have fired.
      if (ng.nodeCount === 0) {
        assert.equal(
          result,
          0,
          `nodeCount === 0 (avgNodeCostEur=${ng.avgNodeCostEur}) must yield 0; got ${result}`,
        );
      }

      // Degenerate case: overprovisioningEur === 0 always yields 0, whether
      // the main formula or the fallback branch is taken.
      if (ng.overprovisioningEur === 0) {
        assert.equal(
          result,
          0,
          `overprovisioningEur === 0 must yield 0; got ${result}`,
        );
      }
    }),
    { numRuns: 100 },
  );
});
