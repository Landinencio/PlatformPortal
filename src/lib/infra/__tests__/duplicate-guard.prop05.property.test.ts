/**
 * Property-based tests for `checkDuplicate` cache semantics (Guardia_Duplicado).
 *
 * Feature: infra-self-service-hardening, Property 5: checkDuplicate is idempotent within the 60s cache window
 *
 * **Validates: Requirements 2.6, 2.10**
 *
 * Strategy:
 *   - Stub `global.fetch` with a counter + configurable status so the module
 *     under test never touches the network, and we can count how many times
 *     the real HTTP layer would have been hit.
 *   - Freeze `Date.now` behind a controllable mock so we can advance time
 *     deterministically across the 60 s cache TTL boundary without any
 *     real sleeps.
 *   - Silence `process.stdout.write` for the duration of the suite so the
 *     `InfraLogger` JSON emitted on every check does not swamp the test
 *     output (100 fast-check runs × 4 calls each = 400+ lines).
 *   - Clear the shared cache prefix `duplicate-guard` at the start of every
 *     fast-check iteration so property runs are independent.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

/* ------------------------------------------------------------------ */
/*  Test doubles (installed BEFORE importing the module under test)    */
/* ------------------------------------------------------------------ */

process.env.GITLAB_TOKEN = process.env.GITLAB_TOKEN || "test-token";

/** Controllable monotonic clock. Advanced by the property, read by cache.ts. */
let mockNow = 1_000_000_000;
const originalDateNow = Date.now;
Date.now = () => mockNow;

/** Counts how many times `performCheck` would have hit GitLab. */
let fetchCallCount = 0;

/** Fixed HTTP outcome for the current fast-check iteration. */
type FetchOutcome = "found" | "missing" | "server-error";
let fetchOutcome: FetchOutcome = "found";

const originalFetch = globalThis.fetch;
(globalThis as { fetch?: unknown }).fetch = async () => {
  fetchCallCount++;
  const status =
    fetchOutcome === "found" ? 200 : fetchOutcome === "missing" ? 404 : 500;
  return new Response(null, { status });
};

/** Silence InfraLogger noise. */
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((..._args: unknown[]) => true) as typeof process.stdout.write;

test.after(() => {
  Date.now = originalDateNow;
  (globalThis as { fetch?: unknown }).fetch = originalFetch;
  process.stdout.write = originalStdoutWrite;
});

/* ------------------------------------------------------------------ */
/*  Module under test (imported AFTER the stubs are installed)         */
/* ------------------------------------------------------------------ */

import {
  checkDuplicate,
  invalidateDuplicateCache,
  DUPLICATE_CACHE_TTL_MS,
} from "../duplicate-guard";
import { invalidateCache } from "@/lib/cache";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Positive integer project id. */
const projectIdArb = fc.integer({ min: 1, max: 1_000_000 });

/** Realistic git refs (default branches the portal actually resolves). */
const refArb = fc.constantFrom("main", "master", "develop");

/**
 * Arbitrary non-empty file path. The mock never inspects the URL, so we can
 * exercise the cache key with any string — no URL-encoding constraints apply.
 */
const filePathArb = fc.string({ minLength: 1, maxLength: 100 });

/** Cover all three deterministic branches of `performCheck`. */
const outcomeArb: fc.Arbitrary<FetchOutcome> = fc.constantFrom(
  "found",
  "missing",
  "server-error"
);

/* ------------------------------------------------------------------ */
/*  Property 5                                                         */
/* ------------------------------------------------------------------ */

test("Property 5: checkDuplicate is idempotent within the 60s cache window", async () => {
  await fc.assert(
    fc.asyncProperty(
      projectIdArb,
      refArb,
      filePathArb,
      outcomeArb,
      async (projectId, ref, filePath, outcome) => {
        // Reset shared state between iterations so runs are independent.
        invalidateCache("duplicate-guard");
        fetchCallCount = 0;
        fetchOutcome = outcome;
        mockNow = 1_000_000_000;

        // Call 1 — cache miss, real fetch performed exactly once.
        const r1 = await checkDuplicate(projectId, ref, filePath);
        assert.equal(
          fetchCallCount,
          1,
          "first call must miss the cache and hit fetch exactly once"
        );

        // Call 2 — still within the 60 s window, must be a cache hit
        // (fetch counter unchanged) and structurally identical to r1.
        mockNow += Math.floor(DUPLICATE_CACHE_TTL_MS / 2); // +30s, well inside 60s
        const r2 = await checkDuplicate(projectId, ref, filePath);
        assert.equal(
          fetchCallCount,
          1,
          "second call within 60 s must NOT invoke fetch again"
        );
        assert.deepStrictEqual(
          r2,
          r1,
          "second call within 60 s must return a structurally identical result"
        );

        // Call 3 — cross the TTL boundary. Entry expired → fresh fetch.
        // We advance to strictly > DUPLICATE_CACHE_TTL_MS after r1 was cached.
        mockNow += DUPLICATE_CACHE_TTL_MS + 1; // total elapsed > 60s from r1
        const r3 = await checkDuplicate(projectId, ref, filePath);
        assert.equal(
          fetchCallCount,
          2,
          "call after TTL expiry must re-invoke fetch (counter += 1)"
        );
        assert.deepStrictEqual(
          r3,
          r1,
          "same input + same fetch behaviour must yield a structurally identical result"
        );

        // r3 has repopulated the cache; invalidateDuplicateCache reports it existed.
        const existed = invalidateDuplicateCache(projectId, ref, filePath);
        assert.equal(
          existed,
          true,
          "invalidateDuplicateCache must report the live entry existed"
        );

        // Call 4 — cache was just invalidated (no clock advance), so fetch fires again.
        const r4 = await checkDuplicate(projectId, ref, filePath);
        assert.equal(
          fetchCallCount,
          3,
          "call after invalidateDuplicateCache must re-invoke fetch (counter += 1)"
        );
        assert.deepStrictEqual(
          r4,
          r1,
          "post-invalidation result must be structurally identical under identical fetch behaviour"
        );

        // And a second invalidation on the (now re-populated) key must again succeed.
        assert.equal(
          invalidateDuplicateCache(projectId, ref, filePath),
          true,
          "invalidateDuplicateCache must report the entry existed after r4 repopulated it"
        );
        // A third invalidation with no intervening check must report `false`
        // (entry no longer present).
        assert.equal(
          invalidateDuplicateCache(projectId, ref, filePath),
          false,
          "invalidateDuplicateCache on an already-evicted key must return false"
        );
      }
    ),
    { numRuns: 100 }
  );
});
