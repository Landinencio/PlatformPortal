/**
 * Property-based test for the RDS Catalogo_Dinamico fallback contract.
 *
 * Feature: infra-self-service-hardening — src/lib/rds/aws-engine-catalog.ts
 *
 * Feature: infra-self-service-hardening, Property 6: listRdsEngineOptions honours fallback contract
 *
 * Validates: Requirements 1.5, 1.6, 1.7, 1.8
 *
 * The property covers the four invariants required by the task file 3.2:
 *   (a) AWS success           → { ok: true } without `stale` / `staleSince`
 *                               and the fresh 24h cache is populated so
 *                               subsequent calls do NOT invoke AWS (Req 1.5, 1.6).
 *   (b) AWS error + prior     → { ok: true, options[k].stale === true,
 *       cache (< 24h)           options[k].staleSince ∈ ISO 8601 } (Req 1.7).
 *   (c) AWS error + no cache  → { ok: false, error: { code: "catalog_unavailable",
 *                               engine, region } } (Req 1.8).
 *   (d) Fresh cache hit       → the AWS mock counter stays the same (Req 1.6).
 *
 * Each scenario is a separate `test()` so the failure output identifies the
 * broken invariant without ambiguity.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import type { DBEngineVersion, DescribeDBEngineVersionsCommand } from "@aws-sdk/client-rds";

import {
  listRdsEngineOptions,
  __setTestClientFactoryForTests,
  __setTestClockForTests,
  __resetTestCacheForTests,
  __expireFreshCacheForTests,
} from "../aws-engine-catalog";

// ─── Test fixtures ───────────────────────────────────────────────────────────

const ENGINE = "postgres";
const REGION = "eu-west-1";

/** ISO 8601 UTC with millis, as emitted by `Date#toISOString()`. */
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface MockContext {
  sendCalls: number;
  mode: "success" | "error";
  payload: DBEngineVersion[];
}

/**
 * Structural mock of the RDS client the module speaks to. Counts every
 * `send` invocation so the property can assert cache-hit behaviour. When
 * `mode === "error"` the mock rejects — mimicking either an AWS API failure
 * or the timeout abort of Req 1.7.
 */
function makeMockFactory(ctx: MockContext) {
  return (_region: string) => ({
    async send(
      _cmd: DescribeDBEngineVersionsCommand,
      _opts?: { abortSignal?: AbortSignal },
    ): Promise<{ DBEngineVersions?: DBEngineVersion[]; Marker?: string }> {
      ctx.sendCalls++;
      if (ctx.mode === "error") throw new Error("aws unavailable (mock)");
      return { DBEngineVersions: ctx.payload };
    },
  });
}

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * Realistic engine version generator. Both `EngineVersion` and
 * `DBParameterGroupFamily` are always non-empty strings so `toEngineOptions`
 * inside the module never drops the row — the property tests always operate
 * on at least one option.
 */
const engineVersionArb: fc.Arbitrary<DBEngineVersion> = fc
  .tuple(fc.integer({ min: 9, max: 17 }), fc.integer({ min: 0, max: 20 }))
  .chain(([major, minor]) =>
    fc.record({
      EngineVersion: fc.constant(`${major}.${minor}`),
      DBParameterGroupFamily: fc.constant(`postgres${major}`),
      Status: fc.constantFrom("available", "deprecated"),
    }),
  );

/** Non-empty payload — at least one row survives the whitelist filter. */
const payloadArb = fc.array(engineVersionArb, { minLength: 1, maxLength: 8 });

// ─── Global cleanup ──────────────────────────────────────────────────────────

test.after(() => {
  __setTestClientFactoryForTests(null);
  __setTestClockForTests(null);
  __resetTestCacheForTests();
});

// ─── Properties ──────────────────────────────────────────────────────────────

// Feature: infra-self-service-hardening, Property 6: listRdsEngineOptions honours fallback contract
test("Property 6 — scenario (a): AWS success returns ok:true with no stale marker", async () => {
  await fc.assert(
    fc.asyncProperty(payloadArb, async (payload) => {
      __resetTestCacheForTests();
      const ctx: MockContext = { sendCalls: 0, mode: "success", payload };
      __setTestClientFactoryForTests(makeMockFactory(ctx));

      const result = await listRdsEngineOptions(ENGINE, REGION);

      assert.equal(result.ok, true, "AWS success must return ok:true");
      if (result.ok) {
        assert.ok(result.options.length > 0, "expected at least one option");
        for (const opt of result.options) {
          assert.equal(opt.stale, undefined, "fresh responses must not carry stale");
          assert.equal(opt.staleSince, undefined, "fresh responses must not carry staleSince");
          assert.equal(typeof opt.version, "string");
          assert.equal(typeof opt.family, "string");
          assert.equal(typeof opt.deprecated, "boolean");
        }
      }
      assert.equal(ctx.sendCalls, 1, "AWS must be called exactly once on a cold cache");
    }),
    { numRuns: 100 },
  );
});

// Feature: infra-self-service-hardening, Property 6: listRdsEngineOptions honours fallback contract
test("Property 6 — scenario (b): AWS error with prior cache returns stale=true and ISO 8601 staleSince", async () => {
  await fc.assert(
    fc.asyncProperty(payloadArb, async (payload) => {
      __resetTestCacheForTests();
      const ctx: MockContext = { sendCalls: 0, mode: "success", payload };
      __setTestClientFactoryForTests(makeMockFactory(ctx));

      // Prime the stale store with a successful call.
      const first = await listRdsEngineOptions(ENGINE, REGION);
      assert.equal(first.ok, true);
      assert.equal(ctx.sendCalls, 1);

      // Simulate the 24h TTL expiring (drop fresh cache, keep stale store).
      __expireFreshCacheForTests();

      // Second call: AWS fails. Fallback_Catalogo must engage.
      ctx.mode = "error";
      const second = await listRdsEngineOptions(ENGINE, REGION);

      assert.equal(second.ok, true, "stale fallback must return ok:true");
      if (second.ok) {
        assert.ok(second.options.length > 0, "stale response must carry options");
        for (const opt of second.options) {
          assert.equal(opt.stale, true, "each option must be marked stale (Req 1.7)");
          assert.ok(opt.staleSince, "staleSince must be present");
          assert.ok(
            ISO_8601_UTC.test(opt.staleSince!),
            `staleSince "${opt.staleSince}" must be ISO 8601 UTC with millis`,
          );
          // staleSince must be parseable and round-trip through Date.
          const parsed = new Date(opt.staleSince!);
          assert.ok(!Number.isNaN(parsed.getTime()), "staleSince must be Date-parseable");
        }
      }
      assert.equal(
        ctx.sendCalls,
        2,
        "AWS should be re-invoked once after fresh cache expiry (stale path)",
      );
    }),
    { numRuns: 100 },
  );
});

// Feature: infra-self-service-hardening, Property 6: listRdsEngineOptions honours fallback contract
test("Property 6 — scenario (c): AWS error with no prior cache returns catalog_unavailable", async () => {
  await fc.assert(
    fc.asyncProperty(fc.constant(null), async () => {
      __resetTestCacheForTests();
      const ctx: MockContext = { sendCalls: 0, mode: "error", payload: [] };
      __setTestClientFactoryForTests(makeMockFactory(ctx));

      const result = await listRdsEngineOptions(ENGINE, REGION);

      assert.equal(result.ok, false, "no prior cache + AWS error must fail");
      if (!result.ok) {
        assert.equal(result.error.code, "catalog_unavailable", "Req 1.8 error code");
        assert.equal(result.error.engine, ENGINE, "error must carry the engine (Req 1.8)");
        assert.equal(result.error.region, REGION, "error must carry the region (Req 1.8)");
      }
      assert.equal(ctx.sendCalls, 1, "AWS mock is invoked exactly once");
    }),
    { numRuns: 100 },
  );
});

// Feature: infra-self-service-hardening, Property 6: listRdsEngineOptions honours fallback contract
test("Property 6 — scenario (d): fresh cache hit (< 24h) does NOT invoke the AWS client", async () => {
  await fc.assert(
    fc.asyncProperty(
      payloadArb,
      fc.integer({ min: 1, max: 5 }),
      async (payload, extraHits) => {
        __resetTestCacheForTests();
        const ctx: MockContext = { sendCalls: 0, mode: "success", payload };
        __setTestClientFactoryForTests(makeMockFactory(ctx));

        // Cold call — cache miss.
        const first = await listRdsEngineOptions(ENGINE, REGION);
        assert.equal(first.ok, true);
        assert.equal(ctx.sendCalls, 1, "the first call populates the fresh cache");

        // Any number of subsequent calls within the 24h TTL must hit the
        // fresh cache and skip AWS entirely (Req 1.6).
        for (let i = 0; i < extraHits; i++) {
          const hit = await listRdsEngineOptions(ENGINE, REGION);
          assert.equal(hit.ok, true, "cached call must remain ok:true");
          if (hit.ok) {
            for (const opt of hit.options) {
              assert.equal(opt.stale, undefined, "cached options must not carry stale");
            }
          }
        }
        assert.equal(
          ctx.sendCalls,
          1,
          "fresh cache hits must NOT invoke the AWS mock (counter stays at 1)",
        );
      },
    ),
    { numRuns: 100 },
  );
});
