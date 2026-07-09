// Feature: ai-portal-explorer, Property 6: La RBAC_Expectation refleja SECTION_ACCESS
/**
 * Property-based test for the RBAC_Validator expectation derivation.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/rbac-validator.ts
 *
 * Property 6: La RBAC_Expectation refleja SECTION_ACCESS.
 *   Para toda combinación (Role, sección), `expectedAccess(role, section)`
 *   devuelve `"granted"` SI Y SOLO SI `canAccessSection(role, section)` de
 *   `src/lib/rbac.ts` es verdadero (y `"denied"` en caso contrario). Es decir,
 *   la expectativa de acceso del Explorer es un espejo fiel de la matriz
 *   `SECTION_ACCESS` canónica del portal, sin listas paralelas que puedan
 *   divergir. Además, `deriveRbacExpectations(roles)` produce exactamente una
 *   `RbacExpectation` por cada combinación Role×sección, y cada una es coherente
 *   con `expectedAccess` (y por tanto con `canAccessSection`).
 *
 * **Validates: Requirements 3.1**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/rbac-validator.prop06.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import type { PortalSection } from "@/lib/rbac";
import { canAccessSection } from "@/lib/rbac";
import {
  ALL_SECTIONS,
  expectedAccess,
  deriveRbacExpectations,
} from "../rbac-validator";
import { arbAppRole, ALL_APP_ROLES } from "./arbitraries";

/* ------------------------------------------------------------------ */
/*  Arbitraries                                                        */
/* ------------------------------------------------------------------ */

/** Una sección cualquiera del portal (espejo de PortalSection). */
const arbSection: fc.Arbitrary<PortalSection> = fc.constantFrom(...ALL_SECTIONS);

/**
 * Un subconjunto arbitrario (sin repetidos) de roles. `deriveRbacExpectations`
 * hace un producto cartesiano directo sobre el array de entrada, así que la
 * unicidad de las expectativas por (role, section) solo es significativa cuando
 * los roles de entrada son únicos.
 */
const arbRoles = fc.uniqueArray(arbAppRole, { maxLength: ALL_APP_ROLES.length });

/* ------------------------------------------------------------------ */
/*  Property 6                                                         */
/* ------------------------------------------------------------------ */

test("Property 6: expectedAccess mirrors canAccessSection for every role×section", () => {
  fc.assert(
    fc.property(arbAppRole, arbSection, (role, section) => {
      const expected = canAccessSection(role, section) ? "granted" : "denied";
      assert.equal(
        expectedAccess(role, section),
        expected,
        `expectedAccess(${role}, ${section}) debe reflejar canAccessSection`,
      );
    }),
    { numRuns: 100 },
  );
});

test("Property 6: deriveRbacExpectations yields one consistent expectation per role×section", () => {
  fc.assert(
    fc.property(arbRoles, (roles) => {
      const expectations = deriveRbacExpectations(roles);

      // Una expectativa por cada combinación role×section (producto cartesiano).
      assert.equal(
        expectations.length,
        roles.length * ALL_SECTIONS.length,
        "cardinalidad = roles × secciones",
      );

      // Cada expectativa es coherente con canAccessSection y bien formada.
      for (const exp of expectations) {
        assert.ok(ALL_APP_ROLES.includes(exp.role), `role válido: ${exp.role}`);
        assert.ok(ALL_SECTIONS.includes(exp.section), `sección válida: ${exp.section}`);
        const oracle = canAccessSection(exp.role, exp.section) ? "granted" : "denied";
        assert.equal(
          exp.expected,
          oracle,
          `expectativa para (${exp.role}, ${exp.section}) debe reflejar SECTION_ACCESS`,
        );
        assert.equal(
          exp.expected,
          expectedAccess(exp.role, exp.section),
          "deriveRbacExpectations debe coincidir con expectedAccess",
        );
      }

      // Para cada role pedido y cada sección, existe exactamente una expectativa.
      for (const role of roles) {
        for (const section of ALL_SECTIONS) {
          const matches = expectations.filter(
            (e) => e.role === role && e.section === section,
          );
          assert.equal(
            matches.length,
            1,
            `exactamente una expectativa para (${role}, ${section})`,
          );
        }
      }
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Directed examples                                                  */
/* ------------------------------------------------------------------ */

test("Property 6 (example): known SECTION_ACCESS rows", () => {
  // admin ve todo, incluido el panel admin.
  assert.equal(expectedAccess("admin", "admin"), "granted");
  // externos no tiene FinOps.
  assert.equal(expectedAccess("externos", "finops"), "denied");
  // desarrolladores sí tiene FinOps.
  assert.equal(expectedAccess("desarrolladores", "finops"), "granted");
  // solo admin/directores ven infra-requests y kiro-analytics.
  assert.equal(expectedAccess("staff", "infra-requests"), "denied");
  assert.equal(expectedAccess("directores", "kiro-analytics"), "granted");
  assert.equal(expectedAccess("staff", "kiro-analytics"), "denied");
  // home es para todos.
  for (const role of ALL_APP_ROLES) {
    assert.equal(expectedAccess(role, "home"), "granted");
  }
});

test("Property 6 (example): empty roles list yields no expectations", () => {
  assert.deepEqual(deriveRbacExpectations([]), []);
});
