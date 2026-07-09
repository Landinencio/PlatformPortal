/**
 * Property-based tests for k8s-metrics namespace parsing.
 *
 * Feature: dora-metrics-production-readiness
 * Property 4: Parsing de Namespaces desde Variable de Entorno
 *
 * **Validates: Requirements 4.2**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { parseNamespacesEnv } from "../k8s-metrics";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Generate a valid namespace-like string (non-empty, no commas, no leading/trailing spaces) */
const namespaceArb = fc
  .stringMatching(/^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/)
  .filter((s) => s.length >= 1);

/** Generate a namespace with optional surrounding whitespace */
const paddedNamespaceArb = fc.tuple(
  fc.stringMatching(/^[ \t]{0,3}$/),
  namespaceArb,
  fc.stringMatching(/^[ \t]{0,3}$/)
).map(([pre, ns, post]) => pre + ns + post);

/* ------------------------------------------------------------------ */
/*  Property 4: Namespace Parsing                                      */
/*  **Validates: Requirements 4.2**                                    */
/* ------------------------------------------------------------------ */

test("Property 4: parseNamespacesEnv returns a Set with trimmed non-empty values without duplicates", () => {
  fc.assert(
    fc.property(
      fc.array(paddedNamespaceArb, { minLength: 1, maxLength: 20 }),
      (namespaces) => {
        // Build a comma-separated string with possible extra commas/spaces
        const input = namespaces.join(",");
        const result = parseNamespacesEnv(input);

        // Result should be a Set
        assert.ok(result instanceof Set, "Result should be a Set");

        // All values in the result should be trimmed (no leading/trailing whitespace)
        for (const value of result) {
          assert.equal(value, value.trim(), `Value "${value}" should be trimmed`);
        }

        // No empty strings in the result
        for (const value of result) {
          assert.ok(value.length > 0, "No empty strings should be in the result");
        }

        // The result should contain exactly the unique trimmed non-empty values
        const expected = new Set(
          namespaces.map((n) => n.trim()).filter((n) => n.length > 0)
        );
        assert.deepEqual(result, expected, "Result should match expected unique trimmed values");
      }
    ),
    { numRuns: 200 }
  );
});

test("Property 4: parseNamespacesEnv handles strings with extra commas and empty segments", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          paddedNamespaceArb,
          fc.constant(""),       // empty segment
          fc.constant("   "),   // whitespace-only segment
        ),
        { minLength: 0, maxLength: 20 }
      ),
      (segments) => {
        const input = segments.join(",");
        const result = parseNamespacesEnv(input);

        // Result should be a Set
        assert.ok(result instanceof Set, "Result should be a Set");

        // No empty strings in the result
        for (const value of result) {
          assert.ok(value.length > 0, "No empty strings should be in the result");
          assert.equal(value, value.trim(), `Value "${value}" should be trimmed`);
        }

        // Verify deduplication: size should equal unique non-empty trimmed values
        const expectedValues = segments
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const expectedSet = new Set(expectedValues);
        assert.equal(
          result.size,
          expectedSet.size,
          "Result size should equal number of unique non-empty trimmed values"
        );
      }
    ),
    { numRuns: 200 }
  );
});

test("Property 4: parseNamespacesEnv deduplicates identical namespaces", () => {
  fc.assert(
    fc.property(
      namespaceArb,
      fc.integer({ min: 2, max: 10 }),
      (ns, count) => {
        // Create input with the same namespace repeated
        const input = Array(count).fill(ns).join(",");
        const result = parseNamespacesEnv(input);

        assert.equal(result.size, 1, "Duplicates should be deduplicated to a single entry");
        assert.ok(result.has(ns), "The deduplicated value should be present");
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 4: parseNamespacesEnv returns empty Set for empty/whitespace-only input", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[, \t]{0,20}$/),
      (input) => {
        const result = parseNamespacesEnv(input);
        assert.equal(result.size, 0, "Should return empty Set for input with no valid namespaces");
      }
    ),
    { numRuns: 100 }
  );
});
