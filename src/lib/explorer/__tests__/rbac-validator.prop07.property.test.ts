// Feature: ai-portal-explorer, Property 7: Un RBAC_Finding existe si y solo si el acceso observado difiere del esperado
/**
 * Property-based test for the RBAC_Validator.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/rbac-validator.ts
 *
 * Property 7: Un RBAC_Finding existe si y solo si el acceso observado difiere
 * del esperado.
 *   - PARA TODA Route, Role y acceso observado, `evaluateRbac` devuelve un
 *     RBAC_Finding (no-null) SI Y SOLO SI el acceso observado difiere de la
 *     RBAC_Expectation `expectedAccess(role, route.section)`. (Req 3.2)
 *   - Cuando hay finding, incluye Route, Role, acceso observado y esperado.
 *     (Req 3.5)
 *   - observado `granted` con esperado `denied` → `unauthorized-access` con
 *     `minSeverity: "high"`. (Req 3.3)
 *   - observado `denied` con esperado `granted` → `wrongly-blocked`. (Req 3.4)
 *   - todo RBAC_Finding es tratable como Anomaly (estructura completa). (Req 3.6)
 *
 * **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/rbac-validator.prop07.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { evaluateRbac, expectedAccess } from "../rbac-validator";
import type { AccessOutcome } from "../rbac-validator";
import type { PortalSection } from "@/lib/rbac";
import type { Route } from "../types";
import { arbAppRole } from "./arbitraries";

/* ------------------------------------------------------------------ */
/*  Arbitraries                                                        */
/* ------------------------------------------------------------------ */

/** Todas las secciones del portal (espejo de PortalSection en rbac.ts). */
const SECTIONS: readonly PortalSection[] = [
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

/** Una Route arbitraria con una sección válida (el campo que usa evaluateRbac). */
const arbRoute: fc.Arbitrary<Route> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  kind: fc.constantFrom<"ui" | "api">("ui", "api"),
  path: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `/${s}`),
  section: fc.constantFrom(...SECTIONS),
}) as fc.Arbitrary<Route>;

/** Acceso observado durante una Visit: concedido o denegado. */
const arbObserved: fc.Arbitrary<AccessOutcome> = fc.constantFrom<AccessOutcome>(
  "granted",
  "denied",
);

/* ------------------------------------------------------------------ */
/*  Property 7                                                         */
/* ------------------------------------------------------------------ */

test("Property 7: RBAC_Finding exists iff observed access differs from expected", () => {
  fc.assert(
    fc.property(arbRoute, arbAppRole, arbObserved, (route, role, observed) => {
      const expected = expectedAccess(role, route.section);
      const finding = evaluateRbac(route, role, observed);

      if (observed === expected) {
        // Sin discrepancia → NO hay finding. (Req 3.2)
        assert.equal(finding, null);
        return;
      }

      // Discrepancia → SÍ hay finding bien formado. (Req 3.2, 3.5)
      assert.notEqual(finding, null);
      assert.equal(finding!.route, route);
      assert.equal(finding!.role, role);
      assert.equal(finding!.observed, observed);
      assert.equal(finding!.expected, expected);
      // observado y esperado SIEMPRE difieren cuando hay finding.
      assert.notEqual(finding!.observed, finding!.expected);

      if (observed === "granted") {
        // Acceso concedido donde se esperaba denegación → fuga de acceso. (Req 3.3)
        assert.equal(expected, "denied");
        assert.equal(finding!.kind, "unauthorized-access");
        assert.equal(finding!.minSeverity, "high");
      } else {
        // Acceso denegado donde se esperaba concesión → bloqueo indebido. (Req 3.4)
        assert.equal(observed, "denied");
        assert.equal(expected, "granted");
        assert.equal(finding!.kind, "wrongly-blocked");
      }
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Directed examples                                                  */
/* ------------------------------------------------------------------ */

test("Property 7 (example): externos accessing admin is an unauthorized-access finding", () => {
  const route: Route = { id: "admin-ui", kind: "ui", path: "/admin", section: "admin" };
  // externos NO debe acceder a admin: esperado "denied".
  assert.equal(expectedAccess("externos", "admin"), "denied");

  // Observamos acceso concedido (fuga) → finding high.
  const leak = evaluateRbac(route, "externos", "granted");
  assert.notEqual(leak, null);
  assert.equal(leak!.kind, "unauthorized-access");
  assert.equal(leak!.minSeverity, "high");
  assert.equal(leak!.observed, "granted");
  assert.equal(leak!.expected, "denied");

  // Observamos denegación (correcto) → sin finding.
  assert.equal(evaluateRbac(route, "externos", "denied"), null);
});

test("Property 7 (example): admin wrongly blocked is a wrongly-blocked finding", () => {
  const route: Route = { id: "metrics-ui", kind: "ui", path: "/metrics", section: "metrics" };
  // admin debe acceder a metrics: esperado "granted".
  assert.equal(expectedAccess("admin", "metrics"), "granted");

  // Observamos denegación indebida → finding wrongly-blocked.
  const blocked = evaluateRbac(route, "admin", "denied");
  assert.notEqual(blocked, null);
  assert.equal(blocked!.kind, "wrongly-blocked");
  assert.equal(blocked!.observed, "denied");
  assert.equal(blocked!.expected, "granted");

  // Observamos concesión (correcto) → sin finding.
  assert.equal(evaluateRbac(route, "admin", "granted"), null);
});
