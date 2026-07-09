// Feature: managers-role, Property 7: No escalada de privilegios
/**
 * Property test for the "no privilege escalation" guarantee of the `managers`
 * role.
 *
 * Feature: managers-role
 * Module under test: src/lib/rbac.ts
 *
 * Property 7: No escalada de privilegios.
 *   canAccessSection("managers", "admin") === false; and for every
 *   minimum-role threshold m ∈ {directores, admin},
 *   hasMinimumRole("managers", m) === false (managers passes no `directores+`
 *   minimum-role gate). The only section whose gate is lowered to `managers`
 *   is `kiro-analytics`: among the sections managers can access, the ones NOT
 *   accessible to `staff` are exactly {kiro-analytics, infra-requests}, and
 *   `infra-requests` is granted by the section model (SECTION_ACCESS /
 *   canAccessSection), not by a `directores+` minimum-role gate.
 *
 * **Validates: Requirements 9.1, 9.2**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  canAccessSection,
  getAccessibleSections,
  hasMinimumRole,
  type AppRole,
  type PortalSection,
} from "../rbac";

/* ------------------------------------------------------------------ */
/*  Role universe (mirror of AppRole, kept in-test as literal fixture) */
/* ------------------------------------------------------------------ */

const ALL_ROLES: readonly AppRole[] = [
  "admin",
  "directores",
  "managers",
  "staff",
  "desarrolladores",
  "externos",
] as const;

/** Minimum-role thresholds strictly above `managers` (i.e. `directores+`). */
const ABOVE_MANAGERS: readonly AppRole[] = ["directores", "admin"] as const;

const arbRole = fc.constantFrom(...ALL_ROLES);
const arbAboveManagers = fc.constantFrom(...ABOVE_MANAGERS);

const setEquals = <T>(a: Set<T>, b: Set<T>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));

/* ------------------------------------------------------------------ */
/*  Property 7 — no privilege escalation                              */
/* ------------------------------------------------------------------ */

test("Property 7: managers never reaches the admin section", () => {
  fc.assert(
    fc.property(fc.constant(null), () => {
      // Req 9.1 — managers is denied the admin section.
      assert.equal(canAccessSection("managers", "admin"), false);
    }),
    { numRuns: 100 }
  );
});

test("Property 7: managers passes no directores+ minimum-role gate", () => {
  // Req 9.2 — for every threshold m ∈ {directores, admin},
  // hasMinimumRole("managers", m) === false.
  fc.assert(
    fc.property(arbAboveManagers, (m) => {
      assert.equal(hasMinimumRole("managers", m), false);
    }),
    { numRuns: 100 }
  );

  // Deterministic exhaustive check as well.
  for (const m of ABOVE_MANAGERS) {
    assert.equal(hasMinimumRole("managers", m), false);
  }
});

test("Property 7: the only sections managers gains over staff are {kiro-analytics, infra-requests}", () => {
  fc.assert(
    fc.property(fc.constant(null), () => {
      const managersSections = getAccessibleSections("managers");
      const staffSet = new Set<PortalSection>(getAccessibleSections("staff"));

      // Sections managers can access that staff cannot.
      const gainedOverStaff = new Set<PortalSection>(
        managersSections.filter((s) => !staffSet.has(s))
      );

      const expected = new Set<PortalSection>([
        "kiro-analytics",
        "infra-requests",
      ]);

      assert.ok(
        setEquals(gainedOverStaff, expected),
        `managers gains ${JSON.stringify([...gainedOverStaff])} over staff, expected ${JSON.stringify([...expected])}`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 7: kiro-analytics is the section whose gate is lowered to `managers` (min-role equivalence)", () => {
  // The gate lowered to `managers` is expressed by the by-section model being
  // identical to the by-minimum-role model at threshold `managers`.
  fc.assert(
    fc.property(arbRole, (r) => {
      assert.equal(
        canAccessSection(r, "kiro-analytics"),
        hasMinimumRole(r, "managers")
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 7: infra-requests is granted by the section model, not by a directores+ gate", () => {
  // managers reaches the approvals mailbox purely via the by-section model…
  assert.equal(canAccessSection("managers", "infra-requests"), true);

  // …even though managers does NOT satisfy a `directores` minimum-role gate.
  // If the mailbox were governed by a `directores+` minimum-role gate,
  // managers would be denied — so the grant cannot come from such a gate.
  assert.equal(hasMinimumRole("managers", "directores"), false);
});
