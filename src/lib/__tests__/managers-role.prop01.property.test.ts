// Feature: managers-role, Property 1: Totalidad de resolveAppRole
/**
 * Property test for the totality of `resolveAppRole`.
 *
 * Feature: managers-role
 * Module under test: src/lib/rbac.ts
 *
 * Property 1: Totalidad de resolveAppRole
 *   ∀ array de cadenas arbitrario (vacíos, basura, mayúsculas, espacios,
 *   valores no reconocidos): `resolveAppRole(x)` nunca lanza y devuelve uno de
 *   los 6 AppRole válidos; y ∀ array que contenga `managers` (en cualquier
 *   capitalización) sin alias de prioridad estrictamente superior ⇒ el
 *   resultado es "managers".
 *
 * **Validates: Requirements 1.4, 11.1**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { resolveAppRole, hasMinimumRole } from "../rbac";
import type { AppRole } from "../rbac";

/** The six valid AppRole members — mirror of the `AppRole` union. */
const VALID_APP_ROLES: readonly AppRole[] = [
  "admin",
  "directores",
  "managers",
  "staff",
  "desarrolladores",
  "externos",
] as const;

const VALID_SET = new Set<string>(VALID_APP_ROLES);

/**
 * Arbitrary that produces raw role strings mixing:
 *  - fully arbitrary garbage (fc.string)
 *  - recognized role/alias values in random capitalization + padding
 * so the generator explores both unrecognized noise and valid inputs.
 */
const RECOGNIZED_VALUES = [
  "admin",
  "directores",
  "managers",
  "staff",
  "desarrolladores",
  "externos",
  // legacy aliases
  "editor",
  "viewer",
  "write",
  "contributor",
  "administrator",
  "owner",
  "superadmin",
  "read",
  "readonly",
  "read-only",
] as const;

/** Randomly re-case and pad a string to exercise trim().toLowerCase() normalization. */
function messify(value: string): fc.Arbitrary<string> {
  return fc.tuple(fc.boolean(), fc.constantFrom("", " ", "  ", "\t")).map(([upper, pad]) => {
    const cased = upper ? value.toUpperCase() : value;
    return `${pad}${cased}${pad}`;
  });
}

const rawRoleArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.constantFrom(...RECOGNIZED_VALUES).chain(messify)
);

test("Property 1: resolveAppRole is total — never throws and always returns a valid AppRole", () => {
  fc.assert(
    fc.property(fc.array(rawRoleArb), (roles) => {
      const result = resolveAppRole(roles);
      assert.ok(
        VALID_SET.has(result),
        `resolveAppRole returned an invalid role: ${JSON.stringify(result)}`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 1: array containing `managers` without a strictly higher-priority alias resolves to `managers`", () => {
  // Roles that outrank `managers` (directores, admin) and their legacy aliases.
  const HIGHER_PRIORITY_VALUES = [
    "directores",
    "admin",
    "administrator",
    "owner",
    "superadmin",
  ] as const;

  // Any capitalization of the literal `managers`.
  const managersCasings: fc.Arbitrary<string> = fc
    .tuple(fc.constantFrom("managers", "MANAGERS", "Managers", "mAnAgErS"), fc.constantFrom("", " ", "\t"))
    .map(([word, pad]) => `${pad}${word}${pad}`);

  fc.assert(
    fc.property(
      fc.array(rawRoleArb),
      managersCasings,
      (noise, managersValue) => {
        // Keep only noise entries that do NOT map to a role of priority
        // strictly higher than `managers` (i.e., drop directores/admin aliases).
        const safeNoise = noise.filter((r) => {
          const mapped = resolveAppRole([r]);
          // A single-entry resolution that yields a role outranking managers
          // means this entry could push the result above managers.
          return !hasMinimumRole(mapped, "directores");
        });
        // Extra guard: also exclude the explicit higher-priority literals.
        const filtered = safeNoise.filter(
          (r) => !HIGHER_PRIORITY_VALUES.includes(r.trim().toLowerCase() as (typeof HIGHER_PRIORITY_VALUES)[number])
        );

        const input = [...filtered, managersValue];
        assert.equal(resolveAppRole(input), "managers");
      }
    ),
    { numRuns: 100 }
  );
});
