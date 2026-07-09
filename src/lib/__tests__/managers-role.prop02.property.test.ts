// Feature: managers-role, Property 2: Monotonía de la jerarquía
/**
 * Property test for the linear role hierarchy exposed by hasMinimumRole.
 *
 * Module under test: src/lib/rbac.ts
 *
 * Property 2: Monotonía de la jerarquía
 *   ∀ (a, b): hasMinimumRole(a, b) === (index(a) >= index(b)) over the exact
 *   order externos < desarrolladores < staff < managers < directores < admin.
 *   Includes reflexivity (hasMinimumRole(r, r) === true) and the concrete
 *   cases of Req 1.5–1.8 (managers≥staff, ¬(managers≥directores),
 *   directores≥managers, admin≥managers, ¬(staff≥managers), …) plus the
 *   preservation of the relative order of the pre-existing roles.
 *
 * **Validates: Requirements 1.2, 1.5, 1.6, 1.7, 1.8, 10.4, 10.5**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { hasMinimumRole, type AppRole } from "../rbac";

/* ------------------------------------------------------------------ */
/*  Canonical hierarchy order (lowest → highest access)               */
/* ------------------------------------------------------------------ */

const ORDER: readonly AppRole[] = [
  "externos",
  "desarrolladores",
  "staff",
  "managers",
  "directores",
  "admin",
] as const;

const indexOf = (role: AppRole): number => ORDER.indexOf(role);

const arbRole: fc.Arbitrary<AppRole> = fc.constantFrom(...ORDER);

/* ------------------------------------------------------------------ */
/*  Property: monotonicity of the hierarchy                           */
/* ------------------------------------------------------------------ */

test("Property 2: hasMinimumRole(a, b) iff index(a) >= index(b)", () => {
  fc.assert(
    fc.property(arbRole, arbRole, (a, b) => {
      assert.equal(hasMinimumRole(a, b), indexOf(a) >= indexOf(b));
    }),
    { numRuns: 100 }
  );
});

test("Property 2: reflexivity — hasMinimumRole(r, r) is always true", () => {
  fc.assert(
    fc.property(arbRole, (r) => {
      assert.equal(hasMinimumRole(r, r), true);
    }),
    { numRuns: 100 }
  );
});

test("Property 2: relative order of pre-existing roles preserved (baseline)", () => {
  // Baseline order before introducing `managers`, frozen literally.
  const PREEXISTING: readonly AppRole[] = [
    "externos",
    "desarrolladores",
    "staff",
    "directores",
    "admin",
  ] as const;

  fc.assert(
    fc.property(
      fc.constantFrom(...PREEXISTING),
      fc.constantFrom(...PREEXISTING),
      (a, b) => {
        const expected = PREEXISTING.indexOf(a) >= PREEXISTING.indexOf(b);
        assert.equal(hasMinimumRole(a, b), expected);
      }
    ),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Concrete cases from Req 1.5–1.8                                    */
/* ------------------------------------------------------------------ */

test("Property 2: concrete cases (Req 1.5–1.8)", () => {
  // Req 1.5 — managers ≥ staff
  assert.equal(hasMinimumRole("managers", "staff"), true);
  // Req 1.6 — ¬(managers ≥ directores)
  assert.equal(hasMinimumRole("managers", "directores"), false);
  // Req 1.7 — directores ≥ managers and admin ≥ managers
  assert.equal(hasMinimumRole("directores", "managers"), true);
  assert.equal(hasMinimumRole("admin", "managers"), true);
  // Req 1.8 — ¬(staff ≥ managers), ¬(desarrolladores ≥ managers), ¬(externos ≥ managers)
  assert.equal(hasMinimumRole("staff", "managers"), false);
  assert.equal(hasMinimumRole("desarrolladores", "managers"), false);
  assert.equal(hasMinimumRole("externos", "managers"), false);

  // Req 1.2 — the exact priority ordering externos<desarrolladores<staff<managers<directores<admin
  for (let i = 0; i < ORDER.length - 1; i++) {
    const lower = ORDER[i];
    const higher = ORDER[i + 1];
    assert.equal(hasMinimumRole(higher, lower), true);
    assert.equal(hasMinimumRole(lower, higher), false);
  }
});
