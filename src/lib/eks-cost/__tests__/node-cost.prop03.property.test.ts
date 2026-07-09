// Feature: eks-cost-optimization, Property 3: Monthly cost is hourly cost times 730
/**
 * Property-based test for the hourly→monthly cost conversion.
 *
 * Feature: eks-cost-optimization
 * Property 3: Monthly cost is hourly cost times 730
 *
 * Contract (see design.md §Node_Cost_Service and Requirement 1.3):
 *
 *     hourlyToMonthly(h) == h * HOURS_PER_MONTH
 *
 * where HOURS_PER_MONTH is fixed at 730 (30 days × 24 h, the same convention
 * used by AWS Cost Explorer, OpenCost and the rest of the portal's FinOps
 * stack).
 *
 * The property is exercised over arbitrary finite non-negative doubles.
 * Costs live in EUR (a monetary magnitude ≥ 0), so negative inputs are
 * outside the domain and not tested here — floating-point behaviour for
 * `NaN`/`Infinity`/negative values is documented in the implementation but
 * left to targeted unit tests, not property coverage.
 *
 * Conventions: node:test + node:assert/strict, fast-check ^4, { numRuns: 100 },
 * a `// Feature: ...` header comment on the file.
 *
 * **Validates: Requirements 1.3**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { hourlyToMonthly, HOURS_PER_MONTH } from "@/lib/eks-cost/node-cost";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/**
 * Arbitrary finite non-negative doubles.
 *
 * The upper bound (`1e12`) keeps the reference product `h * 730` safely
 * inside the double-precision "exact-integer" range and avoids overflow
 * to `Infinity` — the property is about the algebraic identity, not about
 * how doubles behave near their limits.
 */
const arbHourlyCost = fc.double({
  min: 0,
  max: 1e12,
  noNaN: true,
  noDefaultInfinity: true,
});

/* ------------------------------------------------------------------ */
/*  Property 3                                                         */
/* ------------------------------------------------------------------ */

test("Property 3: hourlyToMonthly(h) equals h * 730 within 1e-6 tolerance", () => {
  // Sanity: the constant is fixed at 730 — the property title literally
  // asserts this number, so we lock it in.
  assert.equal(HOURS_PER_MONTH, 730);

  fc.assert(
    fc.property(arbHourlyCost, (hourlyCost) => {
      const monthly = hourlyToMonthly(hourlyCost);
      const expected = hourlyCost * 730;

      // Absolute tolerance sufficient for small inputs; relative tolerance
      // needed for large ones where the ULP grows. Both must be `< 1e-6`
      // according to the task specification.
      const absDiff = Math.abs(monthly - expected);
      const relDiff = expected === 0 ? absDiff : absDiff / Math.abs(expected);

      assert.ok(
        absDiff < 1e-6 || relDiff < 1e-6,
        `hourlyToMonthly(${hourlyCost}) = ${monthly}, expected ≈ ${expected} ` +
          `(absDiff=${absDiff}, relDiff=${relDiff})`,
      );

      // Additional invariants that follow trivially from the identity but
      // are cheap to guard against regressions:
      //   - The result is finite when the input is finite.
      //   - The result is non-negative when the input is non-negative.
      //   - The result equals 0 iff the input is 0.
      assert.ok(Number.isFinite(monthly), "monthly must be finite");
      assert.ok(monthly >= 0, "monthly must be non-negative");
      assert.equal(monthly === 0, hourlyCost === 0);
    }),
    { numRuns: 100 },
  );
});
