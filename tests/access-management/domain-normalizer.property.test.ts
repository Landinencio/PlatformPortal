/**
 * Property-based tests for domain-normalizer module.
 *
 * Feature: access-management
 * Property 3: Domain normalizer produces consistent canonical form
 * Property 4: Domain fallback produces the alternate domain
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  normalizeEmail,
  emailsMatch,
  getAlternateDomainEmail,
} from "../../src/lib/access-management/domain-normalizer";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Generate a valid email local part (letters, digits, dots, hyphens, underscores) */
const localPartArb = fc
  .array(
    fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyz0123456789._-".split("")
    ),
    { minLength: 1, maxLength: 30 }
  )
  .map((chars) => chars.join(""))
  .filter((s) => !s.startsWith(".") && !s.endsWith(".") && s.length > 0);

/** Generate an email with @iskaypet.com domain */
const iskaypetEmailArb = localPartArb.map((local) => `${local}@iskaypet.com`);

/** Generate an email with @emefinpetcare.com domain */
const emefinEmailArb = localPartArb.map(
  (local) => `${local}@emefinpetcare.com`
);

/** Generate an email with either known domain */
const knownDomainEmailArb = fc.oneof(iskaypetEmailArb, emefinEmailArb);

/** Generate an email with a third-party domain (not iskaypet or emefinpetcare) */
const otherDomainArb = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), {
    minLength: 2,
    maxLength: 15,
  })
  .map((chars) => chars.join(""))
  .filter((d) => d !== "iskaypet" && d !== "emefinpetcare");

const otherDomainEmailArb = fc
  .tuple(localPartArb, otherDomainArb)
  .map(([local, domain]) => `${local}@${domain}.com`);

/** Generate any email (known or other domain) */
const anyEmailArb = fc.oneof(knownDomainEmailArb, otherDomainEmailArb);

/** Apply random case changes to a string */
const randomCaseArb = (email: string) =>
  fc
    .array(fc.boolean(), { minLength: email.length, maxLength: email.length })
    .map((flags) =>
      email
        .split("")
        .map((ch, i) => (flags[i] ? ch.toUpperCase() : ch.toLowerCase()))
        .join("")
    );

/* ------------------------------------------------------------------ */
/*  Property 3: Domain normalizer produces consistent canonical form   */
/*  **Validates: Requirements 10.1, 10.3**                             */
/* ------------------------------------------------------------------ */

test("Property 3: normalizeEmail converts @emefinpetcare.com to @iskaypet.com", () => {
  fc.assert(
    fc.property(emefinEmailArb, (email) => {
      const result = normalizeEmail(email);
      assert.ok(
        result.endsWith("@iskaypet.com"),
        `Expected @iskaypet.com domain, got: ${result}`
      );
      // Local part should be preserved (lowercased)
      const expectedLocal = email.split("@")[0].toLowerCase();
      assert.equal(result, `${expectedLocal}@iskaypet.com`);
    }),
    { numRuns: 100 }
  );
});

test("Property 3: normalizeEmail lowercases the entire email", () => {
  fc.assert(
    fc.property(anyEmailArb, (email) => {
      const result = normalizeEmail(email);
      assert.equal(result, result.toLowerCase(), `Result should be lowercase: ${result}`);
    }),
    { numRuns: 100 }
  );
});

test("Property 3: normalizeEmail is idempotent — normalize(normalize(email)) === normalize(email)", () => {
  fc.assert(
    fc.property(anyEmailArb, (email) => {
      const once = normalizeEmail(email);
      const twice = normalizeEmail(once);
      assert.equal(once, twice, `Idempotence failed: "${once}" !== "${twice}"`);
    }),
    { numRuns: 100 }
  );
});

test("Property 3: emailsMatch returns true for emails differing only in case", () => {
  fc.assert(
    fc.property(
      anyEmailArb.chain((email) =>
        randomCaseArb(email).map((cased) => [email, cased] as const)
      ),
      ([a, b]) => {
        assert.ok(
          emailsMatch(a, b),
          `Expected emailsMatch("${a}", "${b}") to be true`
        );
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 3: emailsMatch returns true for emails differing only in domain variant", () => {
  fc.assert(
    fc.property(localPartArb, (local) => {
      const iskaypet = `${local}@iskaypet.com`;
      const emefin = `${local}@emefinpetcare.com`;
      assert.ok(
        emailsMatch(iskaypet, emefin),
        `Expected emailsMatch("${iskaypet}", "${emefin}") to be true`
      );
      assert.ok(
        emailsMatch(emefin, iskaypet),
        `Expected emailsMatch("${emefin}", "${iskaypet}") to be true`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 3: emailsMatch returns true for emails differing in both case and domain variant", () => {
  fc.assert(
    fc.property(localPartArb, (local) => {
      const a = `${local.toUpperCase()}@EMEFINPETCARE.COM`;
      const b = `${local.toLowerCase()}@iskaypet.com`;
      assert.ok(
        emailsMatch(a, b),
        `Expected emailsMatch("${a}", "${b}") to be true`
      );
    }),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 4: Domain fallback produces the alternate domain          */
/*  **Validates: Requirements 6.2, 10.2**                              */
/* ------------------------------------------------------------------ */

test("Property 4: getAlternateDomainEmail for @emefinpetcare.com returns @iskaypet.com", () => {
  fc.assert(
    fc.property(emefinEmailArb, (email) => {
      const result = getAlternateDomainEmail(email);
      assert.notEqual(result, null, `Expected non-null for ${email}`);
      const expectedLocal = email.split("@")[0].toLowerCase();
      assert.equal(result, `${expectedLocal}@iskaypet.com`);
    }),
    { numRuns: 100 }
  );
});

test("Property 4: getAlternateDomainEmail for @iskaypet.com returns @emefinpetcare.com", () => {
  fc.assert(
    fc.property(iskaypetEmailArb, (email) => {
      const result = getAlternateDomainEmail(email);
      assert.notEqual(result, null, `Expected non-null for ${email}`);
      const expectedLocal = email.split("@")[0].toLowerCase();
      assert.equal(result, `${expectedLocal}@emefinpetcare.com`);
    }),
    { numRuns: 100 }
  );
});

test("Property 4: getAlternateDomainEmail for other domains returns null", () => {
  fc.assert(
    fc.property(otherDomainEmailArb, (email) => {
      const result = getAlternateDomainEmail(email);
      assert.equal(
        result,
        null,
        `Expected null for "${email}", got "${result}"`
      );
    }),
    { numRuns: 100 }
  );
});
