// Feature: infra-self-service-hardening, Property 8: Error_Persistido satisfies structural invariants
/**
 * Property-based tests for `buildErrorPersisted` — the helper that builds the
 * `ErrorPersisted` payload persisted in `infra_requests.error_message`.
 *
 * Feature: infra-self-service-hardening
 * Property 8: Error_Persistido satisfies structural invariants
 *
 * Universal invariants (∀ err, step, code?, now?):
 *
 *   (a) `code ∈ ERROR_CODES` (the classifier fallback or the explicit override
 *       is always a valid member of the enum — Req 5.2b).
 *   (b) `step ∈ EXECUTE_STEPS` and matches the `step` argument passed in
 *       (persistence preserves the caller-supplied step — Req 5.2b).
 *   (c) `message.length ∈ [10, 500]` inclusive (Req 5.2c).
 *   (d) `timestamp` ends in `"Z"` and is parseable as ISO 8601 UTC, i.e.
 *       `Date.parse(t) === new Date(t).getTime()` (Req 5.2a).
 *
 * These invariants must hold regardless of the shape of `err` (primitives,
 * arrays, nested objects, `null`/`undefined`), whether the caller supplies
 * an explicit `code`, and whether the caller supplies an explicit `now` — the
 * four possible arities of the helper are all exercised via `fc.option`.
 *
 * **Validates: Requirements 5.2, 5.9**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  ERROR_CODES,
  ERROR_MESSAGE_MAX_LENGTH,
  ERROR_MESSAGE_MIN_LENGTH,
  EXECUTE_STEPS,
  buildErrorPersisted,
  type ErrorCode,
  type ExecuteStep,
} from "../error-classifier";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Kitchen-sink `err` values: primitives, arrays, plain objects, nulls, ... */
const errArb = fc.anything();

/** Sample uniformly from the concrete set of ExecuteStep values. */
const stepArb: fc.Arbitrary<ExecuteStep> = fc.constantFrom(...EXECUTE_STEPS);

/** Optional explicit code override — exercises the 3rd argument. */
const optionalCodeArb: fc.Arbitrary<ErrorCode | undefined> = fc.option(
  fc.constantFrom<ErrorCode>(...ERROR_CODES),
  { nil: undefined, freq: 3 }
);

/**
 * Optional explicit `now` — a finite epoch-milliseconds number spanning past
 * and future (Date.now ± ~317 years) so we exercise `toISOString`'s full ISO
 * 8601 UTC range without triggering `RangeError: Invalid time value`.
 */
const optionalNowArb: fc.Arbitrary<number | undefined> = fc.option(
  fc.integer({ min: 0, max: Date.now() + 1e10 }),
  { nil: undefined, freq: 3 }
);

/* ------------------------------------------------------------------ */
/*  Precomputed sets for O(1) membership assertions                    */
/* ------------------------------------------------------------------ */

const CODE_SET: ReadonlySet<string> = new Set<string>(ERROR_CODES);
const STEP_SET: ReadonlySet<string> = new Set<string>(EXECUTE_STEPS);

/* ------------------------------------------------------------------ */
/*  Property 8 — Error_Persistido satisfies structural invariants      */
/* ------------------------------------------------------------------ */

test("buildErrorPersisted preserves the structural invariants of Error_Persistido", () => {
  fc.assert(
    fc.property(
      errArb,
      stepArb,
      optionalCodeArb,
      optionalNowArb,
      (err, step, code, now) => {
        const persisted = buildErrorPersisted(err, step, code, now);

        // (a) code ∈ ERROR_CODES.
        assert.ok(
          CODE_SET.has(persisted.code),
          `code ${JSON.stringify(persisted.code)} is not in ERROR_CODES`
        );

        // (b) step ∈ EXECUTE_STEPS and equals the argument passed in.
        assert.ok(
          STEP_SET.has(persisted.step),
          `step ${JSON.stringify(persisted.step)} is not in EXECUTE_STEPS`
        );
        assert.equal(
          persisted.step,
          step,
          "persisted.step must equal the step argument"
        );

        // (c) message.length ∈ [10, 500] inclusive.
        assert.equal(
          typeof persisted.message,
          "string",
          "message must be a string"
        );
        assert.ok(
          persisted.message.length >= ERROR_MESSAGE_MIN_LENGTH,
          `message too short (${persisted.message.length} < ${ERROR_MESSAGE_MIN_LENGTH}): ${JSON.stringify(persisted.message)}`
        );
        assert.ok(
          persisted.message.length <= ERROR_MESSAGE_MAX_LENGTH,
          `message too long (${persisted.message.length} > ${ERROR_MESSAGE_MAX_LENGTH})`
        );

        // (d) timestamp ends in "Z" and is parseable as ISO 8601 UTC.
        assert.equal(
          typeof persisted.timestamp,
          "string",
          "timestamp must be a string"
        );
        assert.ok(
          persisted.timestamp.endsWith("Z"),
          `timestamp does not end in Z: ${JSON.stringify(persisted.timestamp)}`
        );
        const parsed = Date.parse(persisted.timestamp);
        assert.ok(
          Number.isFinite(parsed),
          `timestamp not parseable by Date.parse: ${JSON.stringify(persisted.timestamp)}`
        );
        assert.equal(
          parsed,
          new Date(persisted.timestamp).getTime(),
          "Date.parse(t) must equal new Date(t).getTime()"
        );
      }
    ),
    { numRuns: 100 }
  );
});
