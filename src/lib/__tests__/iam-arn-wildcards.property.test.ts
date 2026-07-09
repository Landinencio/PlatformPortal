/**
 * Property-based tests for wildcard handling in Scope_De_Recurso validation.
 *
 * Feature: iam-role-least-privilege
 * Property 9: comodines permitidos según el preset
 *
 * Para todo preset del Catálogo_IAM y todo ARN bien formado que contenga un
 * comodín, `validateArnForPreset` lo acepta si y sólo si el preset tiene
 * `allowWildcards === true`; en caso contrario lo rechaza con el código estable
 * `wildcard_not_allowed`.
 *
 * **Validates: Requirements 3.6**
 */

// Feature: iam-role-least-privilege, Property 9: comodines permitidos según el preset

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { validateArnForPreset, serviceArnPrefix } from "../iam-catalog/arn";
import { IAM_CATALOG } from "../iam-catalog/catalog";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** A string built from a character set with the given length bounds. */
function strFromChars(chars: string, min: number, max: number) {
  return fc
    .array(fc.constantFrom(...chars.split("")), { minLength: min, maxLength: max })
    .map((arr) => arr.join(""));
}

/** The catalog is non-empty (guarded by the startup coverage assertion). */
const presetArb = fc.constantFrom(...IAM_CATALOG);

/**
 * Builds a well-formed ARN for the preset's service that contains a `*`
 * wildcard in its resource segment. The ARN passes `validateArnFormat`
 * (12-digit account, non-empty resource) and matches the preset's service, so
 * the only remaining decision in `validateArnForPreset` is the wildcard rule.
 */
const wildcardArnForPresetArb = fc
  .tuple(presetArb, strFromChars(ALNUM, 1, 12))
  .map(([preset, resource]) => {
    const prefix = serviceArnPrefix(preset.service);
    const arn = `arn:aws:${prefix}:eu-west-1:123456789012:${resource.toLowerCase()}-*`;
    return { preset, arn };
  });

/* ------------------------------------------------------------------ */
/*  Property                                                           */
/* ------------------------------------------------------------------ */

test("P9: a well-formed wildcard ARN is accepted iff the preset allows wildcards", () => {
  fc.assert(
    fc.property(wildcardArnForPresetArb, ({ preset, arn }) => {
      const res = validateArnForPreset(arn, preset);
      if (preset.allowWildcards) {
        assert.equal(res.valid, true);
        assert.equal(res.code, undefined);
      } else {
        assert.equal(res.valid, false);
        assert.equal(res.code, "wildcard_not_allowed");
      }
    }),
    { numRuns: 100 },
  );
});
