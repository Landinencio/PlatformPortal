// Feature: session-nav-hardening, Property 9: El umbral de aviso y los segundos restantes son coherentes
/**
 * Property-based test for the session-expiry warning threshold and remaining seconds.
 *
 * Feature: session-nav-hardening
 * Property 9: El umbral de aviso y los segundos restantes son coherentes
 *
 * **Validates: Requirements 1.3**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  WARNING_THRESHOLD_MS,
  msUntilExpiry,
  shouldWarn,
  isExpired,
  secondsRemaining,
} from "../session/session-expiry";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** `now` as an arbitrary epoch (ms) within a realistic, non-degenerate range. */
const nowArb = fc.integer({ min: 0, max: 4_102_444_800_000 }); // up to year 2100

/**
 * An offset (ms) between `now` and `expires`, spanning the past (negative,
 * already expired), the exact boundaries and the future (positive), with extra
 * weight around the warning threshold to exercise the `(0, 120000]` interval.
 */
const offsetArb = fc.oneof(
  fc.integer({ min: -10_000_000, max: 10_000_000 }),
  // Values clustered around the interesting boundaries: 0 and WARNING_THRESHOLD_MS.
  fc.constantFrom(
    -1,
    0,
    1,
    999,
    1000,
    1001,
    WARNING_THRESHOLD_MS - 1,
    WARNING_THRESHOLD_MS,
    WARNING_THRESHOLD_MS + 1,
  ),
);

/** Builds a valid ISO-8601 `expires` string from `now + offset`. */
function isoFrom(now: number, offset: number): string {
  return new Date(now + offset).toISOString();
}

/** Invalid inputs for `expires`: not a parseable ISO string. */
const invalidExpiresArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(""),
  fc.constantFrom("not-a-date", "2025-13-40", "abc", "   ", "//"),
);

/* ------------------------------------------------------------------ */
/*  Property 9: threshold + remaining seconds coherence                */
/*  **Validates: Requirements 1.3**                                    */
/* ------------------------------------------------------------------ */

test("Property 9: shouldWarn is true iff time-to-expiry is within (0, WARNING_THRESHOLD_MS]", () => {
  fc.assert(
    fc.property(nowArb, offsetArb, (now, offset) => {
      const expires = isoFrom(now, offset);
      const remaining = msUntilExpiry(expires, now);
      const expected = remaining > 0 && remaining <= WARNING_THRESHOLD_MS;
      assert.equal(
        shouldWarn(expires, now),
        expected,
        `shouldWarn must match remaining ∈ (0, ${WARNING_THRESHOLD_MS}]; remaining=${remaining}`,
      );
    }),
    { numRuns: 100 },
  );
});

test("Property 9: secondsRemaining is a non-negative integer coherent with the remaining time", () => {
  fc.assert(
    fc.property(nowArb, offsetArb, (now, offset) => {
      const expires = isoFrom(now, offset);
      const remaining = msUntilExpiry(expires, now);
      const secs = secondsRemaining(expires, now);

      // Always a non-negative integer.
      assert.ok(Number.isInteger(secs), `secondsRemaining must be an integer, got ${secs}`);
      assert.ok(secs >= 0, `secondsRemaining must be non-negative, got ${secs}`);

      if (remaining <= 0) {
        // Expired / boundary -> 0.
        assert.equal(secs, 0, `Expired session must yield 0 seconds; remaining=${remaining}`);
      } else {
        // Rounded up (ceil) and coherent with the ms remaining.
        assert.equal(
          secs,
          Math.ceil(remaining / 1000),
          `secondsRemaining must be ceil(remaining/1000); remaining=${remaining}`,
        );
        // Coherence bounds: covers the remaining time without over-counting a full second.
        assert.ok(secs * 1000 >= remaining, "seconds must cover the remaining ms");
        assert.ok((secs - 1) * 1000 < remaining, "seconds must not over-count a full second");
      }
    }),
    { numRuns: 100 },
  );
});

test("Property 9: shouldWarn implies a strictly positive secondsRemaining, and vice versa within the window", () => {
  fc.assert(
    fc.property(nowArb, offsetArb, (now, offset) => {
      const expires = isoFrom(now, offset);
      if (shouldWarn(expires, now)) {
        // If we are warning, the session is not yet expired and has positive seconds.
        assert.equal(isExpired(expires, now), false, "warning window is not expired");
        assert.ok(secondsRemaining(expires, now) > 0, "warning window has positive seconds");
        assert.ok(
          secondsRemaining(expires, now) <= Math.ceil(WARNING_THRESHOLD_MS / 1000),
          "seconds within the warning window are bounded by the threshold",
        );
      }
    }),
    { numRuns: 100 },
  );
});

test("Property 9: invalid or missing expires inputs are treated as expired (0)", () => {
  fc.assert(
    fc.property(nowArb, invalidExpiresArb, (now, expires) => {
      assert.equal(msUntilExpiry(expires, now), 0, "invalid input -> msUntilExpiry 0");
      assert.equal(secondsRemaining(expires, now), 0, "invalid input -> secondsRemaining 0");
      assert.equal(shouldWarn(expires, now), false, "invalid input -> no warning");
      assert.equal(isExpired(expires, now), true, "invalid input -> expired");
    }),
    { numRuns: 100 },
  );
});
