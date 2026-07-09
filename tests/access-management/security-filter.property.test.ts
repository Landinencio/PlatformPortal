/**
 * Property-based tests for security-filter module.
 *
 * Feature: access-management
 * Property 1: Platform prefix filter returns only matching groups
 * Property 2: Security filter excludes all privileged groups
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  filterGroups,
  isGroupSafe,
  PLATFORM_PREFIXES,
} from "../../src/lib/access-management/security-filter";
import type { GraphGroup } from "../../src/lib/graph-client";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Generate a safe display name (no "admin" or "owner" substring) */
const safeNameArb = fc
  .array(
    fc.constantFrom(
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_ ".split(
        ""
      )
    ),
    { minLength: 1, maxLength: 30 }
  )
  .map((chars) => chars.join(""))
  .filter((name) => {
    const lower = name.toLowerCase();
    return !lower.includes("admin") && !lower.includes("owner");
  });

/** Generate a forbidden substring with random casing */
const forbiddenSubstringArb = fc
  .constantFrom("admin", "owner")
  .chain((word) =>
    fc
      .array(fc.boolean(), { minLength: word.length, maxLength: word.length })
      .map((flags) =>
        word
          .split("")
          .map((ch, i) => (flags[i] ? ch.toUpperCase() : ch.toLowerCase()))
          .join("")
      )
  );

/** Generate a display name that contains a forbidden substring */
const unsafeNameArb = fc
  .tuple(
    safeNameArb,
    forbiddenSubstringArb,
    safeNameArb
  )
  .map(([prefix, forbidden, suffix]) => `${prefix}${forbidden}${suffix}`);

/** Generate a GraphGroup object */
const graphGroupArb = (nameArb: fc.Arbitrary<string>): fc.Arbitrary<GraphGroup> =>
  fc
    .tuple(fc.uuid(), nameArb)
    .map(([id, displayName]) => ({ id, displayName }));

/** Generate a list of GraphGroup objects with mixed safe/unsafe names */
const mixedGroupListArb = fc.array(
  fc.oneof(graphGroupArb(safeNameArb), graphGroupArb(unsafeNameArb)),
  { minLength: 0, maxLength: 30 }
);

/** Generate a platform key that has a prefix mapping */
const azurePlatformArb = fc.constantFrom(
  ...Object.keys(PLATFORM_PREFIXES)
) as fc.Arbitrary<string>;

/** Generate a group whose displayName starts with a given prefix and is safe */
const prefixedSafeGroupArb = (prefix: string): fc.Arbitrary<GraphGroup> =>
  safeNameArb.map((suffix) => ({
    id: fc.sample(fc.uuid(), 1)[0],
    displayName: `${prefix}${suffix}`,
  }));

/** Generate a group whose displayName does NOT start with a given prefix */
const nonPrefixedGroupArb = (prefix: string): fc.Arbitrary<GraphGroup> =>
  safeNameArb
    .filter((name) => !name.startsWith(prefix))
    .map((name) => ({
      id: fc.sample(fc.uuid(), 1)[0],
      displayName: name,
    }));

/* ------------------------------------------------------------------ */
/*  Property 1: Platform prefix filter returns only matching groups    */
/*  **Validates: Requirements 2.1, 2.2, 2.3**                         */
/* ------------------------------------------------------------------ */

test("Property 1: filterGroups returns only groups with the correct platform prefix", () => {
  fc.assert(
    fc.property(azurePlatformArb, mixedGroupListArb, (platform, groups) => {
      const prefix = PLATFORM_PREFIXES[platform];
      const result = filterGroups(groups, platform);

      // Every returned group must start with the platform prefix
      for (const g of result) {
        assert.ok(
          g.displayName.startsWith(prefix),
          `Group "${g.displayName}" does not start with prefix "${prefix}"`
        );
      }
    }),
    { numRuns: 100 }
  );
});

test("Property 1: filterGroups does not omit any safe group that matches the prefix", () => {
  fc.assert(
    fc.property(azurePlatformArb, mixedGroupListArb, (platform, groups) => {
      const prefix = PLATFORM_PREFIXES[platform];
      const result = filterGroups(groups, platform);
      const resultIds = new Set(result.map((g) => g.id));

      // Every group that starts with the prefix AND is safe must be in the result
      for (const g of groups) {
        if (g.displayName.startsWith(prefix) && isGroupSafe(g.displayName)) {
          assert.ok(
            resultIds.has(g.id),
            `Safe prefixed group "${g.displayName}" (id=${g.id}) was omitted`
          );
        }
      }
    }),
    { numRuns: 100 }
  );
});

test("Property 1: filterGroups excludes all groups without the platform prefix", () => {
  fc.assert(
    fc.property(
      azurePlatformArb,
      fc.array(
        fc.oneof(
          // Mix of prefixed and non-prefixed groups
          azurePlatformArb.chain((p) => prefixedSafeGroupArb(PLATFORM_PREFIXES[p])),
          azurePlatformArb.chain((p) => nonPrefixedGroupArb(PLATFORM_PREFIXES[p]))
        ),
        { minLength: 1, maxLength: 20 }
      ),
      (platform, groups) => {
        const prefix = PLATFORM_PREFIXES[platform];
        const result = filterGroups(groups, platform);

        for (const g of result) {
          assert.ok(
            g.displayName.startsWith(prefix),
            `Non-prefixed group "${g.displayName}" should not appear in results for platform "${platform}"`
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 1: for GitLab (no prefix), filterGroups returns all safe groups", () => {
  fc.assert(
    fc.property(mixedGroupListArb, (groups) => {
      const result = filterGroups(groups, "gitlab");
      const resultIds = new Set(result.map((g) => g.id));

      // Every safe group should be included
      for (const g of groups) {
        if (isGroupSafe(g.displayName)) {
          assert.ok(
            resultIds.has(g.id),
            `Safe group "${g.displayName}" was omitted for GitLab`
          );
        }
      }

      // No unsafe group should be included
      for (const g of result) {
        assert.ok(
          isGroupSafe(g.displayName),
          `Unsafe group "${g.displayName}" was included for GitLab`
        );
      }
    }),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 2: Security filter excludes all privileged groups         */
/*  **Validates: Requirements 2.4, 2.6**                               */
/* ------------------------------------------------------------------ */

test("Property 2: isGroupSafe returns false for any name containing 'admin' (case-insensitive)", () => {
  fc.assert(
    fc.property(unsafeNameArb, (name) => {
      // unsafeNameArb always contains "admin" or "owner"
      const lower = name.toLowerCase();
      if (lower.includes("admin") || lower.includes("owner")) {
        assert.equal(
          isGroupSafe(name),
          false,
          `isGroupSafe("${name}") should be false`
        );
      }
    }),
    { numRuns: 100 }
  );
});

test("Property 2: isGroupSafe returns true for any name without 'admin' or 'owner'", () => {
  fc.assert(
    fc.property(safeNameArb, (name) => {
      assert.equal(
        isGroupSafe(name),
        true,
        `isGroupSafe("${name}") should be true`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 2: filterGroups never returns a group containing 'admin' or 'owner'", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("aws", "argocd", "sonarqube", "gitlab"),
      mixedGroupListArb,
      (platform, groups) => {
        const result = filterGroups(groups, platform);

        for (const g of result) {
          const lower = g.displayName.toLowerCase();
          assert.ok(
            !lower.includes("admin"),
            `Filtered result contains "admin": "${g.displayName}"`
          );
          assert.ok(
            !lower.includes("owner"),
            `Filtered result contains "owner": "${g.displayName}"`
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 2: filterGroups includes every safe group that passes prefix check", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("aws", "argocd", "sonarqube", "gitlab"),
      mixedGroupListArb,
      (platform, groups) => {
        const prefix = PLATFORM_PREFIXES[platform];
        const result = filterGroups(groups, platform);
        const resultIds = new Set(result.map((g) => g.id));

        for (const g of groups) {
          const passesPrefix = prefix
            ? g.displayName.startsWith(prefix)
            : true;
          const isSafe = isGroupSafe(g.displayName);

          if (passesPrefix && isSafe) {
            assert.ok(
              resultIds.has(g.id),
              `Group "${g.displayName}" should be in results for platform "${platform}"`
            );
          }
        }
      }
    ),
    { numRuns: 100 }
  );
});
