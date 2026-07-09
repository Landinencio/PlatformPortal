/**
 * AI Portal Explorer — Route_Discovery.
 *
 * Feature: ai-portal-explorer
 *
 * Construye el Route_Inventory del portal:
 *   - Rutas de UI: espejo determinista de `NAV_ITEMS` de
 *     `src/components/portal-shell.tsx` (mapeadas a su PortalSection RBAC).
 *   - Endpoints de API: catálogo curado de `/api/*` accesibles por GET.
 *
 * Todo el inventario se deduplica por `Route.id` (hash estable de kind+path) y
 * se restringe a URLs internas al Target_Environment.
 *
 * Lógica pura y determinista (sin red): el descubrimiento dinámico de enlaces
 * internos durante una Visit (Req 4.3) se hace en runtime vía `addRouteIfAbsent`.
 *
 * _Requirements: 4.1, 4.2, 4.3, 4.4, 4.6_
 */

import { createHash } from "node:crypto";
import type { PortalSection } from "@/lib/rbac";
import { ENABLE_AUTOMATIONS, ENABLE_JIRA } from "@/lib/feature-flags";
import type { ParamSpec, Route } from "./types";

/**
 * ID estable de una Route a partir de su `kind` y `path`.
 * Independiente del orden de descubrimiento, idempotente (Req 4.4).
 */
export function buildRouteId(kind: Route["kind"], path: string): string {
  const digest = createHash("sha1").update(`${kind}:${path}`).digest("hex").slice(0, 16);
  return `${kind}-${digest}`;
}

/** Crea una Route normalizada con su id derivado de kind+path. */
function makeRoute(
  kind: Route["kind"],
  path: string,
  section: PortalSection,
  paramSpec?: ParamSpec,
): Route {
  const route: Route = { id: buildRouteId(kind, path), kind, path, section };
  if (paramSpec) route.paramSpec = paramSpec;
  return route;
}

// ─── Rutas de UI (espejo de NAV_ITEMS de portal-shell.tsx) ────────────────────

/**
 * Espejo de `NAV_ITEMS`. Solo se incluyen los items que mapean a una
 * `PortalSection` del RBAC (para que la RBAC_Expectation sea fiel) y que no
 * estén ocultos por feature flag.
 *
 * Items sin PortalSection dedicada (p.ej. `/create-repo`, `/tickets`) no se
 * incluyen en el espejo estático: el portal no los gobierna por sección RBAC y
 * el Crawler los descubre por enlaces durante una Visit (Req 4.3). Los items
 * `jira`/`automations` están ocultos por flag (ENABLE_JIRA/ENABLE_AUTOMATIONS).
 */
interface NavRouteSpec {
  navId: string;
  path: string;
  section: PortalSection;
  hidden: boolean;
  paramSpec?: ParamSpec;
}

const NAV_ROUTE_SPECS: NavRouteSpec[] = [
  { navId: "home", path: "/", section: "home", hidden: false },
  {
    navId: "access-management",
    path: "/access-management",
    section: "access-management",
    hidden: false,
  },
  // nav id "infra-requests" → href /create-infra (sección create-infra).
  { navId: "create-infra", path: "/create-infra", section: "create-infra", hidden: false },
  { navId: "incidents", path: "/incidents", section: "incidents", hidden: false },
  { navId: "requests", path: "/requests", section: "requests", hidden: false },
  {
    navId: "metrics",
    path: "/metrics",
    section: "metrics",
    hidden: false,
    paramSpec: { dateRange: true, filters: [{ key: "team", safeValues: ["digital", "retail"] }] },
  },
  { navId: "synthetics", path: "/synthetics", section: "synthetics", hidden: false },
  // hidden por ENABLE_JIRA (y sin PortalSection dedicada): no se incluye.
  { navId: "jira", path: "/jira", section: "metrics", hidden: !ENABLE_JIRA },
  { navId: "finops", path: "/finops", section: "finops", hidden: false, paramSpec: { dateRange: true } },
  {
    navId: "kiro-analytics",
    path: "/kiro-analytics",
    section: "kiro-analytics",
    hidden: false,
    paramSpec: { dateRange: true },
  },
  // hidden por ENABLE_AUTOMATIONS (y sin PortalSection dedicada): no se incluye.
  { navId: "automations", path: "/automations", section: "admin", hidden: !ENABLE_AUTOMATIONS },
  // nav id "notifications" → href /infra-requests (sección infra-requests).
  { navId: "infra-requests", path: "/infra-requests", section: "infra-requests", hidden: false },
  { navId: "admin", path: "/admin", section: "admin", hidden: false },
];

/** Rutas de UI base derivadas de NAV_ITEMS (espejo del array de portal-shell.tsx). (Req 4.1) */
export function discoverNavRoutes(): Route[] {
  return NAV_ROUTE_SPECS.filter((spec) => !spec.hidden).map((spec) =>
    makeRoute("ui", spec.path, spec.section, spec.paramSpec),
  );
}

// ─── Endpoints de API (catálogo curado /api/* GET) ────────────────────────────

interface ApiRouteSpec {
  path: string;
  section: PortalSection;
  paramSpec?: ParamSpec;
}

const DATE_RANGE: ParamSpec = { dateRange: true };

/**
 * Catálogo curado de endpoints `/api/*` accesibles por GET, mapeados a la
 * PortalSection que los gobierna (coherente con SECTION_ACCESS y middleware).
 * Representativo, no exhaustivo: cubre las secciones principales del portal.
 */
const API_ROUTE_SPECS: ApiRouteSpec[] = [
  // Salud (público).
  { path: "/api/health", section: "home" },
  // Notificaciones del usuario (sesión).
  { path: "/api/notifications", section: "home" },
  { path: "/api/notifications/count", section: "home" },
  // Métricas / DORA (admiten rango de fechas).
  { path: "/api/metrics/dora-core", section: "metrics", paramSpec: DATE_RANGE },
  { path: "/api/metrics/team-activity", section: "metrics", paramSpec: DATE_RANGE },
  { path: "/api/metrics/deployment-frequency", section: "metrics", paramSpec: DATE_RANGE },
  { path: "/api/metrics/lead-time", section: "metrics", paramSpec: DATE_RANGE },
  { path: "/api/metrics/executive-summary", section: "metrics", paramSpec: DATE_RANGE },
  { path: "/api/metrics/manager-dashboard", section: "metrics", paramSpec: DATE_RANGE },
  { path: "/api/metrics/teams", section: "metrics" },
  { path: "/api/metrics/projects", section: "metrics" },
  // SonarQube.
  { path: "/api/sonarqube/dashboard", section: "sonarqube" },
  { path: "/api/sonarqube/projects", section: "sonarqube" },
  // FinOps.
  { path: "/api/finops/accounts", section: "finops" },
  { path: "/api/finops/k8s-allocation", section: "finops" },
  { path: "/api/finops/ai-cost/history", section: "finops", paramSpec: DATE_RANGE },
  // Inventario (pestaña dentro de FinOps).
  { path: "/api/inventory/athena", section: "finops" },
  // Synthetics (endpoints de lectura accesibles a externos).
  { path: "/api/synthetics/monitors", section: "synthetics" },
  { path: "/api/synthetics/stats", section: "synthetics" },
  { path: "/api/synthetics/lighthouse", section: "synthetics" },
  { path: "/api/synthetics/external-status", section: "synthetics" },
  // Kiro Analytics (directores+).
  { path: "/api/kiro-analytics/overview", section: "kiro-analytics" },
  { path: "/api/kiro-analytics/users", section: "kiro-analytics" },
  // Access management.
  { path: "/api/access-management/groups", section: "access-management" },
  { path: "/api/access-management/portal-role", section: "access-management" },
  // Solicitudes de infra (aprobar).
  { path: "/api/infra-requests", section: "infra-requests" },
  // Admin analytics.
  { path: "/api/admin/analytics/overview", section: "admin" },
  // AWS Health (admin-only).
  { path: "/api/aws-health/news", section: "admin" },
];

/** Endpoints /api/* conocidos accesibles por GET (catálogo curado + validación). (Req 4.2) */
export function discoverApiRoutes(): Route[] {
  return API_ROUTE_SPECS.map((spec) => makeRoute("api", spec.path, spec.section, spec.paramSpec));
}

// ─── Dedupe e inventario ──────────────────────────────────────────────────────

/**
 * Añade una Route destino al inventario si no está presente (dedupe por id).
 * No muta el array de entrada; devuelve el mismo array si ya existía. (Req 4.3, 4.4)
 */
export function addRouteIfAbsent(inventory: Route[], candidate: Route): Route[] {
  if (inventory.some((route) => route.id === candidate.id)) {
    return inventory;
  }
  return [...inventory, candidate];
}

/** True si la URL pertenece al dominio del Target_Environment. (Req 4.6) */
export function isInternalUrl(url: string, baseUrl: string): boolean {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return false;
  }

  let target: URL;
  try {
    // Resuelve rutas relativas contra la base; absolutas se parsean tal cual.
    target = new URL(url, base);
  } catch {
    return false;
  }

  // Solo navegable por HTTP(S): excluye mailto:, javascript:, tel:, etc.
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return false;
  }

  return target.host.toLowerCase() === base.host.toLowerCase();
}

/**
 * Inventario completo: NAV_ITEMS + /api/* GET, deduplicado por id y restringido
 * a URLs internas al Target_Environment. (Req 4.1, 4.2, 4.4, 4.6)
 *
 * Async para encajar con el pipeline del orquestador (descubrimiento futuro).
 */
export async function buildRouteInventory(baseUrl: string): Promise<Route[]> {
  const candidates: Route[] = [...discoverNavRoutes(), ...discoverApiRoutes()];

  let inventory: Route[] = [];
  for (const candidate of candidates) {
    // Las rutas curadas son relativas (internas); validamos por robustez.
    if (!isInternalUrl(candidate.path, baseUrl)) continue;
    inventory = addRouteIfAbsent(inventory, candidate);
  }

  return inventory;
}
