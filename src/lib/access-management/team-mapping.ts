/**
 * Maps Azure AD groups to business teams based on group display name patterns.
 *
 * Used by /api/access-management/groups to filter the list of available
 * groups by the team the user (or admin) selects in the UI.
 *
 * Categories:
 *   - PUBLIC_TEAMS  → visible to all roles in the team selector
 *   - ADMIN_ONLY_TEAMS → only visible to admin/directores
 *
 * The matching is done against the group's displayName (case-insensitive)
 * and uses the first matching category. Order in TEAM_PATTERNS matters
 * because we evaluate top to bottom.
 */

import type { BusinessTeam } from "@/lib/team-approvers";

export type TeamCategory = BusinessTeam | "platform" | "audit" | "other";

/** Teams shown in the dropdown for ALL users (any role can request access to their own team) */
export const PUBLIC_TEAMS: TeamCategory[] = [
  "digital",
  "retail",
  "marktech",
  "data",
  "backoffice",
  "soporte-tienda",
  "soporte-sede",
  "platform",
];

/** Teams shown ONLY when the user is admin/directores (audit and catch-all) */
export const ADMIN_ONLY_TEAMS: TeamCategory[] = ["audit", "other"];

export const ALL_TEAM_CATEGORIES: TeamCategory[] = [...PUBLIC_TEAMS, ...ADMIN_ONLY_TEAMS];

export const TEAM_CATEGORY_LABELS: Record<TeamCategory, string> = {
  digital: "Digital",
  data: "Data",
  retail: "Retail",
  marktech: "MarTech",
  backoffice: "Backoffice",
  "soporte-tienda": "Soporte Tienda",
  "soporte-sede": "Soporte Sede",
  platform: "Platform / SRE",
  audit: "Audit",
  other: "Otros",
};

/**
 * Patterns for classifying Azure AD groups by team category.
 *
 * Order matters: more specific rules first. Each rule is evaluated against
 * the displayName (case-insensitive). The first match wins.
 */
const TEAM_PATTERNS: Array<{ category: TeamCategory; patterns: RegExp[] }> = [
  // Audit (very specific, evaluate before others)
  {
    category: "audit",
    patterns: [/^aws_audit/i, /audit_athena/i, /^acens/i],
  },
  // Platform / SRE / Tooling
  {
    category: "platform",
    patterns: [
      /^petcare_eks/i,
      /^seidor.*eks/i,
      /eks_access$/i,
      /^sre$/i,
      /^sysadmin/i,
      /^platform engineering/i,
      /^sistemasaws/i,
      /^aws marketplace/i,
      /^awsmarketplace/i,
      /^clienteunico/i,
    ],
  },
  // Digital (DH = Digital Hub)
  {
    category: "digital",
    patterns: [/^aws_dh_/i, /^digital_/i],
  },
  // Data
  {
    category: "data",
    patterns: [/^aws_data_/i, /^data_/i, /thecocktail.*developers/i],
  },
  // Retail
  {
    category: "retail",
    patterns: [/^aws_retail_/i, /^retail_/i],
  },
  // MarTech — internal slug is "marktech" (legacy typo kept as the key to avoid
  // breaking DB/RBAC references); display label is "MarTech". Heir of Helios.
  {
    category: "marktech",
    patterns: [/^aws_martech_/i, /^martech_/i, /^marketing_/i],
  },
  // Backoffice
  {
    category: "backoffice",
    patterns: [/^aws_backoffice/i, /^backoffice_/i],
  },
];

/** Classify a group's displayName into a team category. Falls back to "other". */
export function classifyGroup(displayName: string): TeamCategory {
  const name = displayName || "";
  for (const { category, patterns } of TEAM_PATTERNS) {
    if (patterns.some((p) => p.test(name))) return category;
  }
  return "other";
}

/** Visible teams for a given user role */
export function getVisibleTeamsForRole(role: string): TeamCategory[] {
  const r = (role || "").toLowerCase();
  const isAdmin = r === "admin" || r === "directores";
  return isAdmin ? ALL_TEAM_CATEGORIES : PUBLIC_TEAMS;
}

/** True if the user's role can see the given team category */
export function canSeeTeam(role: string, team: TeamCategory): boolean {
  const r = (role || "").toLowerCase();
  if (r === "admin" || r === "directores") return true;
  return PUBLIC_TEAMS.includes(team);
}
