// Feature: eks-cost-optimization, Property 12: Filter application is idempotent and correct
/**
 * Property-based test for `applyFilters(response, filters)` in
 * `src/lib/eks-cost/index.ts`.
 *
 * Feature: eks-cost-optimization
 * Property 12: Filter application is idempotent and correct
 *
 * Contract (see design.md §Backend > index.ts and Requirements 6.1, 6.2, 6.3,
 * 6.4):
 *
 *   1. **Identity** — `applyFilters(r, {})` deep-equals `r`. The
 *      implementation returns the same reference when every filter dimension
 *      is empty, which is a strictly stronger form of structural equality.
 *   2. **Idempotence** — `applyFilters(applyFilters(r, f), f)` deep-equals
 *      `applyFilters(r, f)`. Each filter dimension is a projection on a
 *      primitive field, so re-applying it against items that already match
 *      is a no-op.
 *   3. **Commutativity between dimensions** — applying two disjoint filter
 *      dimensions in either order produces the same response. The filter
 *      predicates are independent primitive-field comparisons whose logical
 *      AND is order-independent; the downstream aggregation
 *      (`aggregateEnvironments`) is deterministic given the same
 *      order-preserving filter output, so the recomposed environments,
 *      workloads, recommendations, squads and top-level totals coincide
 *      structurally.
 *   4. **Correctness** — every item in the filtered response matches every
 *      non-empty dimension of the filter. Verified per-collection over
 *      environments, top-level nodegroups, workloads, recommendations and
 *      squads.
 *
 * Uses fast-check with `{ numRuns: 100 }`, node:test and node:assert/strict.
 * `arbAllocationResponse` produces cross-object independent data (workloads
 * are not tied to the specific nodegroup names of the environments), which is
 * exactly what stresses the filter semantics: a filter dimension may or may
 * not match anything, and both cases must uphold every invariant above.
 *
 * **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { applyFilters } from "@/lib/eks-cost/index";
import type {
  AllocationResponse,
  Environment,
  Filters,
  Nodegroup,
  Recommendation,
  Squad,
  Workload,
} from "@/lib/eks-cost/types";
import {
  arbAllocationResponse,
  arbFilters,
} from "@/lib/eks-cost/__tests__/generators";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Assert that every item in the filtered result honours the non-empty
 * dimensions of `filters`. Dimensions that do not apply to a given item type
 * (e.g. `squad` on {@link Nodegroup}) are skipped — the contract is
 * "matches every dimension that applies to the item".
 */
function assertItemsMatchFilter(
  response: AllocationResponse,
  filters: Filters,
): void {
  const { env, nodegroup, squad } = filters;

  for (const e of response.environments) {
    if (env !== undefined) {
      assert.equal(
        e.name,
        env,
        `environment ${e.name} in filtered result does not match env filter ${env}`,
      );
    }
    // Nested nodegroups inside an env row must also match the top-level
    // nodegroup filter (they come from the same filtered pool).
    for (const ng of e.nodegroups) {
      if (env !== undefined) {
        assert.equal(
          ng.environment,
          env,
          `nested nodegroup ${ng.name} in env ${e.name} has environment ${ng.environment}, expected ${env}`,
        );
      }
      if (nodegroup !== undefined) {
        assert.equal(
          ng.name,
          nodegroup,
          `nested nodegroup ${ng.name} in env ${e.name} does not match nodegroup filter ${nodegroup}`,
        );
      }
    }
  }

  for (const ng of response.nodegroups) {
    if (env !== undefined) {
      assert.equal(
        ng.environment,
        env,
        `nodegroup ${ng.name} has environment ${ng.environment}, expected ${env}`,
      );
    }
    if (nodegroup !== undefined) {
      assert.equal(
        ng.name,
        nodegroup,
        `nodegroup ${ng.name} does not match nodegroup filter ${nodegroup}`,
      );
    }
  }

  for (const w of response.workloads) {
    if (env !== undefined) {
      assert.equal(
        w.environment,
        env,
        `workload ${w.namespace}/${w.workload} has env ${w.environment}, expected ${env}`,
      );
    }
    if (nodegroup !== undefined) {
      assert.equal(
        w.nodegroup,
        nodegroup,
        `workload ${w.namespace}/${w.workload} has nodegroup ${w.nodegroup}, expected ${nodegroup}`,
      );
    }
    if (squad !== undefined) {
      assert.equal(
        w.squad,
        squad,
        `workload ${w.namespace}/${w.workload} has squad ${w.squad}, expected ${squad}`,
      );
    }
  }

  for (const r of response.recommendations) {
    if (env !== undefined) {
      assert.equal(
        r.environment,
        env,
        `recommendation ${r.namespace}/${r.workload} has env ${r.environment}, expected ${env}`,
      );
    }
    if (nodegroup !== undefined) {
      assert.equal(
        r.nodegroup,
        nodegroup,
        `recommendation ${r.namespace}/${r.workload} has nodegroup ${r.nodegroup}, expected ${nodegroup}`,
      );
    }
    if (squad !== undefined) {
      assert.equal(
        r.squad,
        squad,
        `recommendation ${r.namespace}/${r.workload} has squad ${r.squad}, expected ${squad}`,
      );
    }
  }

  if (squad !== undefined) {
    for (const s of response.squads) {
      assert.equal(
        s.name,
        squad,
        `squad ${s.name} in filtered result does not match squad filter ${squad}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Property 12.1 — Identity                                           */
/* ------------------------------------------------------------------ */

test("Property 12 (identity): applyFilters(r, {}) deep-equals r", () => {
  fc.assert(
    fc.property(arbAllocationResponse, (r) => {
      const out = applyFilters(r, {});
      // Reference-equality is documented as the strongest identity: the
      // implementation short-circuits and returns the input untouched.
      // We assert deep-equality (which subsumes reference-equality).
      assert.deepStrictEqual(out, r);
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 12.2 — Idempotence                                        */
/* ------------------------------------------------------------------ */

test("Property 12 (idempotence): applyFilters(applyFilters(r, f), f) == applyFilters(r, f)", () => {
  fc.assert(
    fc.property(arbAllocationResponse, arbFilters, (r, f) => {
      const once = applyFilters(r, f);
      const twice = applyFilters(once, f);
      assert.deepStrictEqual(twice, once);
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 12.3 — Commutativity between dimensions                   */
/* ------------------------------------------------------------------ */

test("Property 12 (commutativity env <-> nodegroup): order-independent", () => {
  fc.assert(
    fc.property(arbAllocationResponse, arbFilters, (r, f) => {
      const fEnv: Filters = f.env !== undefined ? { env: f.env } : {};
      const fNg: Filters =
        f.nodegroup !== undefined ? { nodegroup: f.nodegroup } : {};
      const envThenNg = applyFilters(applyFilters(r, fEnv), fNg);
      const ngThenEnv = applyFilters(applyFilters(r, fNg), fEnv);
      assert.deepStrictEqual(envThenNg, ngThenEnv);
    }),
    { numRuns: 100 },
  );
});

test("Property 12 (commutativity env <-> squad): order-independent", () => {
  fc.assert(
    fc.property(arbAllocationResponse, arbFilters, (r, f) => {
      const fEnv: Filters = f.env !== undefined ? { env: f.env } : {};
      const fSquad: Filters =
        f.squad !== undefined ? { squad: f.squad } : {};
      const envThenSquad = applyFilters(applyFilters(r, fEnv), fSquad);
      const squadThenEnv = applyFilters(applyFilters(r, fSquad), fEnv);
      assert.deepStrictEqual(envThenSquad, squadThenEnv);
    }),
    { numRuns: 100 },
  );
});

test("Property 12 (commutativity nodegroup <-> squad): order-independent", () => {
  fc.assert(
    fc.property(arbAllocationResponse, arbFilters, (r, f) => {
      const fNg: Filters =
        f.nodegroup !== undefined ? { nodegroup: f.nodegroup } : {};
      const fSquad: Filters =
        f.squad !== undefined ? { squad: f.squad } : {};
      const ngThenSquad = applyFilters(applyFilters(r, fNg), fSquad);
      const squadThenNg = applyFilters(applyFilters(r, fSquad), fNg);
      assert.deepStrictEqual(ngThenSquad, squadThenNg);
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 12.4 — Correctness                                        */
/* ------------------------------------------------------------------ */

test("Property 12 (correctness): every filtered item matches every non-empty dimension", () => {
  fc.assert(
    fc.property(arbAllocationResponse, arbFilters, (r, f) => {
      const out = applyFilters(r, f);
      assertItemsMatchFilter(out, f);

      // Sanity: no NaN or Infinity leaks through the filter path.
      assert.ok(
        Number.isFinite(out.totalMonthlyEur),
        `totalMonthlyEur is not finite: ${out.totalMonthlyEur}`,
      );
      assert.ok(
        Number.isFinite(out.totalSpotCoveragePct),
        `totalSpotCoveragePct is not finite: ${out.totalSpotCoveragePct}`,
      );
      assert.ok(
        Number.isFinite(out.totalEstimatedSavingsEur),
        `totalEstimatedSavingsEur is not finite: ${out.totalEstimatedSavingsEur}`,
      );

      // Types survive the filter path — this catches accidental structural
      // changes that TypeScript alone would not detect at runtime.
      assert.ok(
        Array.isArray(out.environments) &&
          Array.isArray(out.nodegroups) &&
          Array.isArray(out.squads) &&
          Array.isArray(out.workloads) &&
          Array.isArray(out.recommendations) &&
          Array.isArray(out.warnings),
        "filtered response must preserve the shape of every collection",
      );

      // Silence unused-import warnings for the item types — they document
      // the shape the callback iterates over.
      const _typecheck: readonly [
        Environment[],
        Nodegroup[],
        Squad[],
        Workload[],
        Recommendation[],
      ] = [
        out.environments,
        out.nodegroups,
        out.squads,
        out.workloads,
        out.recommendations,
      ];
      void _typecheck;
    }),
    { numRuns: 100 },
  );
});
