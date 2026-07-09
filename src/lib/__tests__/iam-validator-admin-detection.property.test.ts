/**
 * Property-based tests for the anti-admin Validador_IAM (detection side).
 *
 * Feature: iam-role-least-privilege
 * Property 19: toda Politica_Admin se detecta
 *
 * **Validates: Requirements 5.4, 5.5, 5.6**
 */

// Feature: iam-role-least-privilege, Property 19: toda Politica_Admin se detecta

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  validateIamPolicyAdmin,
  validateManagedPolicyArn,
} from "../iam-catalog/validator";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ALNUM_HYPHEN = ALNUM + "-";

/** A string built from a character set with the given length bounds. */
function strFromChars(chars: string, min: number, max: number) {
  return fc
    .array(fc.constantFrom(...chars.split("")), {
      minLength: min,
      maxLength: max,
    })
    .map((arr) => arr.join(""));
}

/** Randomly re-cases each character of a base word (mixed casing). */
function casings(word: string) {
  return fc
    .array(fc.boolean(), { minLength: word.length, maxLength: word.length })
    .map((flags) =>
      word
        .split("")
        .map((ch, i) => (flags[i] ? ch.toUpperCase() : ch.toLowerCase()))
        .join(""),
    );
}

/** Optional IAM path prefix such as "" or "service-role/" (ending in "/"). */
const pathPrefixArb = fc.oneof(
  fc.constant(""),
  strFromChars(ALNUM_HYPHEN, 1, 12).map((p) => p + "/"),
  fc
    .tuple(strFromChars(ALNUM_HYPHEN, 1, 8), strFromChars(ALNUM_HYPHEN, 1, 8))
    .map(([a, b]) => `${a}/${b}/`),
);

/**
 * Managed policy names whose last path segment ends in "FullAccess"
 * (arbitrary casing, arbitrary path prefix) — Requirement 5.4.
 */
const fullAccessNameArb = fc
  .tuple(pathPrefixArb, strFromChars(ALNUM, 0, 20), casings("FullAccess"))
  .map(([prefix, label, full]) => prefix + label + full);

/**
 * Managed policy names whose last path segment contains "Administrator"
 * (arbitrary casing, arbitrary path prefix, arbitrary surrounding text)
 * — Requirement 5.5.
 */
const administratorNameArb = fc
  .tuple(
    pathPrefixArb,
    strFromChars(ALNUM, 0, 12),
    casings("Administrator"),
    strFromChars(ALNUM, 0, 12),
  )
  .map(([prefix, pre, admin, post]) => prefix + pre + admin + post);

const managedAdminNameArb = fc.oneof(fullAccessNameArb, administratorNameArb);

/** Wraps a managed policy name into a syntactically valid managed policy ARN. */
const managedAdminArnArb = fc
  .tuple(
    managedAdminNameArb,
    fc.oneof(fc.constant("aws"), strFromChars("0123456789", 12, 12)),
  )
  .map(([name, acct]) => `arn:aws:iam::${acct}:policy/${name}`);

/* --- wildcard Allow on all resources: 4 string/list combinations ---- */

/** A wildcard action value: "*" or "<service>:*". */
const wildcardActionValueArb = fc.oneof(
  fc.constant("*"),
  strFromChars("abcdefghijklmnopqrstuvwxyz0123456789_-", 1, 12).map(
    (svc) => `${svc}:*`,
  ),
);

/** A concrete (non-wildcard) resource ARN used to pad Resource lists. */
const concreteArnArb = strFromChars(ALNUM, 3, 10).map(
  (r) => `arn:aws:s3:::bucket-${r.toLowerCase()}`,
);

const effectAllowArb = fc.constantFrom("Allow", "allow", "ALLOW", "AlLoW");

/**
 * Builds a JSON IAM policy document whose single Statement grants a wildcard
 * action over Resource "*", exercising the four combinations of Action and
 * Resource being a string or a list — Requirement 5.6.
 */
const wildcardDocArb = fc
  .record({
    effect: effectAllowArb,
    action: wildcardActionValueArb,
    actionAsList: fc.boolean(),
    resourceAsList: fc.boolean(),
    extraActions: fc.array(strFromChars(ALNUM, 3, 8), {
      minLength: 0,
      maxLength: 3,
    }),
    extraResources: fc.array(concreteArnArb, { minLength: 0, maxLength: 3 }),
  })
  .map(
    ({
      effect,
      action,
      actionAsList,
      resourceAsList,
      extraActions,
      extraResources,
    }) => {
      const actionField = actionAsList
        ? [action, ...extraActions.map((a) => `svc:${a}`)]
        : action;
      const resourceField = resourceAsList
        ? [...extraResources, "*"]
        : "*";
      return JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: effect,
            Action: actionField,
            Resource: resourceField,
          },
        ],
      });
    },
  );

/* ------------------------------------------------------------------ */
/*  Properties                                                         */
/* ------------------------------------------------------------------ */

test("P19: managed policy name ending in FullAccess is Politica_Admin (any casing/path)", () => {
  fc.assert(
    fc.property(fullAccessNameArb, (name) => {
      const byName = validateIamPolicyAdmin(name);
      assert.equal(byName.verdict, "Politica_Admin");
      assert.equal(byName.rule, "managed_full_access");
    }),
    { numRuns: 100 },
  );
});

test("P19: managed policy name containing Administrator is Politica_Admin (any casing/path)", () => {
  fc.assert(
    fc.property(administratorNameArb, (name) => {
      const res = validateIamPolicyAdmin(name);
      assert.equal(res.verdict, "Politica_Admin");
      // FullAccess is checked before Administrator; either admin rule is valid.
      assert.ok(
        res.rule === "managed_administrator" ||
          res.rule === "managed_full_access",
      );
    }),
    { numRuns: 100 },
  );
});

test("P19: admin managed policy ARNs are Politica_Admin via validateManagedPolicyArn", () => {
  fc.assert(
    fc.property(managedAdminArnArb, (arn) => {
      const res = validateManagedPolicyArn(arn);
      assert.equal(res.verdict, "Politica_Admin");
      assert.ok(res.rule !== undefined);
    }),
    { numRuns: 100 },
  );
});

test("P19: wildcard Allow on Resource '*' is Politica_Admin in all 4 string/list combos", () => {
  fc.assert(
    fc.property(wildcardDocArb, (doc) => {
      const res = validateIamPolicyAdmin(doc);
      assert.equal(res.verdict, "Politica_Admin");
      assert.equal(res.rule, "wildcard_action_on_all_resources");
    }),
    { numRuns: 100 },
  );
});
