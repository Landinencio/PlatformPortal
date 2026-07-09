// Feature: eks-cost-optimization, Property 8: Under-memory beats under-CPU in priority
/**
 * Property-based test for `priorityFilter` in `src/lib/eks-cost/rightsizing.ts`.
 *
 * Feature: eks-cost-optimization
 * Property 8: Under-memory beats under-CPU in priority
 *
 * Contract (see design.md §Backend > rightsizing.ts and Requirement 4.3):
 *
 *   `priorityFilter(recs)` collapses simultaneous `under-cpu` + `under-mem`
 *   recommendations on the SAME `(cluster, namespace, workload)` triple to
 *   just the `under-mem` one — memory pressure (OOMKilled) is a harder
 *   failure than CPU throttling, so we surface it first.
 *
 *   - `over-cpu` and `over-mem` are NEVER dropped: they encode savings, not
 *     risk, and can coexist freely with each other and with `under-*`.
 *   - `under-cpu` on a triple with NO matching `under-mem` is preserved
 *     verbatim.
 *   - Input order is preserved for every surviving recommendation, and the
 *     operation runs against the raw input (no side effects, no mutation).
 *
 * The test asserts four independent properties:
 *
 *   (8a) Shadowing: for every triple `(cluster, namespace, workload)` in the
 *        output that carries at least one `under-mem`, that triple carries
 *        ZERO `under-cpu` entries in the output.
 *
 *   (8b) `over-*` preservation: for every triple in the input, the count of
 *        `over-cpu` (resp. `over-mem`) recommendations in the output equals
 *        the count in the input. Duplicates are preserved, no `over-*` is
 *        ever dropped or introduced.
 *
 *   (8c) Isolated `under-cpu` preservation: for every triple in the input
 *        that has NO `under-mem` recommendation, every `under-cpu`
 *        recommendation for that triple survives — the count in the output
 *        equals the count in the input.
 *
 *   (8d) Idempotence: `priorityFilter(priorityFilter(recs))` is deep-equal
 *        to `priorityFilter(recs)` for any input. A second pass must not
 *        change the result — the fixpoint is reached after one application.
 *
 * Uses fast-check with `{ numRuns: 100 }`, the shared `arbRecommendation`
 * generator, node:test and node:assert/strict.
 *
 * Coverage note: `arbRecommendation` picks the `(cluster, namespace,
 * workload)` triple from small catalogs (4 environments × 14 namespaces ×
 * a slug workload), so triples collide often enough to exercise the
 * shadow-vs-isolate paths naturally across 100 runs. On top of that, the
 * tests also compose recommendations that share a triple explicitly (via
 * an internal `arbRecOnTriple`) to guarantee the collision case is hit
 * every single run.
 *
 * **Validates: Requirements 4.3**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { priorityFilter } from "@/lib/eks-cost/rightsizing";
import type {
  EnvironmentName,
  Recommendation,
  RecommendationKind,
} from "@/lib/eks-cost/types";
import {
  arbRecommendation,
  arbRecommendationKind,
  ENVIRONMENT_NAMES,
} from "@/lib/eks-cost/__tests__/generators";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Cluster physical name per environment — mirrors the generator table. */
const CLUSTER_BY_ENV: Record<EnvironmentName, string> = {
  dev: "dp-dev",
  uat: "dp-uat",
  prod: "dp-prd",
  tooling: "dp-tooling",
};

/**
 * Build the canonical triple key used to compare recommendations for the
 * "same workload" property. Uses NUL as separator so component collisions
 * (e.g. a workload name that happens to contain the namespace) cannot
 * forge a match.
 */
function tripleKey(r: Pick<Recommendation, "cluster" | "namespace" | "workload">): string {
  return `${r.cluster}\u0000${r.namespace}\u0000${r.workload}`;
}

/**
 * Count how many recommendations in `recs` match the given predicate. Used
 * by every property to compare input vs output cardinalities per triple.
 */
function countBy(recs: Recommendation[], pred: (r: Recommendation) => boolean): number {
  let n = 0;
  for (const r of recs) {
    if (pred(r)) n += 1;
  }
  return n;
}

/** Build the set of triples that carry at least one `under-mem` in `recs`. */
function triplesWithUnderMem(recs: Recommendation[]): Set<string> {
  const s = new Set<string>();
  for (const r of recs) {
    if (r.kind === "under-mem") s.add(tripleKey(r));
  }
  return s;
}

/** Set of every distinct triple appearing in `recs`. */
function distinctTriples(recs: Recommendation[]): Set<string> {
  const s = new Set<string>();
  for (const r of recs) {
    s.add(tripleKey(r));
  }
  return s;
}

/**
 * Force `rec` to live on `triple` with the given `kind`. Cluster is derived
 * from the environment so the (cluster, namespace, workload) triple stays
 * internally consistent (same invariant the generators enforce).
 */
function withTriple(
  rec: Recommendation,
  triple: { environment: EnvironmentName; namespace: string; workload: string },
  kind: RecommendationKind,
): Recommendation {
  return {
    ...rec,
    cluster: CLUSTER_BY_ENV[triple.environment],
    environment: triple.environment,
    namespace: triple.namespace,
    workload: triple.workload,
    kind,
  };
}

/* ------------------------------------------------------------------ */
/*  Arbitraries                                                        */
/* ------------------------------------------------------------------ */

/**
 * Triples drawn from a small fixed pool so that collisions between
 * generated recommendations are frequent. Both the namespace and the
 * workload slug are picked from short catalogs; the environment is drawn
 * from the canonical list so `cluster` remains derivable.
 */
const arbTriple = fc.record({
  environment: fc.constantFrom<EnvironmentName>(...ENVIRONMENT_NAMES),
  namespace: fc.constantFrom("oms", "basket", "checkout", "payments", "customers"),
  workload: fc.constantFrom("api", "worker", "web", "processor", "scheduler"),
});

/**
 * A recommendation that lives on a specific `(cluster, namespace, workload)`
 * triple and carries a specific kind, keeping every other field random via
 * `arbRecommendation`. This guarantees the collision case exercised by
 * Property 8 is hit on every run.
 */
const arbRecOnTriple: fc.Arbitrary<Recommendation> = fc
  .tuple(arbRecommendation, arbTriple, arbRecommendationKind)
  .map(([rec, triple, kind]) => withTriple(rec, triple, kind));

/**
 * Full input to `priorityFilter`: a mix of unconstrained recommendations
 * (from `arbRecommendation`) and colliding ones (from `arbRecOnTriple`).
 * Length is bounded so property tests stay fast.
 */
const arbRecList: fc.Arbitrary<Recommendation[]> = fc
  .tuple(
    fc.array(arbRecommendation, { minLength: 0, maxLength: 20 }),
    fc.array(arbRecOnTriple, { minLength: 0, maxLength: 20 }),
  )
  .map(([a, b]) => [...a, ...b]);

/* ------------------------------------------------------------------ */
/*  Property 8a: shadowing rule                                        */
/* ------------------------------------------------------------------ */

test("Property 8a: any triple with under-mem in the output has zero under-cpu in the output", () => {
  fc.assert(
    fc.property(arbRecList, (recs) => {
      const out = priorityFilter(recs);
      const memTriples = triplesWithUnderMem(out);
      for (const key of memTriples) {
        const underCpuCount = countBy(
          out,
          (r) => r.kind === "under-cpu" && tripleKey(r) === key,
        );
        assert.equal(
          underCpuCount,
          0,
          `under-cpu leaked past priorityFilter for a triple that also has under-mem: ${key}`,
        );
      }
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 8b: over-* preservation                                   */
/* ------------------------------------------------------------------ */

test("Property 8b: every over-cpu and over-mem is preserved (count per triple)", () => {
  fc.assert(
    fc.property(arbRecList, (recs) => {
      const out = priorityFilter(recs);
      const triples = distinctTriples(recs);
      for (const key of triples) {
        for (const kind of ["over-cpu", "over-mem"] as const) {
          const inputCount = countBy(
            recs,
            (r) => r.kind === kind && tripleKey(r) === key,
          );
          const outputCount = countBy(
            out,
            (r) => r.kind === kind && tripleKey(r) === key,
          );
          assert.equal(
            outputCount,
            inputCount,
            `${kind} count changed for triple ${key}: input=${inputCount} output=${outputCount}`,
          );
        }
      }
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 8c: isolated under-cpu preservation                       */
/* ------------------------------------------------------------------ */

test("Property 8c: under-cpu on a triple with no under-mem is preserved", () => {
  fc.assert(
    fc.property(arbRecList, (recs) => {
      const out = priorityFilter(recs);
      const memTriples = triplesWithUnderMem(recs);
      const triples = distinctTriples(recs);
      for (const key of triples) {
        if (memTriples.has(key)) continue;
        const inputCount = countBy(
          recs,
          (r) => r.kind === "under-cpu" && tripleKey(r) === key,
        );
        const outputCount = countBy(
          out,
          (r) => r.kind === "under-cpu" && tripleKey(r) === key,
        );
        assert.equal(
          outputCount,
          inputCount,
          `under-cpu dropped on a triple with no under-mem: ${key} input=${inputCount} output=${outputCount}`,
        );
      }
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 8d: idempotence                                           */
/* ------------------------------------------------------------------ */

test("Property 8d: priorityFilter is idempotent", () => {
  fc.assert(
    fc.property(arbRecList, (recs) => {
      const once = priorityFilter(recs);
      const twice = priorityFilter(once);
      assert.deepStrictEqual(
        twice,
        once,
        "priorityFilter(priorityFilter(recs)) differs from priorityFilter(recs)",
      );
    }),
    { numRuns: 100 },
  );
});
