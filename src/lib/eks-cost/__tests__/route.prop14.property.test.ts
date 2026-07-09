// Feature: eks-cost-optimization, Property 14: Partial failures preserve computed sections and expose warnings
/**
 * Property-based test for the partial-failure semantics of the
 * `GET /api/finops/k8s-cost` pipeline.
 *
 * Feature: eks-cost-optimization
 * Property 14: Partial failures preserve computed sections and expose warnings
 *
 * ## Bypass rationale
 *
 * The route handler at `src/app/api/finops/k8s-cost/route.ts` wraps
 * {@link fetchEksCostSummary} inside `getServerSession` + `hasSessionMinimumRole`
 * + a `cached(...)` layer. The partial-fail semantics we want to characterize
 * (per-query `.catch` inside `Promise.all`, `metrics-partial-fail` warnings,
 * absence of `NaN` / `Infinity` in the output) live **inside**
 * `fetchEksCostSummary` — the route only forwards the response verbatim
 * with `status: 200`.
 *
 * Rather than mock NextAuth **and** the cache **and** the metrics client to
 * exercise the exact same fetcher pipeline via the route, we invoke
 * {@link fetchEksCostSummary} directly and inject a fake
 * `GrafanaMetricsClient` through `overrides.metrics`. The fake decides,
 * per query string, whether to fail (`throw`) or return an empty vector.
 * This makes the test hermetic and fast (no auth, no cache, no HTTP), and
 * the "response.status === 200" clause of the task becomes the moral
 * equivalent: the promise MUST resolve (never reject). If the route were
 * to be tested end-to-end it would surface exactly the same behaviour, so
 * the bypass does not weaken the coverage.
 *
 * ## Contract exercised
 *
 * For an arbitrary subset `F` of the 12 distinct queries the pipeline
 * issues (three in `fetchNodegroups`, eight in `fetchWorkloads`, one VPA
 * fetch in `fetchRecommendations`):
 *
 *   1. `fetchEksCostSummary(...)` resolves successfully. Because each
 *      fetcher wraps `ctx.metrics.query(...)` in `Promise.all` with an
 *      individual `.catch` (design §Backend > node-cost.ts and
 *      §Backend > rightsizing.ts), no single query failure ever escalates
 *      into a rejected promise. Route-wise, this maps to `status === 200`.
 *
 *   2. Every failed query produces at least one warning entry (see
 *      `safeQuery` and `fetchVpaMemUpper`, which each emit exactly one
 *      `metrics-partial-fail` warning per failure). Therefore
 *      `warnings.length >= |F|`. The pipeline is free to add *more*
 *      warnings (`empty-window`, `no-nodegroup-label`, `vpa-missing`) —
 *      those only ever push the count up, so the `>=` lower bound holds.
 *
 *   3. No numeric field anywhere in the response is `NaN` or `Infinity`.
 *      A recursive walker asserts this on the entire object graph so any
 *      new numeric field added in the future is picked up automatically.
 *
 *   4. Every top-level collection (`environments`, `nodegroups`, `squads`,
 *      `workloads`, `recommendations`) is a well-formed array whose items
 *      carry the correct runtime shape (aligned with `types.ts`).
 *
 * Conventions: node:test + node:assert/strict, fast-check ^4,
 * `{ numRuns: 30 }` (route-level tests are slower than pure-function ones;
 * 30 iterations is sufficient for coverage over the 12-query power set),
 * a `// Feature: ...` header comment on the file.
 *
 * **Validates: Requirements 8.2, 8.3**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { fetchEksCostSummary } from "@/lib/eks-cost/index";
import {
  qNodeCostHourly,
  qNodeCount,
  qSpotCount,
  qWorkloadCost,
  qWorkloadRequests,
  qWorkloadUsageP95,
  qNodegroupByNode,
  qPodToNode,
  qVpaRecommendation,
} from "@/lib/eks-cost/promql";
import type {
  GrafanaMetricsClient,
  PrometheusVectorResult,
} from "@/lib/grafana-metrics";
import type {
  AllocationResponse,
  RecommendationKind,
} from "@/lib/eks-cost/types";

/* ------------------------------------------------------------------ */
/*  Query catalog                                                      */
/* ------------------------------------------------------------------ */

/**
 * The exact set of distinct query strings the pipeline issues, in a stable
 * order. Kept in sync with the fetchers by construction (each entry calls
 * the same builder the production code uses). If a new query is added to
 * `fetchNodegroups`, `fetchWorkloads` or `fetchRecommendations`, this list
 * must grow accordingly — the property below only characterises the
 * queries it can see.
 */
const ALL_QUERIES: readonly string[] = [
  qNodeCostHourly(),
  qNodeCount(),
  qSpotCount(),
  qWorkloadCost("cpu"),
  qWorkloadCost("ram"),
  qWorkloadRequests("cpu"),
  qWorkloadRequests("mem"),
  qWorkloadUsageP95("cpu"),
  qWorkloadUsageP95("mem"),
  qNodegroupByNode(),
  qPodToNode(),
  qVpaRecommendation("mem-upper"),
] as const;

/**
 * fast-check arbitrary that picks an arbitrary subset `F` of
 * {@link ALL_QUERIES}. Represented as a boolean mask (one flag per query)
 * so shrinking is monotonic and easy to read in counterexamples.
 */
const arbFailureMask: fc.Arbitrary<boolean[]> = fc.array(fc.boolean(), {
  minLength: ALL_QUERIES.length,
  maxLength: ALL_QUERIES.length,
});

/* ------------------------------------------------------------------ */
/*  Mock GrafanaMetricsClient                                          */
/* ------------------------------------------------------------------ */

/**
 * Build a fake {@link GrafanaMetricsClient} that:
 *
 *   - Reports `ready: true` from `getStatus()` so the pipeline never
 *     short-circuits into the "not ready" branch (that is out of scope for
 *     this property).
 *   - For every incoming query, decides based on `failingQueries.has(...)`
 *     whether to reject with a synthetic `Error` (mirroring what the real
 *     client does when a fetch fails) or resolve with an empty vector
 *     (the least trivial well-formed success payload).
 *
 * An empty vector is deliberately picked as the success shape because it
 * still triggers every downstream code path — including the `empty-window`
 * warnings that pile on top of the per-query `metrics-partial-fail` ones.
 * That is intentional: it exercises the strict `warnings.length >= |F|`
 * inequality against a background of additional warnings, ensuring the
 * lower bound holds even when the pipeline produces "extra" warnings.
 *
 * The `queryRange` method is provided as a no-op that returns an empty
 * matrix so the type is fully satisfied even though the pipeline does not
 * currently call it.
 */
function makeFakeMetricsClient(
  failingQueries: ReadonlySet<string>,
): GrafanaMetricsClient {
  const client = {
    getStatus() {
      return {
        configured: true,
        ready: true,
        url: "https://example.invalid",
        username: "test",
        missing: [] as string[],
        notes: [],
      };
    },
    async query<TLabels extends Record<string, string> = Record<string, string>>(
      query: string,
    ): Promise<{
      result: PrometheusVectorResult<TLabels>[];
      warnings: string[];
    }> {
      if (failingQueries.has(query)) {
        throw new Error("simulated Grafana failure");
      }
      return { result: [], warnings: [] };
    },
    async queryRange() {
      return { result: [], warnings: [] };
    },
  };
  return client as unknown as GrafanaMetricsClient;
}

/* ------------------------------------------------------------------ */
/*  Numeric-cleanliness walker                                         */
/* ------------------------------------------------------------------ */

/**
 * Walk any JSON-like value and assert that every `number` encountered is
 * finite (`Number.isFinite`). Fails fast with a breadcrumb path so a
 * counterexample points at the exact offending field.
 *
 * Skips `null`, booleans, strings and functions; recurses into arrays,
 * plain objects and typed structures alike. Circular references are not
 * expected in the response (JSON-shaped) but a `Set` of already-visited
 * objects would be the extension point.
 */
function assertAllFinite(value: unknown, path: string): void {
  if (value === null || value === undefined) return;
  const t = typeof value;
  if (t === "number") {
    const n = value as number;
    assert.ok(
      Number.isFinite(n),
      `non-finite number at ${path}: ${String(n)}`,
    );
    return;
  }
  if (t !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertAllFinite(value[i], `${path}[${i}]`);
    }
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertAllFinite(v, `${path}.${k}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Shape assertions                                                   */
/* ------------------------------------------------------------------ */

const VALID_ENV_NAMES = new Set(["dev", "uat", "prod", "tooling"]);
const VALID_KINDS: readonly RecommendationKind[] = [
  "over-cpu",
  "over-mem",
  "under-cpu",
  "under-mem",
] as const;
const VALID_KIND_SET = new Set<RecommendationKind>(VALID_KINDS);

const VALID_WARNING_CODES = new Set([
  "metrics-not-configured",
  "metrics-partial-fail",
  "vpa-missing",
  "no-nodegroup-label",
  "no-squad-label",
  "empty-window",
]);

/**
 * Assert the runtime shape of every top-level collection so a regression
 * in `types.ts` or in the aggregators surfaces here rather than as a
 * cryptic `NaN` deeper down. Every field checked here matches `types.ts`
 * exactly.
 */
function assertResponseShape(response: AllocationResponse): void {
  assert.ok(
    typeof response.generatedAt === "string" && response.generatedAt.length > 0,
    "generatedAt must be a non-empty ISO string",
  );

  assert.ok(Array.isArray(response.environments), "environments must be an array");
  for (const e of response.environments) {
    assert.ok(
      VALID_ENV_NAMES.has(e.name),
      `environment.name is not a canonical env: ${String(e.name)}`,
    );
    assert.equal(typeof e.cluster, "string");
    assert.equal(typeof e.monthlyCostEur, "number");
    assert.equal(typeof e.nodeCount, "number");
    assert.equal(typeof e.spotCount, "number");
    assert.equal(typeof e.spotCoveragePct, "number");
    assert.ok(Array.isArray(e.nodegroups));
  }

  assert.ok(Array.isArray(response.nodegroups), "nodegroups must be an array");
  for (const ng of response.nodegroups) {
    assert.equal(typeof ng.name, "string");
    assert.equal(typeof ng.cluster, "string");
    assert.ok(
      VALID_ENV_NAMES.has(ng.environment),
      `nodegroup.environment is not canonical: ${String(ng.environment)}`,
    );
    assert.equal(typeof ng.nodeCount, "number");
    assert.equal(typeof ng.spotCount, "number");
    assert.equal(typeof ng.spotCoveragePct, "number");
    assert.equal(typeof ng.monthlyCostEur, "number");
    assert.equal(typeof ng.avgNodeCostEur, "number");
    assert.equal(typeof ng.overprovisioningEur, "number");
    assert.equal(typeof ng.excessNodes, "number");
  }

  assert.ok(Array.isArray(response.squads), "squads must be an array");
  for (const s of response.squads) {
    assert.equal(typeof s.name, "string");
    assert.equal(typeof s.monthlyCostEur, "number");
    assert.equal(typeof s.workloadCount, "number");
    assert.equal(typeof s.overprovisioningEur, "number");
  }

  assert.ok(Array.isArray(response.workloads), "workloads must be an array");
  for (const w of response.workloads) {
    assert.equal(typeof w.cluster, "string");
    assert.ok(
      VALID_ENV_NAMES.has(w.environment),
      `workload.environment is not canonical: ${String(w.environment)}`,
    );
    assert.equal(typeof w.namespace, "string");
    assert.equal(typeof w.workload, "string");
    assert.equal(typeof w.nodegroup, "string");
    assert.equal(typeof w.squad, "string");
    assert.equal(typeof w.podCount, "number");
    assert.equal(typeof w.cpuRequestCores, "number");
    assert.equal(typeof w.memRequestBytes, "number");
    assert.equal(typeof w.cpuUsageP95Cores, "number");
    assert.equal(typeof w.memUsageP95Bytes, "number");
    assert.equal(typeof w.monthlyCostEur, "number");
  }

  assert.ok(
    Array.isArray(response.recommendations),
    "recommendations must be an array",
  );
  for (const r of response.recommendations) {
    assert.equal(typeof r.cluster, "string");
    assert.ok(
      VALID_ENV_NAMES.has(r.environment),
      `recommendation.environment is not canonical: ${String(r.environment)}`,
    );
    assert.equal(typeof r.namespace, "string");
    assert.equal(typeof r.workload, "string");
    assert.equal(typeof r.nodegroup, "string");
    assert.equal(typeof r.squad, "string");
    assert.ok(
      VALID_KIND_SET.has(r.kind),
      `recommendation.kind is not canonical: ${String(r.kind)}`,
    );
    assert.equal(typeof r.currentRequest.value, "number");
    assert.equal(typeof r.currentRequest.k8s, "string");
    assert.equal(typeof r.recommendedRequest.value, "number");
    assert.equal(typeof r.recommendedRequest.k8s, "string");
    assert.equal(typeof r.estimatedSavingsEur, "number");
    assert.equal(typeof r.unitYamlBlock, "string");
    assert.equal(typeof r.reason, "string");
  }

  assert.ok(Array.isArray(response.warnings), "warnings must be an array");
  for (const w of response.warnings) {
    assert.ok(
      VALID_WARNING_CODES.has(w.code),
      `warning.code is not canonical: ${String(w.code)}`,
    );
    assert.equal(typeof w.message, "string");
    assert.equal(typeof w.source, "string");
  }
}

/* ------------------------------------------------------------------ */
/*  Property 14                                                        */
/* ------------------------------------------------------------------ */

test(
  "Property 14: an arbitrary subset F of failing queries yields status=200-equivalent, warnings.length >= |F|, and no NaN/Infinity",
  async () => {
    await fc.assert(
      fc.asyncProperty(arbFailureMask, async (mask) => {
        const failing = new Set<string>();
        for (let i = 0; i < ALL_QUERIES.length; i++) {
          if (mask[i]) failing.add(ALL_QUERIES[i]);
        }

        const metrics = makeFakeMetricsClient(failing);

        // 1. Route-equivalent of `status === 200`: the promise resolves. If
        //    an internal fetcher escaped its `.catch`, `fetchEksCostSummary`
        //    would reject and `await` would rethrow here, failing the run.
        const response = await fetchEksCostSummary({}, { metrics });

        // 2. `warnings.length >= |F|`. Each failure produces exactly one
        //    `metrics-partial-fail` warning; other warnings may appear on
        //    top (e.g. `empty-window`) but only push the count higher.
        assert.ok(
          response.warnings.length >= failing.size,
          `expected at least ${failing.size} warnings, got ${response.warnings.length}`,
        );

        // 3. No NaN / Infinity anywhere in the response — recursive walk so
        //    any future numeric field is covered automatically.
        assertAllFinite(response, "response");

        // 4. Every top-level collection is a well-formed array with the
        //    correct item shape aligned with `types.ts`.
        assertResponseShape(response);

        // Extra sanity that costs nothing: totals honour their type/domain
        // (finite, non-negative). These are the fields most likely to bite
        // the UI first if a divide-by-zero leaks through.
        assert.ok(response.totalMonthlyEur >= 0);
        assert.ok(response.totalNodeCount >= 0);
        assert.ok(
          response.totalSpotCoveragePct >= 0 &&
            response.totalSpotCoveragePct <= 100,
          `totalSpotCoveragePct out of [0,100]: ${response.totalSpotCoveragePct}`,
        );
        assert.ok(response.totalEstimatedSavingsEur >= 0);
      }),
      { numRuns: 30 },
    );
  },
);
