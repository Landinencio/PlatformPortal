import { Session } from "next-auth";
import { AppRole, hasMinimumRole, resolveAppRole, normalizeAzureRoles } from "@/lib/rbac";

export { hasMinimumRole };

export function getSessionRole(session: Session | null): AppRole {
    if (!session?.user) return "externos";
    if (session.user.appRole) {
        // Normalize: Azure AD may return capitalized values like "Admin", "Directores"
        const normalized = (session.user.appRole as string).toLowerCase() as AppRole;
        return normalized;
    }
    return resolveAppRole(normalizeAzureRoles(session.user.roles));
}

export function hasSessionMinimumRole(session: Session | null, minimumRole: AppRole): boolean {
    return hasMinimumRole(getSessionRole(session), minimumRole);
}
