// Feature: infra-self-service-hardening, Property 3: classifyExecuteError covers all ErrorCode and suggestionForCode is total
/**
 * Property-based tests for the deterministic error classifier.
 *
 * Feature: infra-self-service-hardening
 * Property 3: classifyExecuteError covers all ErrorCode and suggestionForCode is total
 *
 * Three universal properties:
 *
 *   (a) `∀ code ∈ ErrorCode`: `suggestionForCode(code)` returns a string of
 *       length ≥ 10 (surjective suggestion table, Req 5.3).
 *   (b) `∀ err, step`: `classifyExecuteError(err, step)` never throws and
 *       always returns a member of `ErrorCode` (Req 5.1).
 *   (c) Specific rule: when `err instanceof Error` whose message contains
 *       `"already exists"` and `step === "create_file"`, the classifier
 *       yields exactly `"resource_exists_at_execute"` (Req 6.3, mirror of
 *       Req 5.1's canonical case).
 *
 * **Validates: Requirements 5.1, 5.3, 6.3**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  ERROR_CODES,
  EXECUTE_STEPS,
  classifyExecuteError,
  suggestionForCode,
  type ErrorCode,
} from "../error-classifier";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Sample uniformly from the concrete set of ErrorCode values. */
const errorCodeArb: fc.Arbitrary<ErrorCode> = fc.constantFrom(...ERROR_CODES);

/** Sample uniformly from the concrete set of ExecuteStep values. */
const executeStepArb = fc.constantFrom(...EXECUTE_STEPS);

/**
 * Anything at all. `classifyExecuteError` must be total, so we throw the
 * kitchen sink at it: primitives, arrays, plain objects, nested structures,
 * `null`/`undefined`, numbers, booleans, symbols, ... — whatever `fc.anything`
 * can produce.
 */
const anythingArb = fc.anything();

/** Random fragments used to build "already exists" messages. */
const surroundingArb = fc.string({ maxLength: 40 });

/* ------------------------------------------------------------------ */
/*  Property 3.a — suggestionForCode is total (Req 5.3)                */
/* ------------------------------------------------------------------ */

test("suggestionForCode returns a non-trivial (≥10 chars) string for every ErrorCode", () => {
  fc.assert(
    fc.property(errorCodeArb, (code) => {
      const suggestion = suggestionForCode(code);
      assert.equal(typeof suggestion, "string", `code=${code}`);
      assert.ok(
        suggestion.length >= 10,
        `suggestion for code=${code} is too short: ${JSON.stringify(suggestion)}`
      );
    }),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 3.b — classifyExecuteError is total (Req 5.1)             */
/* ------------------------------------------------------------------ */

test("classifyExecuteError never throws and always returns a member of ERROR_CODES", () => {
  const codeSet: ReadonlySet<string> = new Set<string>(ERROR_CODES);
  fc.assert(
    fc.property(anythingArb, executeStepArb, (err, step) => {
      let code: ErrorCode;
      try {
        code = classifyExecuteError(err, step);
      } catch (thrown) {
        assert.fail(
          `classifyExecuteError threw for step=${step}: ${String(thrown)}`
        );
      }
      assert.ok(
        codeSet.has(code),
        `returned code ${JSON.stringify(code)} is not in ERROR_CODES (step=${step})`
      );
    }),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 3.c — "already exists" at create_file is canonical (Req 6.3) */
/* ------------------------------------------------------------------ */

test('Error with "already exists" at step="create_file" classifies as resource_exists_at_execute', () => {
  fc.assert(
    fc.property(surroundingArb, surroundingArb, (before, after) => {
      const err = new Error(`${before}already exists${after}`);
      const code = classifyExecuteError(err, "create_file");
      assert.equal(
        code,
        "resource_exists_at_execute",
        `unexpected code for message=${JSON.stringify(err.message)}`
      );
    }),
    { numRuns: 100 }
  );
});
