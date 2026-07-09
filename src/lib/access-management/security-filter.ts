/**
 * Security filter for access-management group listings.
 *
 * Filters groups by platform prefix (for Azure AD platforms) and excludes
 * groups whose displayName contains privileged substrings ("admin", "owner").
 */

import type { GraphGroup } from "@/lib/graph-client";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Platform prefix mapping for Azure AD group naming conventions */
export const PLATFORM_PREFIXES: Record<string, string> = {
  aws: "AWS_",
  argocd: "argocd_",
  sonarqube: "sonarqube_",
};

/** Forbidden substrings (matched case-insensitively) */
const FORBIDDEN_PATTERNS = ["admin", "owner"];

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Check if a group display name is safe (does not contain admin/owner).
 *
 * The check is case-insensitive: "Admin", "ADMIN", "owner", "OWNER" etc.
 * are all considered unsafe.
 */
export function isGroupSafe(displayName: string): boolean {
  const lower = displayName.toLowerCase();
  return !FORBIDDEN_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Filter groups by platform prefix and exclude admin/owner groups.
 *
 * For Azure AD platforms (aws, argocd, sonarqube):
 *   1. Keep only groups whose displayName starts with the platform prefix
 *   2. Exclude groups containing "admin" or "owner" (case-insensitive)
 *
 * For GitLab (or any platform without a prefix mapping):
 *   1. Only exclude groups containing "admin" or "owner" (case-insensitive)
 */
export function filterGroups(
  groups: GraphGroup[],
  platform: string,
): GraphGroup[] {
  const prefix = PLATFORM_PREFIXES[platform];

  if (prefix) {
    // Azure AD platform: filter by prefix AND security
    return groups.filter(
      (g) => g.displayName.startsWith(prefix) && isGroupSafe(g.displayName),
    );
  }

  // GitLab or unknown platform: only security filter
  return groups.filter((g) => isGroupSafe(g.displayName));
}
