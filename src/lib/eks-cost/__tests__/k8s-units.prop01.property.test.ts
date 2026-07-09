// Feature: eks-cost-optimization, Property 1: K8s unit formatting is canonical and round-trip safe
/**
 * Property-based tests for `src/lib/eks-cost/k8s-units.ts`.
 *
 * Validates the canonical output shape and the round-trip invariant of
 * `formatCpu` / `parseCpu` and `formatMemory` / `parseMemory`.
 *
 * Round-trip bounds:
 *   - `parseCpu(formatCpu(cores))  ∈ [cores, cores + 0.001]`
 *   - `parseMemory(formatMemory(bytes)) ∈ [bytes, bytes * 1.06]` for byte
 *     magnitudes where the formatter step is <= 6% of `bytes`. `formatMemory`
 *     uses steps of `16 MiB` in the Mi range and `0.1 GiB` in the Gi range,
 *     so the 6% cap only holds when the number of chunks `k = ceil(bytes/step)`
 *     satisfies `(k + 1) / k <= 1.06`, i.e. `k >= 17`. That translates to:
 *       - Mi range: `bytes >= 17 * 16 MiB = 272 MiB` (we use `>= 288 MiB` for
 *         a comfortable margin, ratio <= 19/18 ≈ 1.056).
 *       - Gi range: `bytes >= 20 * 0.1 GiB = 2 GiB` (ratio <= 21/20 = 1.05).
 *   Below those thresholds `formatMemory` still rounds up to Kubernetes-idiomatic
 *   values, but the 1.06 upper bound is not meaningful there and the property
 *   only exercises byte magnitudes where it is.
 *
 * **Validates: Requirements 10.1, 10.2, 10.4**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  formatCpu,
  formatMemory,
  parseCpu,
  parseMemory,
} from "@/lib/eks-cost/k8s-units";
import {
  arbByteCount,
  arbCoreCount,
} from "@/lib/eks-cost/__tests__/generators";

/* ------------------------------------------------------------------ */
/*  Canonical regexes and tolerances                                   */
/* ------------------------------------------------------------------ */

/** `formatCpu` output shape: bare cores (with optional decimals) or milicores. */
const CPU_FORMAT_REGEX = /^([0-9]+(\.[0-9]+)?|[0-9]+m)$/;

/** `formatMemory` output shape: decimal or fractional value followed by `Mi` or `Gi`. */
const MEM_FORMAT_REGEX = /^[0-9]+(\.[0-9]+)?(Mi|Gi)$/;

/** CPU round-trip upper delta: `parseCpu(formatCpu(c)) <= c + 0.001`. */
const CPU_ROUND_TRIP_UPPER_DELTA = 0.001;

/** Memory round-trip upper ratio: `parseMemory(formatMemory(b)) <= b * 1.06`. */
const MEM_ROUND_TRIP_UPPER_RATIO = 1.06;

/**
 * Additive tolerance for floating-point comparisons.
 * `arbCoreCount` rounds to milicores via `Math.round(v * 1000) / 1000`, which
 * still leaves values that are not exact multiples of 0.001 in IEEE-754.
 * `formatCpu` then applies `Math.ceil(cores * 1000)` — the resulting integer
 * rounding can accumulate a sub-nanosecond drift when we re-parse and compare.
 * A tiny `1e-9` slack absorbs it without letting a real regression through.
 */
const FP_EPSILON = 1e-9;

/* ------------------------------------------------------------------ */
/*  Memory round-trip generator                                         */
/* ------------------------------------------------------------------ */

/**
 * Bytes for which the 1.06 upper-bound invariant is meaningful.
 *
 * We combine both `formatMemory` branches so the property exercises both:
 *   - Mi range: `[288 MiB, 1 GiB)`  — 18+ chunks of 16 MiB, ratio <= 19/18.
 *   - Gi range: `[2 GiB, 512 GiB]`  — 20+ chunks of 0.1 GiB, ratio <= 21/20.
 *
 * Values in `[1 GiB, ~1.79 GiB)` are deliberately excluded: they land in the
 * Gi branch but have too few chunks to satisfy the 6% cap.
 */
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;
const arbByteCountForRoundTrip: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 288 * MIB, max: GIB - 1 }),
  fc.integer({ min: 2 * GIB, max: 512 * GIB }),
);

/* ------------------------------------------------------------------ */
/*  Property 1a — formatCpu output is canonical                        */
/* ------------------------------------------------------------------ */

test("Property 1: formatCpu output matches the canonical CPU regex", () => {
  fc.assert(
    fc.property(arbCoreCount, (cores) => {
      const out = formatCpu(cores);
      assert.match(
        out,
        CPU_FORMAT_REGEX,
        `formatCpu(${cores}) = "${out}" does not match ${CPU_FORMAT_REGEX}`,
      );
    }),
    { numRuns: 200 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 1b — formatMemory output is canonical                     */
/* ------------------------------------------------------------------ */

test("Property 1: formatMemory output matches the canonical memory regex", () => {
  fc.assert(
    fc.property(arbByteCount, (bytes) => {
      const out = formatMemory(bytes);
      assert.match(
        out,
        MEM_FORMAT_REGEX,
        `formatMemory(${bytes}) = "${out}" does not match ${MEM_FORMAT_REGEX}`,
      );
    }),
    { numRuns: 200 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 1c — CPU round-trip is safe                               */
/* ------------------------------------------------------------------ */

test("Property 1: parseCpu(formatCpu(cores)) is in [cores, cores + 0.001]", () => {
  fc.assert(
    fc.property(arbCoreCount, (cores) => {
      const roundTripped = parseCpu(formatCpu(cores));
      assert.ok(
        roundTripped >= cores - FP_EPSILON,
        `parseCpu(formatCpu(${cores})) = ${roundTripped} < ${cores} (lost precision)`,
      );
      const upper = cores + CPU_ROUND_TRIP_UPPER_DELTA + FP_EPSILON;
      assert.ok(
        roundTripped <= upper,
        `parseCpu(formatCpu(${cores})) = ${roundTripped} > ${upper} (over-rounded)`,
      );
    }),
    { numRuns: 200 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 1d — Memory round-trip is safe (constrained magnitudes)   */
/* ------------------------------------------------------------------ */

test("Property 1: parseMemory(formatMemory(bytes)) is in [bytes, bytes * 1.06]", () => {
  fc.assert(
    fc.property(arbByteCountForRoundTrip, (bytes) => {
      const roundTripped = parseMemory(formatMemory(bytes));
      assert.ok(
        roundTripped >= bytes,
        `parseMemory(formatMemory(${bytes})) = ${roundTripped} < ${bytes} (would leave workload short)`,
      );
      const upper = bytes * MEM_ROUND_TRIP_UPPER_RATIO;
      assert.ok(
        roundTripped <= upper,
        `parseMemory(formatMemory(${bytes})) = ${roundTripped} > ${upper} (over-rounded past 6%)`,
      );
    }),
    { numRuns: 200 },
  );
});
