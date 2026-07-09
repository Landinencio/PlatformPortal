/**
 * AI Portal Explorer — RBAC_Validator.
 *
 * Feature: ai-portal-explorer
 *
 * Deriva la matriz de acceso esperada (RBAC_Expectation) por Role y sección a
 * partir de `SECTION_ACCESS`/`canAccessSection` de `src/lib/rbac.ts`, y compara
 * el acceso observado durante una Visit con el esperado para producir un
 * `RbacFinding` cuando difieren.
 *
 * Toda la lógica es pura y determinista (testeable por property-based testing).
 *
 * _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
 */

import type { AppRole, PortalSection } from "@/lib/rbac";
import { canAccessSection } from "@/lib/rbac";
import type { Route, Severity } from "./types";

/** Acceso a una sección: concedido o denegado. */
export type AccessOutcome = "granted" | "denied";

/**
 * Inventario completo de secciones del portal. Se declara como `Record` para
 * que TypeScript fuerce exhaustividad: si `PortalSection` gana o pierde un
 * miembro, este mapa deja de compilar y obliga a actualizarlo. Esto mantiene
 * la RBAC_Expectation alineada con `rbac.ts` sin listas manuales divergentes.
 */
const ALL_SECTIONS_MAP: Record<PortalSection, true> = {
  home: true,
  metrics: true,
  finops: true,
  "create-infra": true,
  "access-management": true,
  incidents: true,
  requests: true,
  sonarqube: true,
  synthetics: true,
  "infra-requests": true,
  "kiro-analytics": true,
  admin: true,
};

/** Todas las secciones del portal, derivadas del tipo `PortalSection`. */
export const ALL_SECTIONS = Object.keys(ALL_SECTIONS_MAP) as PortalSection[];

/** Expectativa de acceso de un Role a una sección concreta. */
export interface RbacExpectation {
  section: PortalSection;
  role: AppRole;
  expected: AccessOutcome;
}

/**
 * Expectativa de acceso para un (role, section) concreto, derivada de
 * `canAccessSection` de `rbac.ts`. (Req 3.1)
 */
export function expectedAccess(role: AppRole, section: PortalSection): AccessOutcome {
  return canAccessSection(role, section) ? "granted" : "denied";
}

/**
 * Deriva la matriz esperada de acceso (RBAC_Expectation) por Role y sección a
 * partir de `SECTION_ACCESS` de `rbac.ts`, para el conjunto de Roles dado.
 * Producto cartesiano roles × secciones, determinista. (Req 3.1)
 */
export function deriveRbacExpectations(roles: AppRole[]): RbacExpectation[] {
  const expectations: RbacExpectation[] = [];
  for (const role of roles) {
    for (const section of ALL_SECTIONS) {
      expectations.push({ section, role, expected: expectedAccess(role, section) });
    }
  }
  return expectations;
}

/** Discrepancia RBAC entre el acceso observado y el esperado. */
export interface RbacFinding {
  route: Route;
  role: AppRole;
  observed: AccessOutcome;
  expected: AccessOutcome;
  /**
   * `unauthorized-access`: el Role accedió a algo que debería estar denegado.
   * `wrongly-blocked`: el Role fue bloqueado en algo que debería ver.
   */
  kind: "unauthorized-access" | "wrongly-blocked";
  /** Severity mínima del finding. `high` para acceso no autorizado. (Req 3.3) */
  minSeverity: Severity;
}

/**
 * Compara el acceso observado de un Role en una Route con su RBAC_Expectation
 * (derivada de la sección de la Route) y produce un `RbacFinding` si y solo si
 * el acceso observado difiere del esperado. (Req 3.2, 3.3, 3.4, 3.5, 3.6)
 *
 * - acceso concedido donde se esperaba denegación → `unauthorized-access`,
 *   `minSeverity: "high"` (Req 3.3).
 * - acceso denegado donde se esperaba concesión → `wrongly-blocked`,
 *   `minSeverity: "medium"` (Req 3.4).
 *
 * El finding incluye Route, Role, acceso observado y acceso esperado (Req 3.5).
 */
export function evaluateRbac(
  route: Route,
  role: AppRole,
  observed: AccessOutcome,
): RbacFinding | null {
  const expected = expectedAccess(role, route.section);

  // Sin discrepancia → no hay finding.
  if (observed === expected) return null;

  if (observed === "granted") {
    // Esperábamos denegación pero se concedió: fuga de acceso.
    return {
      route,
      role,
      observed,
      expected,
      kind: "unauthorized-access",
      minSeverity: "high",
    };
  }

  // observed === "denied" && expected === "granted": bloqueo indebido.
  return {
    route,
    role,
    observed,
    expected,
    kind: "wrongly-blocked",
    minSeverity: "medium",
  };
}
