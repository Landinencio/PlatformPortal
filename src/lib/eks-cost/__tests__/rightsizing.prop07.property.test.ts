// Feature: eks-cost-optimization, Property 7: Target respects headroom and floor
/**
 * Property-based test for `computeCpuTarget` / `computeMemTarget`.
 *
 * Feature: eks-cost-optimization
 * Property 7: Target respects headroom and floor
 *
 * Contract (see design.md §Backend > rightsizing.ts and Requirements 3.4,
 * 3.5, 3.6):
 *
 *   podCount    = max(1, w.podCount)
 *   target_cpu  = max(p.floorCpuPerPod  * podCount, w.cpuUsageP95Cores / p.headroomCpu)
 *   target_mem  = max(p.floorMemPerPod * podCount, w.memUsageP95Bytes / p.headroomMem)
 *   target_mem  = max(target_mem, vpaMemUpperBytes)  when non-null  (anti-OOM)
 *
 * Universal invariants exercised here:
 *
 *   1. Exact algebraic identity of `computeCpuTarget(w, p)` against the
 *      canonical formula (bit-identical: same operations, same order).
 *   2. Exact algebraic identity of `computeMemTarget(w, null, p)` against
 *      the canonical formula.
 *   3. Monotonicity of `computeMemTarget(w, vpaMemUpper, p)` in
 *      `vpaMemUpper`: `vu1 <= vu2  ⇒  result1 <= result2`.
 *   4. Floor respected: `computeCpuTarget(w, p) >= p.floorCpuPerPod *
 *      max(1, w.podCount)`.
 *   5. Result is finite and non-negative for both functions across the
 *      full generated input space (`arbWorkload` clamps `podCount >= 1`,
 *      so `max(1, podCount) === podCount`; the implementation and the
 *      reference formula stay in lockstep).
 *
 * Conventions: node:test + node:assert/strict, fast-check ^4, { numRuns: 100 },
 * a `// Feature: ...` header comment on the file.
 *
 * **Validates: Requirements 3.4, 3.5, 3.6**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  computeCpuTarget,
  computeMemTarget,
} from "@/lib/eks-cost/rightsizing";
import {
  arbByteCount,
  arbRightsizingParams,
  arbWorkload,
} from "@/lib/eks-cost/__tests__/generators";

/* ------------------------------------------------------------------ */
/*  Property 7 — CPU: exact formula + floor respected + finite/non-negative */
/* ------------------------------------------------------------------ */

test("Property 7 (CPU): computeCpuTarget equals max(floor * podCount, p95 / headroom) exactly and respects the floor", () => {
  fc.assert(
    fc.property(arbWorkload, arbRightsizingParams, (w, p) => {
      const result = computeCpuTarget(w, p);
      const podCount = Math.max(1, w.podCount);
      const floor = p.floorCpuPerPod * podCount;
      const usageBased = w.cpuUsageP95Cores / p.headroomCpu;
      const expected = Math.max(floor, usageBased);

      // Bit-identical: same operations, same evaluation order → exact.
      assert.equal(
        result,
        expected,
        `computeCpuTarget=${result}, expected=${expected} for ` +
          `w={podCount=${w.podCount}, p95=${w.cpuUsageP95Cores}}, ` +
          `p={floorCpuPerPod=${p.floorCpuPerPod}, headroomCpu=${p.headroomCpu}}`,
      );

      // Floor is respected by construction (result is a max including floor).
      assert.ok(
        result >= floor,
        `computeCpuTarget=${result} must be >= floor=${floor} ` +
          `(floorCpuPerPod * max(1, podCount))`,
      );

      // Finiteness and non-negativity — the whole domain is non-negative and
      // headroomCpu is bounded away from zero by the generator.
      assert.ok(Number.isFinite(result), `result must be finite; got ${result}`);
      assert.ok(result >= 0, `result must be non-negative; got ${result}`);
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 7 — Memory: exact formula (no VPA), VPA monotonicity, finite */
/* ------------------------------------------------------------------ */

test("Property 7 (Memory): computeMemTarget(w, null, p) equals max(floor * podCount, p95 / headroom) exactly", () => {
  fc.assert(
    fc.property(arbWorkload, arbRightsizingParams, (w, p) => {
      const result = computeMemTarget(w, null, p);
      const podCount = Math.max(1, w.podCount);
      const floor = p.floorMemPerPod * podCount;
      const usageBased = w.memUsageP95Bytes / p.headroomMem;
      const expected = Math.max(floor, usageBased);

      assert.equal(
        result,
        expected,
        `computeMemTarget(null)=${result}, expected=${expected} for ` +
          `w={podCount=${w.podCount}, p95=${w.memUsageP95Bytes}}, ` +
          `p={floorMemPerPod=${p.floorMemPerPod}, headroomMem=${p.headroomMem}}`,
      );

      // Finite and non-negative on the full domain (bytes are non-negative,
      // headroomMem is bounded away from zero).
      assert.ok(Number.isFinite(result), `result must be finite; got ${result}`);
      assert.ok(result >= 0, `result must be non-negative; got ${result}`);
    }),
    { numRuns: 100 },
  );
});

test("Property 7 (Memory): computeMemTarget is monotonic in vpaMemUpperBytes", () => {
  fc.assert(
    fc.property(
      arbWorkload,
      arbRightsizingParams,
      arbByteCount,
      arbByteCount,
      (w, p, a, b) => {
        // Normalize the pair so vu1 <= vu2 regardless of generation order.
        const vu1 = Math.min(a, b);
        const vu2 = Math.max(a, b);

        const r1 = computeMemTarget(w, vu1, p);
        const r2 = computeMemTarget(w, vu2, p);

        assert.ok(
          r1 <= r2,
          `monotonicity broken: vu1=${vu1} <= vu2=${vu2} but ` +
            `r1=${r1} > r2=${r2}`,
        );

        // A non-null VPA upper-bound is a lower bound of the target
        // (anti-OOM invariant): result >= vpaMemUpper for either input.
        assert.ok(
          r1 >= vu1,
          `anti-OOM broken: result=${r1} < vpaMemUpper=${vu1}`,
        );
        assert.ok(
          r2 >= vu2,
          `anti-OOM broken: result=${r2} < vpaMemUpper=${vu2}`,
        );

        // Finite and non-negative regardless of vpaMemUpper.
        assert.ok(
          Number.isFinite(r1) && Number.isFinite(r2),
          `results must be finite; got r1=${r1}, r2=${r2}`,
        );
        assert.ok(
          r1 >= 0 && r2 >= 0,
          `results must be non-negative; got r1=${r1}, r2=${r2}`,
        );
      },
    ),
    { numRuns: 100 },
  );
});
