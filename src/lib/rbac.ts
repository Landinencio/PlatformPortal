/**
 * Portal RBAC — Role-Based Access Control
 *
 * Roles (from Azure AD Enterprise App "PlatformPortal"):
 *   - Admin: acceso total incluyendo panel de administración
 *   - Directores: todo excepto admin panel. Puede aprobar solicitudes.
 *   - Staff: infra, accesos, métricas, FinOps, monitorización. Sin aprobación ni admin.
 *   - Desarrolladores: métricas DORA, FinOps, incidencias, peticiones, SonarQube, monitorización.
 *   - Externos: métricas DORA, incidencias, peticiones, SonarQube, monitorización. Sin FinOps.
 */

export type AppRole = "admin" | "directores" | "managers" | "staff" | "desarrolladores" | "externos";

/** Role hierarchy — higher number = more access */
const ROLE_PRIORITY: Record<AppRole, number> = {
    externos: 1,
    desarrolladores: 2,
    staff: 3,
    managers: 4,
    directores: 5,
    admin: 6,
};

/** Map Azure AD role values (and legacy aliases) to our AppRole type */
const ROLE_ALIASES: Record<string, AppRole> = {
    // New roles
    admin: "admin",
    directores: "directores",
    managers: "managers",
    staff: "staff",
    desarrolladores: "desarrolladores",
    externos: "externos",
    // Legacy aliases (backward compat with old role assignments)
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

const normalizeRoleName = (role: string): string => role.trim().toLowerCase();

export function normalizeAzureRoles(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return input
        .filter((value): value is string => typeof value === "string")
        .map((role) => role.trim())
        .filter(Boolean);
}

export function resolveAppRole(rawRoles: string[]): AppRole {
    const mapped = rawRoles
        .map((role) => ROLE_ALIASES[normalizeRoleName(role)])
        .filter((role): role is AppRole => Boolean(role));

    // Return the highest-priority role found
    if (mapped.length === 0) return "externos";

    return mapped.reduce((highest, current) =>
        ROLE_PRIORITY[current] > ROLE_PRIORITY[highest] ? current : highest
    );
}

export function hasMinimumRole(role: AppRole, minimum: AppRole): boolean {
    const rolePriority = ROLE_PRIORITY[role] ?? 0;
    const minPriority = ROLE_PRIORITY[minimum] ?? 0;
    return rolePriority >= minPriority;
}

export function roleFromTokenData(data: { appRole?: unknown; roles?: unknown }): AppRole {
    if (typeof data.appRole === "string") {
        const normalized = normalizeRoleName(data.appRole);
        const mapped = ROLE_ALIASES[normalized];
        if (mapped) return mapped;
    }

    return resolveAppRole(normalizeAzureRoles(data.roles));
}

// ─── Section-level access control ────────────────────────────────────────────

export type PortalSection =
    | "home"
    | "metrics"
    | "finops"
    | "create-infra"
    | "access-management"
    | "incidents"
    | "requests"
    | "sonarqube"
    | "synthetics"
    | "infra-requests"  // solicitudes (aprobar)
    | "kiro-analytics"
    | "admin";

/** Which roles can access each section */
const SECTION_ACCESS: Record<PortalSection, AppRole[]> = {
    home: ["admin", "directores", "managers", "staff", "desarrolladores", "externos"],
    metrics: ["admin", "directores", "managers", "staff", "desarrolladores", "externos"],
    finops: ["admin", "directores", "managers", "staff", "desarrolladores"],
    "create-infra": ["admin", "directores", "managers", "staff"],
    "access-management": ["admin", "directores", "managers", "staff"],
    incidents: ["admin", "directores", "managers", "staff", "desarrolladores", "externos"],
    requests: ["admin", "directores", "managers", "staff", "desarrolladores", "externos"],
    sonarqube: ["admin", "directores", "managers", "staff", "desarrolladores", "externos"],
    synthetics: ["admin", "directores", "managers", "staff", "desarrolladores", "externos"],
    "infra-requests": ["admin", "directores", "managers"],
    "kiro-analytics": ["admin", "directores", "managers"],
    admin: ["admin"],
};

/** Check if a role can access a specific portal section */
export function canAccessSection(role: AppRole, section: PortalSection): boolean {
    const allowed = SECTION_ACCESS[section];
    return allowed ? allowed.includes(role) : false;
}

/** Get all sections accessible by a role */
export function getAccessibleSections(role: AppRole): PortalSection[] {
    return (Object.keys(SECTION_ACCESS) as PortalSection[]).filter(
        (section) => SECTION_ACCESS[section].includes(role)
    );
}
