/**
 * Property-based tests for `IDENTIFIER_PATTERN` (Guardia_Duplicado).
 *
 * Feature: infra-self-service-hardening, Property 4: IDENTIFIER_PATTERN accepts canonical identifiers and rejects invalid ones
 *
 * **Validates: Requirements 2.8, 6.1**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { IDENTIFIER_PATTERN, validateIdentifier } from "../duplicate-guard";

/* ------------------------------------------------------------------ */
/*  Character sets                                                     */
/* ------------------------------------------------------------------ */

/** Valid first-character set: [a-z0-9] (no hyphen, no uppercase, no underscore). */
const FIRST_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

/** Valid body-character set: [a-z0-9-]. */
const BODY_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-".split("");

/** Uppercase ASCII (forbidden). */
const UPPERCASE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

/**
 * Characters outside `[a-z0-9-]`, covering:
 *   - underscore `_` (design says explicitly rejected)
 *   - path/URL chars (`.`, `/`)
 *   - whitespace (` `, `\t`, `\n`)
 *   - punctuation and symbols
 * Any of them must cause the pattern to reject.
 */
const OUTSIDE_CHARS = "!@#$%^&*()+=[]{}|;:'\",.<>/?`~ \t\n_".split("");

/**
 * Helper: build a string of length in `[minLength, maxLength]` from a fixed
 * character set. We use `fc.array` + `.map(join)` because fast-check v4 no
 * longer exposes `fc.stringOf`.
 */
function stringOfChars(
  chars: string[],
  opts: { minLength: number; maxLength: number }
): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...chars), { minLength: opts.minLength, maxLength: opts.maxLength })
    .map((cs) => cs.join(""));
}

/* ------------------------------------------------------------------ */
/*  Positive generator                                                 */
/* ------------------------------------------------------------------ */

/**
 * Canonical identifier: first char in `[a-z0-9]`, remaining 0..62 chars
 * in `[a-z0-9-]`. Total length 1..63.
 */
const canonicalIdentifierArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...FIRST_CHARS),
    stringOfChars(BODY_CHARS, { minLength: 0, maxLength: 62 })
  )
  .map(([head, tail]) => head + tail);

test("Property 4 (positive): canonical identifiers ALWAYS match IDENTIFIER_PATTERN", () => {
  fc.assert(
    fc.property(canonicalIdentifierArb, (id) => {
      assert.ok(
        id.length >= 1 && id.length <= 63,
        `precondition: canonical length ${id.length} must be in [1, 63]`
      );
      assert.equal(
        IDENTIFIER_PATTERN.test(id),
        true,
        `Canonical identifier ${JSON.stringify(id)} (length ${id.length}) should match IDENTIFIER_PATTERN`
      );
      // And `validateIdentifier` accepts it as-is (already lowercase + trimmed).
      assert.deepEqual(validateIdentifier(id), { ok: true, value: id });
    }),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Negative generators (each independent)                             */
/* ------------------------------------------------------------------ */

/**
 * Identifiers whose FIRST character is disallowed: underscore, hyphen,
 * uppercase letter, whitespace, or other symbol outside `[a-z0-9]`.
 *
 * The rest of the string uses valid body chars so the ONLY thing wrong
 * is the leading character — this isolates the "first char" invariant.
 */
const badFirstCharArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom("_", "-", ".", "/", " ", "\t", "A", "Z", "!", "@", "#"),
    stringOfChars(BODY_CHARS, { minLength: 0, maxLength: 62 })
  )
  .map(([head, tail]) => head + tail);

test("Property 4 (negative): identifiers starting with a disallowed char NEVER match", () => {
  fc.assert(
    fc.property(badFirstCharArb, (id) => {
      assert.equal(
        IDENTIFIER_PATTERN.test(id),
        false,
        `Identifier with disallowed first char ${JSON.stringify(id[0])} (full: ${JSON.stringify(id)}) should NOT match`
      );
    }),
    { numRuns: 100 }
  );
});

/**
 * Identifiers containing at least one uppercase letter anywhere.
 * We anchor a valid head so the leading-char rule is respected, then
 * inject at least one uppercase letter to force the failure.
 */
const uppercaseIdentifierArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...FIRST_CHARS),
    stringOfChars(BODY_CHARS, { minLength: 0, maxLength: 30 }),
    fc.constantFrom(...UPPERCASE_CHARS),
    stringOfChars(BODY_CHARS, { minLength: 0, maxLength: 30 })
  )
  .map(([head, mid1, upper, mid2]) => head + mid1 + upper + mid2);

test("Property 4 (negative): identifiers containing uppercase letters NEVER match", () => {
  fc.assert(
    fc.property(uppercaseIdentifierArb, (id) => {
      assert.equal(
        IDENTIFIER_PATTERN.test(id),
        false,
        `Identifier with uppercase ${JSON.stringify(id)} should NOT match`
      );
    }),
    { numRuns: 100 }
  );
});

/**
 * Identifiers strictly longer than 63 characters, built only from valid
 * chars with a valid first char — the ONLY thing wrong is the length.
 */
const tooLongIdentifierArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...FIRST_CHARS),
    // 63..199 body chars → total length 64..200 (> 63).
    stringOfChars(BODY_CHARS, { minLength: 63, maxLength: 199 })
  )
  .map(([head, tail]) => head + tail);

test("Property 4 (negative): identifiers longer than 63 chars NEVER match", () => {
  fc.assert(
    fc.property(tooLongIdentifierArb, (id) => {
      assert.ok(id.length > 63, `precondition: length ${id.length} must be > 63`);
      assert.equal(
        IDENTIFIER_PATTERN.test(id),
        false,
        `Identifier of length ${id.length} should NOT match`
      );
    }),
    { numRuns: 100 }
  );
});

/**
 * Identifiers containing at least one character outside `[a-z0-9-]`
 * (underscore, dot, slash, whitespace, punctuation, control...).
 * Valid head + valid surrounding body ensures the ONLY thing wrong is
 * the injected out-of-charset char.
 */
const outsideCharsetIdentifierArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...FIRST_CHARS),
    stringOfChars(BODY_CHARS, { minLength: 0, maxLength: 30 }),
    fc.constantFrom(...OUTSIDE_CHARS),
    stringOfChars(BODY_CHARS, { minLength: 0, maxLength: 30 })
  )
  .map(([head, mid1, bad, mid2]) => head + mid1 + bad + mid2);

test("Property 4 (negative): identifiers with chars outside [a-z0-9-] NEVER match", () => {
  fc.assert(
    fc.property(outsideCharsetIdentifierArb, (id) => {
      assert.equal(
        IDENTIFIER_PATTERN.test(id),
        false,
        `Identifier with out-of-charset char ${JSON.stringify(id)} should NOT match`
      );
    }),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  validateIdentifier — normalization contract                        */
/* ------------------------------------------------------------------ */

test("validateIdentifier normalizes lowercase + trim before matching (raw '  ABC-DEF  ')", () => {
  const raw = "  ABC-DEF  ";

  // The RAW input must NOT match the pattern (uppercase + surrounding whitespace).
  assert.equal(
    IDENTIFIER_PATTERN.test(raw),
    false,
    "Raw uppercase + surrounding whitespace should NOT match IDENTIFIER_PATTERN directly"
  );

  // But `validateIdentifier` lowercases + trims first, so it accepts and returns
  // the canonical normalized value.
  assert.deepEqual(validateIdentifier(raw), { ok: true, value: "abc-def" });
});
