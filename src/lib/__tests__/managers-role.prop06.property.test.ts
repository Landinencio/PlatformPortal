// Feature: managers-role, Property 6: Fuente única de verdad de roles
/**
 * Property test for the single source of truth of RBAC roles after introducing
 * the `managers` role.
 *
 * Module under test: src/lib/rbac.ts (+ src/lib/explorer/__tests__/arbitraries.ts)
 *
 * Property 6: Fuente única de verdad de roles
 *   ∀ member of AppRole and ∀ element of ALL_APP_ROLES:
 *     the set of values of ALL_APP_ROLES is exactly equal to the set of members
 *     of AppRole (same cardinality, no duplicates, no extras, none missing).
 *   Consequently `managers` is present as key/value in ROLE_PRIORITY,
 *   ROLE_ALIASES and in at least one SECTION_ACCESS list.
 *
 * Because ROLE_PRIORITY / ROLE_ALIASES / SECTION_ACCESS are NOT exported from
 * rbac.ts, `managers` coverage of each structure is derived from the public API:
 *   - ROLE_PRIORITY   ← `hasMinimumRole` (managers has a distinct priority slot
 *                        strictly between staff and directores).
 *   - ROLE_ALIASES    ← `resolveAppRole(["managers"]) === "managers"`.
 *   - SECTION_ACCESS  ← `getAccessibleSections("managers")` / `canAccessSection`.
 *
 * The canonical 6-role expectation is frozen literally in this test.
 *
 * **Validates: Requirements 7.1, 7.4, 11.5**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  resolveAppRole,
  hasMinimumRole,
  canAccessSection,
  getAccessibleSections,
  type AppRole,
} from "../rbac";
import { ALL_APP_ROLES } from "../explorer/__tests__/arbitraries";

/* ------------------------------------------------------------------ */
/*  Canonical, literal expectation — the 6 AppRole members            */
/* ------------------------------------------------------------------ */

// The literal list of the 6 expected roles fixed in this test.
const EXPECTED_ROLES = [
  "admin",
  "directores",
  "managers",
  "staff",
  "desarrolladores",
  "externos",
] as const satisfies readonly AppRole[];

// Compile-time exhaustiveness guard: `Record<AppRole, true>` forces every
// member of the AppRole union to appear here. If a role is ever added to /
// removed from AppRole without updating this test, compilation fails. The
// runtime keys give us a concrete, type-derived enumeration of the members.
const APP_ROLE_PRESENCE: Record<AppRole, true> = {
  admin: true,
  directores: true,
  managers: true,
  staff: true,
  desarrolladores: true,
  externos: true,
};
const APP_ROLE_MEMBERS = Object.keys(APP_ROLE_PRESENCE) as AppRole[];

/** Order-independent set equality over string lists. */
const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
};

/* ------------------------------------------------------------------ */
/*  Part A — the literal expectation matches the AppRole type members */
/* ------------------------------------------------------------------ */

test("Property 6: the frozen 6-role literal equals the AppRole type members", () => {
  assert.equal(EXPECTED_ROLES.length, 6);
  assert.equal(
    new Set(EXPECTED_ROLES).size,
    EXPECTED_ROLES.length,
    "the frozen literal must not contain duplicates"
  );
  assert.ok(
    sameSet(EXPECTED_ROLES, APP_ROLE_MEMBERS),
    `frozen literal {${[...EXPECTED_ROLES].sort().join(", ")}} must equal ` +
      `AppRole members {${[...APP_ROLE_MEMBERS].sort().join(", ")}}`
  );
});

/* ------------------------------------------------------------------ */
/*  Part B — ALL_APP_ROLES is exactly the set of AppRole members      */
/* ------------------------------------------------------------------ */

test("Property 6: ALL_APP_ROLES has no duplicates", () => {
  assert.equal(
    new Set(ALL_APP_ROLES).size,
    ALL_APP_ROLES.length,
    `ALL_APP_ROLES contains duplicates: [${ALL_APP_ROLES.join(", ")}]`
  );
});

test("Property 6: ALL_APP_ROLES set equals the frozen 6-role literal (no extras/missing)", () => {
  assert.equal(
    ALL_APP_ROLES.length,
    EXPECTED_ROLES.length,
    `ALL_APP_ROLES cardinality ${ALL_APP_ROLES.length} != expected ${EXPECTED_ROLES.length}; ` +
      `got [${[...ALL_APP_ROLES].sort().join(", ")}]`
  );
  // Nothing missing (every expected role present in ALL_APP_ROLES).
  const missing = EXPECTED_ROLES.filter((r) => !ALL_APP_ROLES.includes(r));
  assert.deepEqual(missing, [], `ALL_APP_ROLES is missing roles: [${missing.join(", ")}]`);
  // No extras (every element of ALL_APP_ROLES is an expected role).
  const extras = ALL_APP_ROLES.filter((r) => !EXPECTED_ROLES.includes(r as AppRole));
  assert.deepEqual(extras, [], `ALL_APP_ROLES has unexpected roles: [${extras.join(", ")}]`);
  assert.ok(sameSet(ALL_APP_ROLES, EXPECTED_ROLES));
});

/* ------------------------------------------------------------------ */
/*  Part C — bijection ALL_APP_ROLES ↔ AppRole members (fast-check)   */
/* ------------------------------------------------------------------ */

test("Property 6: bijection between ALL_APP_ROLES and AppRole members", () => {
  const memberSet = new Set<string>(APP_ROLE_MEMBERS);
  const fixtureSet = new Set<string>(ALL_APP_ROLES);

  fc.assert(
    fc.property(fc.constantFrom(...ALL_APP_ROLES), (role) => {
      // Every element of ALL_APP_ROLES is a member of AppRole.
      assert.ok(memberSet.has(role), `fixture role "${role}" is not an AppRole member`);
    }),
    { numRuns: 100 }
  );

  fc.assert(
    fc.property(fc.constantFrom(...APP_ROLE_MEMBERS), (role) => {
      // Every member of AppRole appears in ALL_APP_ROLES.
      assert.ok(fixtureSet.has(role), `AppRole member "${role}" is missing from ALL_APP_ROLES`);
    }),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Part D — `managers` present in ROLE_PRIORITY / ROLE_ALIASES /     */
/*           SECTION_ACCESS (derived from the public API)             */
/* ------------------------------------------------------------------ */

test("Property 6: `managers` is present in ROLE_PRIORITY (distinct hierarchy slot)", () => {
  // Reflexivity: a role with a defined priority is >= itself.
  assert.equal(hasMinimumRole("managers", "managers"), true);
  // Ordered strictly between staff and directores → managers has its own slot.
  assert.equal(hasMinimumRole("managers", "staff"), true);
  assert.equal(hasMinimumRole("managers", "directores"), false);
  assert.equal(hasMinimumRole("directores", "managers"), true);
  assert.equal(hasMinimumRole("staff", "managers"), false);
});

test("Property 6: `managers` is present in ROLE_ALIASES (resolves to itself)", () => {
  assert.equal(resolveAppRole(["managers"]), "managers");
  // Case-insensitive normalization still maps to managers.
  assert.equal(resolveAppRole(["Managers"]), "managers");
});

test("Property 6: `managers` is present in at least one SECTION_ACCESS list", () => {
  const sections = getAccessibleSections("managers");
  assert.ok(sections.length > 0, "managers must be granted at least one section");
  // kiro-analytics is the emblematic section rebajada a managers.
  assert.equal(canAccessSection("managers", "kiro-analytics"), true);
});
