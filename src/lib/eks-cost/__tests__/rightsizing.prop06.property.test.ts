// Feature: eks-cost-optimization, Property 6: Classification detects over/under against target
/**
 * Property-based test for `classifyOverUnder` in
 * `src/lib/eks-cost/rightsizing.ts`.
 *
 * Feature: eks-cost-optimization
 * Property 6: Classification detects over/under against target
 *
 * Contract (see design.md §Backend > rightsizing.ts and Requirements 3.2,
 * 3.3, 4.1, 4.2):
 *
 *   classifyOverUnder(w, cpuTarget, memTarget) emits, in this canonical
 *   order:
 *
 *     - "over-cpu"  iff  w.cpuRequestCores  > cpuTarget
 *     - "over-mem"  iff  w.memRequestBytes  > memTarget
 *     - "under-cpu" iff  w.cpuUsageP95Cores > w.cpuRequestCores
 *     - "under-mem" iff  w.memUsageP95Bytes > w.memRequestBytes
 *
 * The test asserts four independent properties:
 *
 *   (6a) Emission rules match the design exactly for ANY workload and ANY
 *        pair of targets — a full truth-table oracle over the four kinds.
 *
 *   (6b) When the targets come from the canonical formula
 *        (`computeCpuTarget(w, p)`, `computeMemTarget(w, null, p)`),
 *        `over-*` and `under-*` on the same dimension are MUTUALLY
 *        EXCLUSIVE per workload. This is a consequence of the target
 *        formula `target = max(floor, p95 / headroom)` with
 *        `headroom < 1`, which yields `target ≥ p95 / headroom > p95` so
 *        `request > target` and `p95 > request` cannot both hold. The test
 *        uses canonical targets deliberately so mutual exclusion is
 *        guaranteed; adversarial targets (Property 6a) are covered by the
 *        truth-table oracle.
 *
 *   (6c) Monotonicity on request: if `cpuRequestCores` grows while every
 *        other field stays fixed, `over-cpu` presence is monotone
 *        (non-decreasing) — once above the target, it stays above. Same
 *        for memory. The canonical CPU/memory targets depend only on
 *        `podCount` + `p95`, so they are invariant under changes to the
 *        corresponding `request`.
 *
 *   (6d) Monotonicity on p95: if `cpuUsageP95Cores` grows while every other
 *        field stays fixed, `under-cpu` presence is monotone
 *        (non-decreasing) — once p95 is above the current request, it
 *        stays above. Same for memory. `under-*` never depends on the
 *        target, so this holds under any target choice; the test uses an
 *        arbitrary target to make that explicit.
 *
 * Uses fast-check with `{ numRuns: 100 }`, `arbWorkload`, `arbCoreCount`
 * and `arbByteCount` from the shared generators, node:test and
 * node:assert/strict.
 *
 * **Validates: Requirements 3.2, 3.3, 4.1, 4.2**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  DEFAULT_RIGHTSIZING_PARAMS,
  classifyOverUnder,
  computeCpuTarget,
  computeMemTarget,
} from "@/lib/eks-cost/rightsizing";
import type { RecommendationKind, Workload } from "@/lib/eks-cost/types";
import {
  arbByteCount,
  arbCoreCount,
  arbWorkload,
} from "@/lib/eks-cost/__tests__/generators";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Every kind produced by the classifier must belong to this closed set. */
const KNOWN_KINDS: ReadonlySet<RecommendationKind> = new Set<RecommendationKind>([
  "over-cpu",
  "over-mem",
  "under-cpu",
  "under-mem",
]);

/**
 * Turn the classifier output into a Set for O(1) membership checks. Also
 * asserts that the result contains no unknown kinds and no duplicates.
 */
function toKindSet(kinds: RecommendationKind[]): Set<RecommendationKind> {
  const set = new Set<RecommendationKind>();
  for (const kind of kinds) {
    assert.ok(
      KNOWN_KINDS.has(kind),
      `classifyOverUnder emitted an unknown kind: ${String(kind)}`,
    );
    assert.ok(
      !set.has(kind),
      `classifyOverUnder emitted duplicate kind: ${kind}`,
    );
    set.add(kind);
  }
  return set;
}

/* ------------------------------------------------------------------ */
/*  Property 6a: emission rules match design.md exactly                */
/* ------------------------------------------------------------------ */

test("Property 6a: emission rules match the design for arbitrary targets", () => {
  fc.assert(
    fc.property(
      arbWorkload,
      arbCoreCount,
      arbByteCount,
      (w, cpuTarget, memTarget) => {
        const kinds = toKindSet(
          classifyOverUnder(w, cpuTarget, memTarget),
        );

        const expectOverCpu = w.cpuRequestCores > cpuTarget;
        const expectOverMem = w.memRequestBytes > memTarget;
        const expectUnderCpu = w.cpuUsageP95Cores > w.cpuRequestCores;
        const expectUnderMem = w.memUsageP95Bytes > w.memRequestBytes;

        assert.equal(
          kinds.has("over-cpu"),
          expectOverCpu,
          `over-cpu mismatch: request=${w.cpuRequestCores} target=${cpuTarget}`,
        );
        assert.equal(
          kinds.has("over-mem"),
          expectOverMem,
          `over-mem mismatch: request=${w.memRequestBytes} target=${memTarget}`,
        );
        assert.equal(
          kinds.has("under-cpu"),
          expectUnderCpu,
          `under-cpu mismatch: p95=${w.cpuUsageP95Cores} request=${w.cpuRequestCores}`,
        );
        assert.equal(
          kinds.has("under-mem"),
          expectUnderMem,
          `under-mem mismatch: p95=${w.memUsageP95Bytes} request=${w.memRequestBytes}`,
        );
      },
    ),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 6b: mutual exclusion under canonical targets              */
/* ------------------------------------------------------------------ */

test("Property 6b: over-cpu and under-cpu are mutually exclusive with canonical target", () => {
  fc.assert(
    fc.property(arbWorkload, (w) => {
      const p = DEFAULT_RIGHTSIZING_PARAMS;
      const cpuTarget = computeCpuTarget(w, p);
      const memTarget = computeMemTarget(w, null, p);
      const kinds = toKindSet(classifyOverUnder(w, cpuTarget, memTarget));

      assert.ok(
        !(kinds.has("over-cpu") && kinds.has("under-cpu")),
        `over-cpu AND under-cpu emitted with canonical CPU target: ` +
          `request=${w.cpuRequestCores}, p95=${w.cpuUsageP95Cores}, ` +
          `target=${cpuTarget}, podCount=${w.podCount}`,
      );
    }),
    { numRuns: 100 },
  );
});

test("Property 6b: over-mem and under-mem are mutually exclusive with canonical target", () => {
  fc.assert(
    fc.property(arbWorkload, (w) => {
      const p = DEFAULT_RIGHTSIZING_PARAMS;
      const cpuTarget = computeCpuTarget(w, p);
      const memTarget = computeMemTarget(w, null, p);
      const kinds = toKindSet(classifyOverUnder(w, cpuTarget, memTarget));

      assert.ok(
        !(kinds.has("over-mem") && kinds.has("under-mem")),
        `over-mem AND under-mem emitted with canonical memory target: ` +
          `request=${w.memRequestBytes}, p95=${w.memUsageP95Bytes}, ` +
          `target=${memTarget}, podCount=${w.podCount}`,
      );
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 6c: monotonicity in `request`                             */
/* ------------------------------------------------------------------ */

test("Property 6c: over-cpu presence is monotone in cpuRequestCores (fixed target)", () => {
  fc.assert(
    fc.property(
      arbWorkload,
      // Non-negative delta; arbCoreCount is already >= 0 and rounded to
      // milicores, so `w.cpuRequestCores + delta >= w.cpuRequestCores`.
      arbCoreCount,
      (w, delta) => {
        const p = DEFAULT_RIGHTSIZING_PARAMS;
        // The canonical CPU target depends only on `podCount` and
        // `cpuUsageP95Cores`, both fixed across w1 and w2 — so the target
        // stays constant while `cpuRequestCores` grows.
        const cpuTarget = computeCpuTarget(w, p);
        const memTarget = computeMemTarget(w, null, p);

        const w1: Workload = w;
        const w2: Workload = {
          ...w,
          cpuRequestCores: w.cpuRequestCores + delta,
        };

        const kinds1 = toKindSet(classifyOverUnder(w1, cpuTarget, memTarget));
        const kinds2 = toKindSet(classifyOverUnder(w2, cpuTarget, memTarget));

        if (kinds1.has("over-cpu")) {
          assert.ok(
            kinds2.has("over-cpu"),
            `over-cpu disappeared when cpuRequestCores grew from ` +
              `${w1.cpuRequestCores} to ${w2.cpuRequestCores} (target=${cpuTarget})`,
          );
        }
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 6c: over-mem presence is monotone in memRequestBytes (fixed target)", () => {
  fc.assert(
    fc.property(arbWorkload, arbByteCount, (w, delta) => {
      const p = DEFAULT_RIGHTSIZING_PARAMS;
      // The canonical memory target depends only on `podCount` and
      // `memUsageP95Bytes` (and the optional VPA upperbound, which we set
      // to `null`), so it stays constant while `memRequestBytes` grows.
      const cpuTarget = computeCpuTarget(w, p);
      const memTarget = computeMemTarget(w, null, p);

      const w1: Workload = w;
      const w2: Workload = {
        ...w,
        memRequestBytes: w.memRequestBytes + delta,
      };

      const kinds1 = toKindSet(classifyOverUnder(w1, cpuTarget, memTarget));
      const kinds2 = toKindSet(classifyOverUnder(w2, cpuTarget, memTarget));

      if (kinds1.has("over-mem")) {
        assert.ok(
          kinds2.has("over-mem"),
          `over-mem disappeared when memRequestBytes grew from ` +
            `${w1.memRequestBytes} to ${w2.memRequestBytes} (target=${memTarget})`,
        );
      }
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 6d: monotonicity in `p95`                                 */
/* ------------------------------------------------------------------ */

test("Property 6d: under-cpu presence is monotone in cpuUsageP95Cores", () => {
  fc.assert(
    fc.property(
      arbWorkload,
      arbCoreCount, // >= 0 delta
      // An arbitrary CPU target: `under-cpu` does not depend on the target,
      // so this value can be anything.
      arbCoreCount,
      // An arbitrary memory target: same reasoning.
      arbByteCount,
      (w, delta, cpuTarget, memTarget) => {
        const w1: Workload = w;
        const w2: Workload = {
          ...w,
          cpuUsageP95Cores: w.cpuUsageP95Cores + delta,
        };

        const kinds1 = toKindSet(classifyOverUnder(w1, cpuTarget, memTarget));
        const kinds2 = toKindSet(classifyOverUnder(w2, cpuTarget, memTarget));

        if (kinds1.has("under-cpu")) {
          assert.ok(
            kinds2.has("under-cpu"),
            `under-cpu disappeared when cpuUsageP95Cores grew from ` +
              `${w1.cpuUsageP95Cores} to ${w2.cpuUsageP95Cores} ` +
              `(request=${w.cpuRequestCores})`,
          );
        }
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 6d: under-mem presence is monotone in memUsageP95Bytes", () => {
  fc.assert(
    fc.property(
      arbWorkload,
      arbByteCount,
      arbCoreCount,
      arbByteCount,
      (w, delta, cpuTarget, memTarget) => {
        const w1: Workload = w;
        const w2: Workload = {
          ...w,
          memUsageP95Bytes: w.memUsageP95Bytes + delta,
        };

        const kinds1 = toKindSet(classifyOverUnder(w1, cpuTarget, memTarget));
        const kinds2 = toKindSet(classifyOverUnder(w2, cpuTarget, memTarget));

        if (kinds1.has("under-mem")) {
          assert.ok(
            kinds2.has("under-mem"),
            `under-mem disappeared when memUsageP95Bytes grew from ` +
              `${w1.memUsageP95Bytes} to ${w2.memUsageP95Bytes} ` +
              `(request=${w.memRequestBytes})`,
          );
        }
      },
    ),
    { numRuns: 100 },
  );
});
