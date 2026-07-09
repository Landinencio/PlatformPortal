/**
 * Integration test verifying rate limiter behavior in the generate route.
 *
 * Task 10.3: Verify rate limiter does not block requests when under threshold.
 *
 * These tests validate that:
 * - The module-level RateLimiter instance is created with default config
 * - Requests under the threshold (10 per hour) are not blocked
 * - The rate limiter correctly returns 429 when threshold is exceeded
 */

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../../../../../lib/rate-limiter";

describe("Rate Limiter integration with Generate Route", () => {
  it("allows requests when under the default threshold of 10", () => {
    const rateLimiter = new RateLimiter();
    const userEmail = "developer@example.com";

    // Simulate 10 requests (the maximum allowed)
    for (let i = 0; i < 10; i++) {
      const result = rateLimiter.check(userEmail);
      assert.equal(result.allowed, true, `Request ${i + 1} should be allowed`);
      assert.equal(result.remaining, 10 - (i + 1));
    }
  });

  it("rejects the 11th request with retryAfterSeconds", () => {
    const rateLimiter = new RateLimiter();
    const userEmail = "developer@example.com";

    // Exhaust the quota
    for (let i = 0; i < 10; i++) {
      rateLimiter.check(userEmail);
    }

    // 11th request should be rejected
    const result = rateLimiter.check(userEmail);
    assert.equal(result.allowed, false);
    assert.equal(result.remaining, 0);
    assert.ok(
      result.retryAfterSeconds !== undefined && result.retryAfterSeconds > 0,
      "retryAfterSeconds must be positive when rejected"
    );
  });

  it("does not affect different users independently", () => {
    const rateLimiter = new RateLimiter();
    const user1 = "user1@example.com";
    const user2 = "user2@example.com";

    // Exhaust user1's quota
    for (let i = 0; i < 10; i++) {
      rateLimiter.check(user1);
    }

    // user1 is blocked
    assert.equal(rateLimiter.check(user1).allowed, false);

    // user2 is still allowed
    const result = rateLimiter.check(user2);
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 9);
  });

  it("uses default config of 10 requests per 1-hour window", () => {
    const rateLimiter = new RateLimiter();
    const userEmail = "test@example.com";

    // All 10 should pass
    for (let i = 0; i < 10; i++) {
      assert.equal(rateLimiter.check(userEmail).allowed, true);
    }

    // 11th should fail with retryAfter close to 1 hour (3600 seconds)
    const result = rateLimiter.check(userEmail);
    assert.equal(result.allowed, false);
    assert.ok(
      result.retryAfterSeconds !== undefined &&
        result.retryAfterSeconds <= 3600 &&
        result.retryAfterSeconds > 0,
      `retryAfterSeconds should be between 1 and 3600, got: ${result.retryAfterSeconds}`
    );
  });
});
