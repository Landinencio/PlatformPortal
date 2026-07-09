// Feature: eks-cost-optimization, Property 9: Estimated savings are non-negative, conservative and capped
/**
 * Property-based test for `estimateSavings` in
 * `src/lib/eks-cost/rightsizing.ts`.
 *
 * Feature: eks-cost-optimization
 * Property 9: Estimated savings are non-negative, conservative and capped
 *
 * Contract (see design.md §Backend > rightsizing.ts and Requirements 5.1,
 * 5.2):
 *
 *   estimateSavings(currentValue, targetValue, monthlyCost, cap)
 *
 *     rawSavings = ((currentValue - targetValue) / currentValue) * monthlyCost
 *     safeCap    = max(0, cap)
 *     savings    = clamp(rawSavings, 0, monthlyCost * safeCap)
 *
 *   Guard clauses (every one collapses the result to 0):
 *
 *     - currentValue <= 0     (nothing allocated → nothing to save; also /0)
 *     - targetValue >= currentValue   (staying put or growing → no savings)
 *     - monthlyCost <= 0      (no cost → no savings)
 *     - any input NaN / non-finite (defensive)
 *
 * The test asserts five independent properties over a wide numeric domain,
 * including the negative/zero regions that trigger the guard clauses:
 *
 *   (9a) Non-negativity: `estimateSavings(...) >= 0` for ANY inputs.
 *
 *   (9b) Conservative cap: when `cap >= 0` AND `monthlyCost >= 0`,
 *        `estimateSavings(...) <= monthlyCost * cap` (Requirement 5.2).
 *        Note: when `monthlyCost < 0` the function returns `0` via the guard,
 *        which is not bounded by `monthlyCost * cap` (that product is
 *        negative). The bound is only meaningful with `monthlyCost >= 0`.
 *
 *   (9c) Staying put yields no savings: `estimateSavings(x, x, m, c) === 0`
 *        for any `x`, `m`, `c` (Requirement 5.1). Covers both the natural
 *        case (`target = current` makes the numerator zero) and the guard
 *        case (`current <= 0` triggers the early return).
 *
 *   (9d) Monotone in `targetValue`: if `target2 <= target1` then
 *        `estimateSavings(current, target2, m, c) >= estimateSavings(
 *         current, target1, m, c)` — lowering the target can only
 *        increase (or keep) the estimated savings.
 *
 *   (9e) Guard clauses: `estimateSavings === 0` whenever
 *        `monthlyCost <= 0`, `currentValue <= 0`, or `targetValue >= currentValue`.
 *
 * NOTE (out of scope): the aggregated coherence
 *   `sum(rec.estimatedSavingsEur where kind.startsWith("over-") &&
 *        rec.nodegroup == ng.name) == ng.overprovisioningEur`
 * is a pipeline-level consistency check that belongs to
 * `fetchRecommendations` (task 5.11) / `fetchEksCostSummary`, not to the
 * pure `estimateSavings` helper. It is validated indirectly via task 5.11
 * outputs.
 *
 * Conventions: node:test + node:assert/strict, fast-check ^4, `{ numRuns:
 * 100 }`, `// Feature: ...` header on the file.
 *
 * **Validates: Requirements 5.1, 5.2**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { estimateSavings } from "@/lib/eks-cost/rightsizing";

/* ------------------------------------------------------------------ */
/*  Local generators                                                   */
/* ------------------------------------------------------------------ */

/**
 * A finite numeric value across a wide, signed range. Used for
 * `currentValue`, `targetValue` and `monthlyCost` so property tests can
 * exercise the guard-clause regions (negative and zero) alongside the
 * happy path.
 */
const arbSignedValue: fc.Arbitrary<number> = fc.double({
  min: -10_000,
  max: 10_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/**
 * A strictly non-negative finite numeric value. Used where the conservative
 * cap bound (Property 9b) is meaningful — the bound `monthlyCost * cap`
 * requires both operands non-negative to sit above the always-`>= 0`
 * savings result.
 */
const arbNonNegValue: fc.Arbitrary<number> = fc.double({
  min: 0,
  max: 10_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/**
 * A cap fraction across a wide signed range. Includes negative caps
 * (clamped to `0` by `safeCap = max(0, cap)`), zero (savings must collapse
 * to `0`), the canonical `0.7` region (Requirement 5.2) and values above
 * `1` (legal per the signature, though semantically unusual).
 */
const arbCap: fc.Arbitrary<number> = fc.double({
  min: -1,
  max: 2,
  noNaN: true,
  noDefaultInfinity: true,
});

/**
 * A non-negative cap fraction. Used for Property 9b where the bound
 * `monthlyCost * cap` is only meaningful when `cap >= 0`.
 */
const arbNonNegCap: fc.Arbitrary<number> = fc.double({
  min: 0,
  max: 2,
  noNaN: true,
  noDefaultInfinity: true,
});

/* ------------------------------------------------------------------ */
/*  Property 9a — Non-negativity                                       */
/* ------------------------------------------------------------------ */

test("Property 9a: estimateSavings is non-negative for arbitrary inputs", () => {
  fc.assert(
    fc.property(
      arbSignedValue,
      arbSignedValue,
      arbSignedValue,
      arbCap,
      (current, target, monthlyCost, cap) => {
        const s = estimateSavings(current, target, monthlyCost, cap);
        assert.ok(
          Number.isFinite(s),
          `savings must be finite; got ${s} for ` +
            `(current=${current}, target=${target}, monthlyCost=${monthlyCost}, cap=${cap})`,
        );
        assert.ok(
          s >= 0,
          `savings must be non-negative; got ${s} for ` +
            `(current=${current}, target=${target}, monthlyCost=${monthlyCost}, cap=${cap})`,
        );
      },
    ),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 9b — Conservative cap (Requirement 5.2)                   */
/* ------------------------------------------------------------------ */

test("Property 9b: estimateSavings <= monthlyCost * cap when both are non-negative", () => {
  fc.assert(
    fc.property(
      arbSignedValue,
      arbSignedValue,
      arbNonNegValue,
      arbNonNegCap,
      (current, target, monthlyCost, cap) => {
        const s = estimateSavings(current, target, monthlyCost, cap);
        const bound = monthlyCost * cap;
        // Tiny epsilon absorbs floating-point noise from the internal
        // `min(rawSavings, monthlyCost * safeCap)` computation.
        const epsilon = Math.max(1e-9, Math.abs(bound) * 1e-12);
        assert.ok(
          s <= bound + epsilon,
          `cap violated: savings=${s} > monthlyCost*cap=${bound} (± ${epsilon}) for ` +
            `(current=${current}, target=${target}, monthlyCost=${monthlyCost}, cap=${cap})`,
        );
      },
    ),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 9c — Staying put yields no savings (Requirement 5.1)      */
/* ------------------------------------------------------------------ */

test("Property 9c: estimateSavings(x, x, m, c) === 0 for any x, m, c", () => {
  fc.assert(
    fc.property(
      arbSignedValue,
      arbSignedValue,
      arbCap,
      (x, monthlyCost, cap) => {
        const s = estimateSavings(x, x, monthlyCost, cap);
        assert.equal(
          s,
          0,
          `expected 0 for stay-put; got ${s} for ` +
            `(x=${x}, monthlyCost=${monthlyCost}, cap=${cap})`,
        );
      },
    ),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 9d — Monotone in targetValue                              */
/* ------------------------------------------------------------------ */

test("Property 9d: lowering the target never decreases the estimated savings", () => {
  fc.assert(
    fc.property(
      arbSignedValue,
      arbSignedValue,
      arbSignedValue,
      arbSignedValue,
      arbCap,
      (current, tA, tB, monthlyCost, cap) => {
        // Normalize the pair so target2 <= target1 regardless of order.
        const target1 = Math.max(tA, tB);
        const target2 = Math.min(tA, tB);

        const s1 = estimateSavings(current, target1, monthlyCost, cap);
        const s2 = estimateSavings(current, target2, monthlyCost, cap);

        assert.ok(
          s2 >= s1,
          `monotonicity broken: target2=${target2} <= target1=${target1} but ` +
            `savings2=${s2} < savings1=${s1} for ` +
            `(current=${current}, monthlyCost=${monthlyCost}, cap=${cap})`,
        );
      },
    ),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 9e — Guard clauses collapse the result to 0               */
/* ------------------------------------------------------------------ */

test("Property 9e: estimateSavings === 0 when monthlyCost <= 0", () => {
  fc.assert(
    fc.property(
      arbSignedValue,
      arbSignedValue,
      // A strictly non-positive monthly cost.
      fc.double({ min: -10_000, max: 0, noNaN: true, noDefaultInfinity: true }),
      arbCap,
      (current, target, monthlyCost, cap) => {
        const s = estimateSavings(current, target, monthlyCost, cap);
        assert.equal(
          s,
          0,
          `guard failed (monthlyCost<=0): got ${s} for ` +
            `(current=${current}, target=${target}, monthlyCost=${monthlyCost}, cap=${cap})`,
        );
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 9e: estimateSavings === 0 when currentValue <= 0", () => {
  fc.assert(
    fc.property(
      // A strictly non-positive current value.
      fc.double({ min: -10_000, max: 0, noNaN: true, noDefaultInfinity: true }),
      arbSignedValue,
      arbSignedValue,
      arbCap,
      (current, target, monthlyCost, cap) => {
        const s = estimateSavings(current, target, monthlyCost, cap);
        assert.equal(
          s,
          0,
          `guard failed (currentValue<=0): got ${s} for ` +
            `(current=${current}, target=${target}, monthlyCost=${monthlyCost}, cap=${cap})`,
        );
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 9e: estimateSavings === 0 when targetValue >= currentValue", () => {
  fc.assert(
    fc.property(
      arbSignedValue,
      // A non-negative delta so target >= current by construction.
      arbNonNegValue,
      arbSignedValue,
      arbCap,
      (current, delta, monthlyCost, cap) => {
        const target = current + delta;
        const s = estimateSavings(current, target, monthlyCost, cap);
        assert.equal(
          s,
          0,
          `guard failed (target>=current): got ${s} for ` +
            `(current=${current}, target=${target}, monthlyCost=${monthlyCost}, cap=${cap})`,
        );
      },
    ),
    { numRuns: 100 },
  );
});
