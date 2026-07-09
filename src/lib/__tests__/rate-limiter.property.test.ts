/**
 * Property-based tests for RateLimiter.
 *
 * Feature: infra-robustness
 * Property 13: Rate limiter enforces per-user threshold
 *
 * **Validates: Requirements 9.1, 9.2**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { RateLimiter } from "../rate-limiter";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Generate a user key (email-like string) */
const userKeyArb = fc
  .tuple(
    fc
      .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")), {
        minLength: 1,
        maxLength: 15,
      })
      .map((chars) => chars.join("")),
    fc
      .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), {
        minLength: 2,
        maxLength: 8,
      })
      .map((chars) => chars.join(""))
  )
  .map(([local, domain]) => `${local}@${domain}.com`);

/** Generate a request count greater than the default threshold (10) */
const requestCountAboveThresholdArb = fc.integer({ min: 11, max: 50 });

/** Generate a request count at or below the threshold */
const requestCountAtOrBelowThresholdArb = fc.integer({ min: 1, max: 10 });

/* ------------------------------------------------------------------ */
/*  Property 13: Rate limiter enforces per-user threshold              */
/*  **Validates: Requirements 9.1, 9.2**                               */
/* ------------------------------------------------------------------ */

test("Property 13: first 10 requests from the same key are allowed", () => {
  fc.assert(
    fc.property(
      userKeyArb,
      requestCountAtOrBelowThresholdArb,
      (key, count) => {
        const limiter = new RateLimiter();

        for (let i = 0; i < count; i++) {
          const result = limiter.check(key);
          assert.equal(
            result.allowed,
            true,
            `Request ${i + 1} of ${count} should be allowed`
          );
          assert.equal(
            result.remaining,
            10 - (i + 1),
            `Remaining should be ${10 - (i + 1)} after request ${i + 1}`
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 13: requests beyond 10 from the same key are rejected", () => {
  fc.assert(
    fc.property(
      userKeyArb,
      requestCountAboveThresholdArb,
      (key, totalRequests) => {
        const limiter = new RateLimiter();

        // First 10 should all be allowed
        for (let i = 0; i < 10; i++) {
          const result = limiter.check(key);
          assert.equal(
            result.allowed,
            true,
            `Request ${i + 1} should be allowed (within threshold)`
          );
        }

        // All subsequent requests should be rejected
        for (let i = 10; i < totalRequests; i++) {
          const result = limiter.check(key);
          assert.equal(
            result.allowed,
            false,
            `Request ${i + 1} should be rejected (over threshold)`
          );
          assert.equal(
            result.remaining,
            0,
            "Remaining should be 0 when rejected"
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 13: rejected requests return positive retryAfterSeconds", () => {
  fc.assert(
    fc.property(
      userKeyArb,
      requestCountAboveThresholdArb,
      (key, totalRequests) => {
        const limiter = new RateLimiter();

        // Exhaust the quota
        for (let i = 0; i < 10; i++) {
          limiter.check(key);
        }

        // All subsequent requests must have positive retryAfterSeconds
        for (let i = 10; i < totalRequests; i++) {
          const result = limiter.check(key);
          assert.equal(result.allowed, false);
          assert.ok(
            result.retryAfterSeconds !== undefined,
            "retryAfterSeconds must be defined when rejected"
          );
          assert.ok(
            result.retryAfterSeconds! > 0,
            `retryAfterSeconds must be positive, got: ${result.retryAfterSeconds}`
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 13: different keys have independent rate limits", () => {
  fc.assert(
    fc.property(
      userKeyArb,
      userKeyArb,
      (key1, key2) => {
        // Skip if keys happen to be the same
        fc.pre(key1 !== key2);

        const limiter = new RateLimiter();

        // Exhaust key1's quota
        for (let i = 0; i < 10; i++) {
          limiter.check(key1);
        }

        // key1 should be rejected
        const result1 = limiter.check(key1);
        assert.equal(result1.allowed, false, "key1 should be rate-limited");

        // key2 should still be allowed
        const result2 = limiter.check(key2);
        assert.equal(result2.allowed, true, "key2 should not be affected by key1's limit");
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 13: configurable maxRequests threshold is respected", () => {
  fc.assert(
    fc.property(
      userKeyArb,
      fc.integer({ min: 1, max: 20 }),
      (key, maxRequests) => {
        const limiter = new RateLimiter({ maxRequests });

        // First maxRequests should be allowed
        for (let i = 0; i < maxRequests; i++) {
          const result = limiter.check(key);
          assert.equal(
            result.allowed,
            true,
            `Request ${i + 1} should be allowed (threshold: ${maxRequests})`
          );
        }

        // Next request should be rejected
        const result = limiter.check(key);
        assert.equal(
          result.allowed,
          false,
          `Request ${maxRequests + 1} should be rejected (threshold: ${maxRequests})`
        );
        assert.ok(
          result.retryAfterSeconds !== undefined && result.retryAfterSeconds > 0,
          "retryAfterSeconds must be positive when rejected"
        );
      }
    ),
    { numRuns: 100 }
  );
});
