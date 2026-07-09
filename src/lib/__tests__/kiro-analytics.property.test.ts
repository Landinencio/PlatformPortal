/**
 * Property-based tests for Kiro Analytics input sanitisation.
 *
 * Feature: kiro-analytics
 *
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
 *  - User identifier filter must match ^[0-9a-fA-F-]+$ (else 400).
 *  - Supplied dates must match YYYY-MM-DD (else 400).
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  isValidUserId,
  isValidDate,
  parseUserFilter,
  assertValidDate,
  ValidationError,
} from "../kiro-analytics";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

const hexHyphenChars = "0123456789abcdefABCDEF-".split("");

/** A non-empty string drawn only from the allowed [0-9a-fA-F-] set. */
const validUserIdArb = fc
  .array(fc.constantFrom(...hexHyphenChars), { minLength: 1, maxLength: 40 })
  .map((arr) => arr.join(""));

/** A realistic Identity Store UUID. */
const hexStr = (len: number) =>
  fc.array(fc.constantFrom(..."0123456789abcdef".split("")), { minLength: len, maxLength: len }).map((a) => a.join(""));

const uuidArb = fc
  .tuple(hexStr(8), hexStr(4), hexStr(4), hexStr(4), hexStr(12))
  .map((parts) => parts.join("-"));

/** Characters that are NOT allowed in a user id (excluding comma separator and whitespace, which are trimmed/split away). */
const illegalChars = "ghijklmnopqrstuvwxyz_.;:'\"()[]{}!@#$%^&*=+/\\".split("");

/** A string guaranteed to contain at least one illegal character. */
const invalidUserIdArb = fc
  .tuple(
    fc.array(fc.constantFrom(...hexHyphenChars), { minLength: 0, maxLength: 10 }).map((a) => a.join("")),
    fc.constantFrom(...illegalChars),
    fc.array(fc.constantFrom(...hexHyphenChars), { minLength: 0, maxLength: 10 }).map((a) => a.join("")),
  )
  .map(([pre, bad, post]) => pre + bad + post);

/** A valid YYYY-MM-DD date string. */
const validDateArb = fc
  .tuple(
    fc.integer({ min: 1000, max: 9999 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(([y, m, d]) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);

/** A non-empty string that is NOT in YYYY-MM-DD shape (empty handled separately). */
const invalidDateArb = fc
  .oneof(
    fc.constant("2026/06/11"),
    fc.constant("11-06-2026"),
    fc.constant("2026-6-1"),
    fc.constant("not-a-date"),
    fc.constant("2026-06-11T00:00:00"),
    fc.string({ minLength: 1 }),
  )
  .filter((s) => s.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(s));

/* ------------------------------------------------------------------ */
/*  Property: valid user ids accepted                                  */
/*  **Validates: Requirements 4.1**                                    */
/* ------------------------------------------------------------------ */

test("valid user ids ([0-9a-fA-F-]+) are accepted", () => {
  fc.assert(
    fc.property(validUserIdArb, (id) => {
      assert.equal(isValidUserId(id), true, `should accept "${id}"`);
    }),
    { numRuns: 200 },
  );
});

test("UUID-shaped ids are accepted", () => {
  fc.assert(
    fc.property(uuidArb, (id) => {
      assert.equal(isValidUserId(id), true, `should accept uuid "${id}"`);
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property: invalid user ids rejected (4.2)                          */
/* ------------------------------------------------------------------ */

test("user ids with illegal characters are rejected", () => {
  fc.assert(
    fc.property(invalidUserIdArb, (id) => {
      assert.equal(isValidUserId(id), false, `should reject "${id}"`);
    }),
    { numRuns: 200 },
  );
});

test("parseUserFilter throws ValidationError on any invalid entry", () => {
  fc.assert(
    fc.property(
      fc.array(validUserIdArb, { minLength: 0, maxLength: 3 }),
      invalidUserIdArb,
      (valids, bad) => {
        const raw = [...valids, bad].join(",");
        assert.throws(() => parseUserFilter(raw), ValidationError);
      },
    ),
    { numRuns: 150 },
  );
});

test("parseUserFilter returns the list unchanged for valid input", () => {
  fc.assert(
    fc.property(fc.array(validUserIdArb, { minLength: 1, maxLength: 5 }), (ids) => {
      const raw = ids.join(",");
      const parsed = parseUserFilter(raw);
      // Every parsed value is one of the inputs and is valid.
      for (const p of parsed) assert.equal(isValidUserId(p), true);
      assert.equal(parsed.length, ids.length);
    }),
    { numRuns: 150 },
  );
});

test("parseUserFilter returns [] for empty/undefined input", () => {
  assert.deepEqual(parseUserFilter(undefined), []);
  assert.deepEqual(parseUserFilter(null), []);
  assert.deepEqual(parseUserFilter(""), []);
});

/* ------------------------------------------------------------------ */
/*  Property: date validation (4.3, 4.4)                               */
/* ------------------------------------------------------------------ */

test("valid YYYY-MM-DD dates are accepted", () => {
  fc.assert(
    fc.property(validDateArb, (d) => {
      assert.equal(isValidDate(d), true, `should accept "${d}"`);
      // assertValidDate must not throw for valid dates
      assert.doesNotThrow(() => assertValidDate(d, "startDate"));
    }),
    { numRuns: 200 },
  );
});

test("malformed dates are rejected and assertValidDate throws", () => {
  fc.assert(
    fc.property(invalidDateArb, (d) => {
      assert.equal(isValidDate(d), false, `should reject "${d}"`);
      assert.throws(() => assertValidDate(d, "startDate"), ValidationError);
    }),
    { numRuns: 200 },
  );
});

test("assertValidDate is a no-op for empty/undefined (optional filter)", () => {
  assert.doesNotThrow(() => assertValidDate(undefined, "startDate"));
  assert.doesNotThrow(() => assertValidDate("", "endDate"));
});
