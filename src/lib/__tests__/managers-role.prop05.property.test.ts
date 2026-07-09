// Feature: managers-role, Property 5: Compatibilidad hacia atrás de roles preexistentes
/**
 * Property test for backward compatibility of the pre-existing roles after
 * introducing the `managers` role.
 *
 * Module under test: src/lib/rbac.ts
 *
 * Property 5: Compatibilidad hacia atrás de roles preexistentes
 *   ∀ r ∈ {externos, desarrolladores, staff, directores, admin}:
 *     getAccessibleSections(r) (as a set) === frozen prior baseline.
 *   ∀ array of strings that (after normalizing) does NOT contain `managers`:
 *     resolveAppRole(x) === prior baseline resolution (incl. legacy aliases
 *     editor, viewer, write, contributor, administrator, owner, superadmin,
 *     read, readonly, read-only).
 *
 * The baselines below are frozen literally in this test to reflect the
 * pre-managers state (see design.md "Data Models" table).
 *
 * **Validates: Requirements 10.1, 10.2, 10.3**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  resolveAppRole,
  getAccessibleSections,
  type AppRole,
  type PortalSection,
} from "../rbac";

/* ------------------------------------------------------------------ */
/*  Frozen baseline #1 — role → set of accessible sections            */
/*  (pre-managers state, from design.md "Data Models")                */
/* ------------------------------------------------------------------ */

const BASELINE_SECTIONS: Record<
  "externos" | "desarrolladores" | "staff" | "directores" | "admin",
  readonly PortalSection[]
> = {
  // externos: home, metrics, incidents, requests, sonarqube, synthetics
  externos: ["home", "metrics", "incidents", "requests", "sonarqube", "synthetics"],
  // desarrolladores: externos + finops
  desarrolladores: [
    "home",
    "metrics",
    "finops",
    "incidents",
    "requests",
    "sonarqube",
    "synthetics",
  ],
  // staff: + create-infra, access-management
  staff: [
    "home",
    "metrics",
    "finops",
    "create-infra",
    "access-management",
    "incidents",
    "requests",
    "sonarqube",
    "synthetics",
  ],
  // directores: all except admin
  directores: [
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
  ],
  // admin: everything
  admin: [
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
  ],
};

const PREEXISTING_ROLES = Object.keys(BASELINE_SECTIONS) as Array<
  keyof typeof BASELINE_SECTIONS
>;

/** Order-independent set equality over PortalSection lists. */
const asSet = (sections: readonly PortalSection[]): Set<PortalSection> =>
  new Set(sections);

const setsEqual = (
  a: readonly PortalSection[],
  b: readonly PortalSection[]
): boolean => {
  const sa = asSet(a);
  const sb = asSet(b);
  if (sa.size !== sb.size) return false;
  for (const s of sa) if (!sb.has(s)) return false;
  return true;
};

/* ------------------------------------------------------------------ */
/*  Frozen baseline #2 — raw input → resolved AppRole                 */
/*  (pre-managers resolution, incl. legacy aliases)                   */
/* ------------------------------------------------------------------ */

const BASELINE_RESOLUTION: Record<string, AppRole> = {
  // Canonical role names
  admin: "admin",
  directores: "directores",
  staff: "staff",
  desarrolladores: "desarrolladores",
  externos: "externos",
  // Legacy aliases (must remain intact — Req 10.2)
  editor: "staff",
  viewer: "externos",
  write: "staff",
  contributor: "staff",
  administrator: "admin",
  owner: "admin",
  superadmin: "admin",
  read: "externos",
  readonly: "externos",
  "read-only": "externos",
};

const KNOWN_INPUTS = Object.keys(BASELINE_RESOLUTION);

/* ------------------------------------------------------------------ */
/*  Part A — accessible sections of pre-existing roles == baseline    */
/* ------------------------------------------------------------------ */

test("Property 5: getAccessibleSections of pre-existing roles equals frozen baseline", () => {
  for (const role of PREEXISTING_ROLES) {
    const actual = getAccessibleSections(role);
    const expected = BASELINE_SECTIONS[role];
    assert.ok(
      setsEqual(actual, expected),
      `role "${role}": expected sections {${[...expected].sort().join(", ")}} ` +
        `but got {${[...actual].sort().join(", ")}}`
    );
  }
});

/* ------------------------------------------------------------------ */
/*  Part B — resolveAppRole unchanged for inputs without `managers`   */
/* ------------------------------------------------------------------ */

// Arbitrary that produces raw role strings drawn from known baseline inputs
// (in arbitrary capitalization / padding) plus unrecognized garbage, but
// NEVER the value `managers`.
const arbNonManagerToken: fc.Arbitrary<string> = fc.oneof(
  // known inputs, possibly re-cased / padded (resolveAppRole normalizes)
  fc
    .constantFrom(...KNOWN_INPUTS)
    .chain((base) =>
      fc.tuple(fc.constantFrom("", " ", "  "), fc.boolean()).map(([pad, upper]) => {
        const cased = upper ? base.toUpperCase() : base;
        return `${pad}${cased}${pad}`;
      })
    ),
  // arbitrary garbage that never normalizes to `managers`
  fc.string().filter((s) => s.trim().toLowerCase() !== "managers")
);

const arbNonManagerArray: fc.Arbitrary<string[]> = fc
  .array(arbNonManagerToken, { maxLength: 8 })
  .filter((arr) => !arr.some((s) => s.trim().toLowerCase() === "managers"));

test("Property 5: resolveAppRole matches prior baseline for arrays without `managers`", () => {
  fc.assert(
    fc.property(arbNonManagerArray, (rawRoles) => {
      // Reference resolution using the frozen baseline map + prior priority.
      // Prior priority order (pre-managers): externos<desarrolladores<staff<directores<admin
      const PRIOR_PRIORITY: Record<AppRole, number> = {
        externos: 1,
        desarrolladores: 2,
        staff: 3,
        managers: 0, // never selected — `managers` cannot appear in these inputs
        directores: 4,
        admin: 5,
      };

      const mapped = rawRoles
        .map((r) => BASELINE_RESOLUTION[r.trim().toLowerCase()])
        .filter((r): r is AppRole => Boolean(r));

      const expected: AppRole =
        mapped.length === 0
          ? "externos"
          : mapped.reduce((hi, cur) =>
              PRIOR_PRIORITY[cur] > PRIOR_PRIORITY[hi] ? cur : hi
            );

      assert.equal(resolveAppRole(rawRoles), expected);
    }),
    { numRuns: 100 }
  );
});

test("Property 5: every known legacy alias resolves to its baseline AppRole", () => {
  // Explicit, exhaustive check of the frozen resolution baseline.
  for (const [input, expected] of Object.entries(BASELINE_RESOLUTION)) {
    assert.equal(
      resolveAppRole([input]),
      expected,
      `input "${input}" should resolve to "${expected}"`
    );
    // Capitalization must not change resolution (normalized to lowercase).
    assert.equal(resolveAppRole([input.toUpperCase()]), expected);
  }
});
