/**
 * Team-based approval routing configuration.
 * Used by: infra-request-v2, access-management, create-repo
 */

export const BUSINESS_TEAMS = ["digital", "marktech", "retail", "data", "backoffice", "soporte-tienda", "soporte-sede"] as const;
export type BusinessTeam = (typeof BUSINESS_TEAMS)[number];

/** Teams available for infra requests (excludes backoffice and soporte) */
export const INFRA_BUSINESS_TEAMS = ["digital", "marktech", "retail", "data"] as const;

export const BUSINESS_TEAM_LABELS: Record<BusinessTeam, string> = {
  digital: "Digital",
  marktech: "MarTech",
  retail: "Retail",
  data: "Data",
  backoffice: "Backoffice",
  "soporte-tienda": "Soporte Tienda",
  "soporte-sede": "Soporte Sede",
};

/**
 * Approvers per team. Each entry has both @iskaypet.com and @emefinpetcare.com variants.
 * The system matches by local part (before @) to handle domain migration.
 */
const TEAM_APPROVERS: Record<BusinessTeam, string[]> = {
  digital: [], // Uses existing SELECTABLE_APPROVERS from infra-approvers.ts
  marktech: ["alberto.salomon"],
  retail: ["victoria.reyes", "jesus.avila"],
  data: ["jose.lopez", "francisca.suarez", "arturo.lorenzo"],
  backoffice: ["mariajose.gonzalez", "pedro.hernandez"],
  "soporte-tienda": [],
  "soporte-sede": [],
};

/**
 * Flow types and whether they require approval.
 */
export type RequestFlow = "create-repo" | "infra-request" | "access-request";

export const FLOW_REQUIRES_APPROVAL: Record<RequestFlow, boolean> = {
  "create-repo": false,
  "infra-request": true,
  "access-request": true,
};

/**
 * Resolves the list of available approvers for a given team and requester.
 * Rules:
 * - A person cannot approve their own request (self-approval prevention)
 * - Email matching is done by local part (handles @iskaypet.com / @emefinpetcare.com)
 *
 * @param team - The business team
 * @param requesterEmail - Email of the person making the request
 * @returns Array of approver objects with email and display name
 */
export function getApproversForTeam(
  team: BusinessTeam,
  requesterEmail: string
): Array<{ email: string; name: string }> {
  const requesterLocal = requesterEmail.split("@")[0].toLowerCase();

  if (team === "digital") {
    // Digital uses the existing approvers list (imported from infra-approvers)
    // Return empty here — the caller should use SELECTABLE_APPROVERS for digital
    return [];
  }

  const approverLocals = TEAM_APPROVERS[team];

  return approverLocals
    .filter((local) => local.toLowerCase() !== requesterLocal) // Self-approval prevention
    .map((local) => ({
      email: `${local}@iskaypet.com`,
      name: local
        .split(".")
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(" "),
    }));
}

/**
 * Checks if a given email matches any approver for the team (handles domain variants).
 */
export function isApproverForTeam(team: BusinessTeam, email: string): boolean {
  const local = email.split("@")[0].toLowerCase();
  if (team === "digital") return true; // Digital approvers are managed separately
  return TEAM_APPROVERS[team].some(
    (approverLocal) => approverLocal.toLowerCase() === local
  );
}

/**
 * Checks if a given email is a team approver for ANY team (data, marktech, retail, backoffice).
 * Used by the review endpoint to authorize team-specific approvers (e.g. francisca.suarez)
 * who are not in the global infra approvers list.
 */
export function isTeamApprover(email: string): boolean {
  const local = email.split("@")[0].toLowerCase();
  for (const team of Object.keys(TEAM_APPROVERS) as BusinessTeam[]) {
    if (TEAM_APPROVERS[team].some((l) => l.toLowerCase() === local)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether `email` is the ONLY configured approver for `team`.
 *
 * Used to allow self-approval as a deliberate exception for one-person teams
 * (e.g. MarTech, whose single approver `alberto.salomon` would otherwise be unable
 * to request anything because self-approval prevention leaves the approver list empty).
 *
 * Returns false for `digital` (its approvers are managed separately and there is always
 * more than one) and for any team with zero or more-than-one approvers.
 */
export function isSoleApprover(team: BusinessTeam, email: string): boolean {
  if (team === "digital") return false;
  const approvers = TEAM_APPROVERS[team] || [];
  if (approvers.length !== 1) return false;
  const local = email.split("@")[0].toLowerCase();
  return approvers[0].toLowerCase() === local;
}

/**
 * Returns the list of teams the given email is a configured approver for.
 * Used to scope listing endpoints (so team approvers only see requests of
 * their own team, not the whole platform).
 */
export function teamsApprovedBy(email: string): BusinessTeam[] {
  const local = email.split("@")[0].toLowerCase();
  const teams: BusinessTeam[] = [];
  for (const team of Object.keys(TEAM_APPROVERS) as BusinessTeam[]) {
    if (TEAM_APPROVERS[team].some((l) => l.toLowerCase() === local)) {
      teams.push(team);
    }
  }
  return teams;
}

/**
 * Normalizes email for comparison (handles @iskaypet.com ↔ @emefinpetcare.com).
 */
export function emailLocalPart(email: string): string {
  return email.split("@")[0].toLowerCase();
}
