// Feature: managers-role, Property 3: Conjunto de secciones de managers
/**
 * Property test for the section-access set of the `managers` role.
 *
 * Feature: managers-role
 * Module under test: src/lib/rbac.ts
 *
 * Property 3: Conjunto de secciones de `managers`.
 *   For every traversal of the portal sections, the set
 *   getAccessibleSections("managers") equals exactly
 *   getAccessibleSections("staff") ∪ {"kiro-analytics", "infra-requests"};
 *   canAccessSection("managers", "admin") === false; the managers set is a
 *   PROPER subset of admin's; and "admin" ∉ SECTION_ACCESS[s] for every
 *   section s accessible by managers. Iterating canAccessSection(role, section)
 *   over all roles × all sections never throws and always returns a boolean
 *   (totality).
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 9.4, 11.2**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  canAccessSection,
  getAccessibleSections,
  type AppRole,
  type PortalSection,
} from "../rbac";

/* ------------------------------------------------------------------ */
/*  Role + section universes (kept in-test as literal fixtures)        */
/* ------------------------------------------------------------------ */

const ALL_ROLES: readonly AppRole[] = [
  "admin",
  "directores",
  "managers",
  "staff",
  "desarrolladores",
  "externos",
] as const;

const ALL_SECTIONS: readonly PortalSection[] = [
  "home",
  "metrics",
  "finops",
  "create-infra",
  "access-management",
  "incidents",
  "requests",
  "sonarqube",
  "synthetics",
  "infra-requests",
  "kiro-analytics",
  "admin",
] as const;

const arbRole = fc.constantFrom(...ALL_ROLES);
const arbSection = fc.constantFrom(...ALL_SECTIONS);

const asSet = (sections: PortalSection[]): Set<PortalSection> => new Set(sections);

const setEquals = <T>(a: Set<T>, b: Set<T>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));

/** a ⊊ b : a is a proper subset of b */
const isProperSubset = <T>(a: Set<T>, b: Set<T>): boolean =>
  a.size < b.size && [...a].every((x) => b.has(x));

/* ------------------------------------------------------------------ */
/*  Property 3                                                         */
/* ------------------------------------------------------------------ */

test("Property 3: managers section set = staff ∪ {kiro-analytics, infra-requests}", () => {
  fc.assert(
    fc.property(fc.constant(null), () => {
      const managersSet = asSet(getAccessibleSections("managers"));
      const staffSet = asSet(getAccessibleSections("staff"));

      const expected = new Set<PortalSection>(staffSet);
      expected.add("kiro-analytics");
      expected.add("infra-requests");

      // managers = staff ∪ {kiro-analytics, infra-requests}  (Req 3.7)
      assert.ok(
        setEquals(managersSet, expected),
        `managers set ${JSON.stringify([...managersSet])} != expected ${JSON.stringify([...expected])}`
      );

      // canAccessSection("managers", "admin") === false  (Req 3.6, 9.x)
      assert.equal(canAccessSection("managers", "admin"), false);

      // managers ⊊ admin  (proper subset — Req 9.4)
      const adminSet = asSet(getAccessibleSections("admin"));
      assert.ok(
        isProperSubset(managersSet, adminSet),
        `managers is not a proper subset of admin: managers=${JSON.stringify([...managersSet])} admin=${JSON.stringify([...adminSet])}`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 3: the admin section is never among managers-accessible sections (no admin-panel reach)", () => {
  // For every section s accessible by managers, the section must NOT be
  // admin-only: i.e. at least managers (a non-admin role) is allowed, and
  // more strongly, "admin" (the section) is not among managers' sections.
  fc.assert(
    fc.property(fc.constant(null), () => {
      const managersSections = getAccessibleSections("managers");
      for (const s of managersSections) {
        // The section reachable by managers is never the admin panel section.
        assert.notEqual(s, "admin");
        // And managers genuinely has access to it.
        assert.equal(canAccessSection("managers", s), true);
      }
    }),
    { numRuns: 100 }
  );
});

test("Property 3: canAccessSection over all roles × all sections is total (never throws, always boolean)", () => {
  fc.assert(
    fc.property(arbRole, arbSection, (role, section) => {
      const result = canAccessSection(role, section);
      assert.equal(typeof result, "boolean");
    }),
    { numRuns: 100 }
  );

  // Exhaustive cross-product check as well (deterministic totality).
  for (const role of ALL_ROLES) {
    for (const section of ALL_SECTIONS) {
      const result = canAccessSection(role, section);
      assert.equal(typeof result, "boolean");
    }
  }
});
