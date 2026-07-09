// Feature: managers-role, Property 4: Equivalencia por construcción en Kiro Analytics
/**
 * Property test for the equivalence-by-construction of the two access models
 * (per-section `canAccessSection` vs per-minimum-role `hasMinimumRole`) over the
 * Kiro Analytics section.
 *
 * Feature: managers-role
 * Module under test: src/lib/rbac.ts
 *
 * Property 4 (Equivalencia por construcción en Kiro Analytics):
 *   ∀ AppRole r:
 *     canAccessSection(r, "kiro-analytics") === hasMinimumRole(r, "managers")
 *   and the set of roles satisfying either predicate is exactly
 *   {managers, directores, admin}, which coincides with SECTION_ACCESS["kiro-analytics"].
 *   There is NO deny-on-discrepancy semantics nor an OR between the two models: the
 *   equality holds purely because of the chosen configuration values.
 *
 *   SECTION_ACCESS is not exported, so the "authorised set" is derived from the
 *   public API (canAccessSection) by iterating over the whole AppRole universe.
 *
 * **Validates: Requirements 4.5, 11.3, 11.4**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { canAccessSection, hasMinimumRole, type AppRole } from "../rbac";

/** The complete AppRole universe (mirror of the AppRole union in rbac.ts). */
const ALL_ROLES: readonly AppRole[] = [
  "admin",
  "directores",
  "managers",
  "staff",
  "desarrolladores",
  "externos",
] as const;

/** Expected authorised set for Kiro Analytics. */
const EXPECTED_KIRO_ANALYTICS_ROLES: ReadonlySet<AppRole> = new Set([
  "managers",
  "directores",
  "admin",
]);

const arbAppRole = fc.constantFrom(...ALL_ROLES);

test("Property 4: canAccessSection(r, kiro-analytics) === hasMinimumRole(r, managers) for every role", () => {
  fc.assert(
    fc.property(arbAppRole, (role) => {
      const bySection = canAccessSection(role, "kiro-analytics");
      const byMinimum = hasMinimumRole(role, "managers");

      // Both models are pure/total booleans and must be IDENTICAL (no OR, no
      // deny-on-discrepancy): equivalence by construction.
      assert.equal(typeof bySection, "boolean");
      assert.equal(typeof byMinimum, "boolean");
      assert.equal(
        bySection,
        byMinimum,
        `Model divergence for role="${role}": canAccessSection=${bySection} vs hasMinimumRole(managers)=${byMinimum}`
      );

      // And the value must agree with the expected authorised set.
      assert.equal(bySection, EXPECTED_KIRO_ANALYTICS_ROLES.has(role));
    }),
    { numRuns: 100 }
  );
});

test("Property 4: the set of roles satisfying either model is exactly {managers, directores, admin}", () => {
  // Derive the authorised set from the public API (SECTION_ACCESS is not exported).
  const authorisedBySection = ALL_ROLES.filter((r) =>
    canAccessSection(r, "kiro-analytics")
  );
  const authorisedByMinimum = ALL_ROLES.filter((r) =>
    hasMinimumRole(r, "managers")
  );

  const expected = [...EXPECTED_KIRO_ANALYTICS_ROLES].sort();

  assert.deepEqual([...authorisedBySection].sort(), expected);
  assert.deepEqual([...authorisedByMinimum].sort(), expected);

  // The two derived sets coincide element-by-element (equivalence by construction).
  assert.deepEqual(
    [...authorisedBySection].sort(),
    [...authorisedByMinimum].sort()
  );

  // Explicit membership assertions matching SECTION_ACCESS["kiro-analytics"].
  for (const role of ["managers", "directores", "admin"] as const) {
    assert.equal(canAccessSection(role, "kiro-analytics"), true);
    assert.equal(hasMinimumRole(role, "managers"), true);
  }
  for (const role of ["staff", "desarrolladores", "externos"] as const) {
    assert.equal(canAccessSection(role, "kiro-analytics"), false);
    assert.equal(hasMinimumRole(role, "managers"), false);
  }
});
