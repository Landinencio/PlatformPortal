/**
 * Property-based test for RDS data-plane action detection.
 *
 * Feature: iam-role-least-privilege, Property 23: detección total de acciones del plano de datos RDS
 *
 * `isRdsDataPlaneAction` is a total function (never throws) over any input and
 * returns true for the three RDS data-plane action families in any casing:
 *   - `rds-db:*`     (IAM DB authentication)
 *   - `rds-data:*`   (RDS Data API)
 *   - `rds:Connect*` (IAM connect to a DB proxy / cluster)
 *
 * **Validates: Requirements 6.8**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

// Available from `../iam-catalog/action-levels` and re-exported by
// `../iam-catalog/validator`. We import from the validator surface to also
// exercise the re-export used by the modification flow (Requirement 6.8).
import { isRdsDataPlaneAction } from "../iam-catalog/validator";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

const suffixChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789*".split(
  ""
);

/** Random action-name suffix (may be empty), e.g. the part after the prefix. */
const suffixArb = fc
  .array(fc.constantFrom(...suffixChars), { minLength: 0, maxLength: 30 })
  .map((arr) => arr.join(""));

/**
 * Randomly re-cases a string, char by char, so we cover mixed/upper/lower
 * casings of the fixed prefixes.
 */
function reCase(s: string): fc.Arbitrary<string> {
  return fc
    .array(fc.boolean(), { minLength: s.length, maxLength: s.length })
    .map((flags) =>
      s
        .split("")
        .map((ch, i) => (flags[i] ? ch.toUpperCase() : ch.toLowerCase()))
        .join("")
    );
}

/** `rds-db:*` actions in various casings. */
const rdsDbActionArb = fc
  .tuple(reCase("rds-db:"), suffixArb)
  .map(([prefix, suffix]) => prefix + suffix);

/** `rds-data:*` actions in various casings. */
const rdsDataActionArb = fc
  .tuple(reCase("rds-data:"), suffixArb)
  .map(([prefix, suffix]) => prefix + suffix);

/** `rds:Connect*` actions in various casings. */
const rdsConnectActionArb = fc
  .tuple(reCase("rds:connect"), suffixArb)
  .map(([prefix, suffix]) => prefix + suffix);

/** Any RDS data-plane action (union of the three families). */
const rdsDataPlaneActionArb = fc.oneof(
  rdsDbActionArb,
  rdsDataActionArb,
  rdsConnectActionArb
);

/** Arbitrary strings (including empty, whitespace, ARNs, non-RDS actions). */
const arbitraryStringArb = fc.oneof(
  fc.string(),
  fc.constantFrom(
    "",
    "   ",
    "s3:GetObject",
    "rds:DescribeDBInstances",
    "rds:CreateDBInstance",
    "rdsx:Connect",
    "notrds-db:foo",
    "arn:aws:rds:eu-west-1:123456789012:db:mydb",
    "arn:aws:rds-db:eu-west-1:123456789012:dbuser:*/appuser",
    "dynamodb:GetItem"
  ),
  fc.webUrl(),
  // Full ARNs constructed with random pieces.
  fc
    .tuple(
      fc.constantFrom("rds", "rds-db", "s3", "sqs", "dynamodb"),
      suffixArb
    )
    .map(([svc, rest]) => `arn:aws:${svc}:eu-west-1:123456789012:${rest}`)
);

/* ------------------------------------------------------------------ */
/*  Property 23: detección total de acciones del plano de datos RDS    */
/*  **Validates: Requirements 6.8**                                    */
/* ------------------------------------------------------------------ */

test("Property 23: isRdsDataPlaneAction is total (never throws) for arbitrary input", () => {
  fc.assert(
    fc.property(arbitraryStringArb, (input) => {
      // Must never throw and must return a boolean.
      const result = isRdsDataPlaneAction(input);
      assert.equal(
        typeof result,
        "boolean",
        `Expected a boolean for input "${input}", got ${typeof result}`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 23: isRdsDataPlaneAction is total for non-string values", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.integer(),
        fc.double(),
        fc.boolean(),
        fc.constant(null),
        fc.constant(undefined),
        fc.object(),
        fc.array(fc.string())
      ),
      (value) => {
        // The helper guards against non-string values and must never throw.
        const result = isRdsDataPlaneAction(value as unknown as string);
        assert.equal(result, false, `Non-string input should be false: ${String(value)}`);
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 23: isRdsDataPlaneAction returns true for rds-db:* actions (any casing)", () => {
  fc.assert(
    fc.property(rdsDbActionArb, (action) => {
      assert.equal(
        isRdsDataPlaneAction(action),
        true,
        `rds-db:* action should be detected: "${action}"`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 23: isRdsDataPlaneAction returns true for rds-data:* actions (any casing)", () => {
  fc.assert(
    fc.property(rdsDataActionArb, (action) => {
      assert.equal(
        isRdsDataPlaneAction(action),
        true,
        `rds-data:* action should be detected: "${action}"`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 23: isRdsDataPlaneAction returns true for rds:Connect* actions (any casing)", () => {
  fc.assert(
    fc.property(rdsConnectActionArb, (action) => {
      assert.equal(
        isRdsDataPlaneAction(action),
        true,
        `rds:Connect* action should be detected: "${action}"`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 23: any RDS data-plane action is detected", () => {
  fc.assert(
    fc.property(rdsDataPlaneActionArb, (action) => {
      assert.equal(
        isRdsDataPlaneAction(action),
        true,
        `RDS data-plane action should be detected: "${action}"`
      );
    }),
    { numRuns: 100 }
  );
});
