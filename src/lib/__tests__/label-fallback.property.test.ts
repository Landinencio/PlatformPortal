// Feature: session-nav-hardening, Property 10: El fallback de i18n es total
/**
 * Property-based test for the total i18n label fallback.
 *
 * Feature: session-nav-hardening
 * Property 10: El fallback de i18n es total
 *
 * **Validates: Requirements 7.4, 7.5, 7.6**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  hasVisibleText,
  resolveLabelWithSpanishFallback,
} from "../i18n/label-fallback";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Strings composed only of whitespace characters (no visible text). */
const whitespaceOnlyArb = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v", "\u00a0"), {
    minLength: 0,
    maxLength: 8,
  })
  .map((chars) => chars.join(""));

/** Strings guaranteed to contain at least one non-whitespace character. */
const visibleTextArb = fc
  .tuple(whitespaceOnlyArb, fc.constantFrom("a", "Z", "9", "é", "Volver", "x"), whitespaceOnlyArb)
  .map(([pre, core, post]) => pre + core + post);

/**
 * Any candidate value the resolver may receive for a locale slot: strings with
 * text, empty strings, whitespace-only strings, or `undefined`.
 */
const candidateArb = fc.oneof(
  visibleTextArb,
  fc.constant(""),
  whitespaceOnlyArb,
  fc.constant(undefined),
  fc.string(),
);

const keyArb = fc.constantFrom("common.back", "http.forbidden", "any.key");

/* ------------------------------------------------------------------ */
/*  Property 10: El fallback de i18n es total                          */
/*  **Validates: Requirements 7.4, 7.5, 7.6**                          */
/* ------------------------------------------------------------------ */

test("Property 10: active value with visible text is returned as-is", () => {
  fc.assert(
    fc.property(visibleTextArb, candidateArb, keyArb, (activeValue, spanishValue, key) => {
      const result = resolveLabelWithSpanishFallback(activeValue, spanishValue, key);
      assert.equal(
        result,
        activeValue,
        `Active value with visible text must win: "${activeValue}"`,
      );
    }),
    { numRuns: 100 },
  );
});

test("Property 10: falls back to Spanish when active lacks visible text", () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.constant(undefined), fc.constant(""), whitespaceOnlyArb),
      visibleTextArb,
      keyArb,
      (activeValue, spanishValue, key) => {
        const result = resolveLabelWithSpanishFallback(activeValue, spanishValue, key);
        assert.equal(
          result,
          spanishValue,
          `Should fall back to Spanish "${spanishValue}" when active has no visible text`,
        );
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 10: falls back to the key when neither value has visible text", () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.constant(undefined), fc.constant(""), whitespaceOnlyArb),
      fc.oneof(fc.constant(undefined), fc.constant(""), whitespaceOnlyArb),
      keyArb,
      (activeValue, spanishValue, key) => {
        const result = resolveLabelWithSpanishFallback(activeValue, spanishValue, key);
        assert.equal(
          result,
          key,
          `Should return the key "${key}" when no value has visible text`,
        );
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 10: never returns empty/whitespace-only when an alternative has visible text", () => {
  fc.assert(
    fc.property(candidateArb, candidateArb, keyArb, (activeValue, spanishValue, key) => {
      const result = resolveLabelWithSpanishFallback(activeValue, spanishValue, key);
      // The result is always a string.
      assert.equal(typeof result, "string");
      // If any alternative (active or spanish) has visible text, the result
      // must itself have visible text (never a blank string).
      const anyVisible = hasVisibleText(activeValue) || hasVisibleText(spanishValue);
      if (anyVisible) {
        assert.ok(
          hasVisibleText(result),
          `Result must have visible text when an alternative does: got "${result}"`,
        );
      }
    }),
    { numRuns: 100 },
  );
});

test("Property 10: result is always exactly one of {active, spanish, key}", () => {
  fc.assert(
    fc.property(candidateArb, candidateArb, keyArb, (activeValue, spanishValue, key) => {
      const result = resolveLabelWithSpanishFallback(activeValue, spanishValue, key);
      const expected = hasVisibleText(activeValue)
        ? activeValue
        : hasVisibleText(spanishValue)
          ? spanishValue
          : key;
      assert.equal(result, expected);
    }),
    { numRuns: 100 },
  );
});
