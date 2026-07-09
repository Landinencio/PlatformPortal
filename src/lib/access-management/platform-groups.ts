/**
 * Platform group configuration for access management.
 *
 * Dynamically fetches groups assigned to each Enterprise Application
 * from Microsoft Graph API using the appRoleAssignedTo endpoint.
 *
 * Each group is classified into a team category (digital, data, retail,
 * marktech, backoffice, platform, audit, other) so the UI can filter by
 * team when the requester picks one.
 *
 * Enterprise App Service Principal Object IDs:
 *  - ArgoCD (multiple instances, one per env)
 *  - SonarQube
 *  - AWS IAM Identity Center
 */

import { classifyGroup, type TeamCategory } from "@/lib/access-management/team-mapping";

export interface PlatformGroup {
  id: string;
  displayName: string;
  description?: string;
  /** Team category derived from the group's displayName. */
  teamCategory: TeamCategory;
}

/**
 * Service Principal Object IDs for each platform's Enterprise Application(s).
 * Some platforms (like ArgoCD) have multiple apps (one per environment).
 * We query all of them and deduplicate the groups.
 */
export const PLATFORM_SP_IDS: Record<string, string[]> = {
  argocd: [
    "d4c1136c-b16e-4a53-81fd-3e6f016d71ec", // OMS General Argo CD
    "effa022d-719d-49d4-b2e2-72c02966a49d", // EKS Prod Argo CD
    "fcd7ad35-4976-4543-858e-a7bd080237a9", // EKS Dev ArgoCD
    "a3a9c6dc-2652-49cc-9502-528ca6971497", // EKS UAT ArgoCD
    "61f786d2-879d-45ef-9929-ec2356f7fb7d", // ArgoCd Comerzzia Prod
    "80ac0baa-81f2-4c62-94be-e616527e4cbe", // ArgoCD Dev Comerzzia
  ],
  sonarqube: [
    "45099247-f6a1-4205-a11e-0c4dfbe1c51e",
  ],
  aws: [
    "6b006f65-c1ae-4fc1-a000-c5c788da1ca7", // AWS IAM Identity Center
  ],
};

/**
 * Fetch groups assigned to a platform's Enterprise Application(s) dynamically.
 * Returns ALL groups (no keyword-based exclusion) — filtering by team is done
 * by the API route depending on the requester's role and selected team.
 */
export async function fetchPlatformGroups(
  platform: string,
  getToken: () => Promise<string>
): Promise<PlatformGroup[]> {
  const spIds = PLATFORM_SP_IDS[platform.toLowerCase()];
  if (!spIds || spIds.length === 0) {
    return [];
  }

  const token = await getToken();
  const allGroups = new Map<string, string>(); // id -> displayName

  // Query all SPs for this platform in parallel
  const results = await Promise.allSettled(
    spIds.map(async (spId) => {
      const url = `https://graph.microsoft.com/v1.0/servicePrincipals/${spId}/appRoleAssignedTo?$top=200`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`[platform-groups] Failed to fetch SP ${spId}: ${res.status} ${body.slice(0, 200)}`);
        return [];
      }

      const data = await res.json();
      return (data.value || []).filter((a: any) => a.principalType === "Group");
    })
  );

  // Combine and deduplicate
  for (const result of results) {
    if (result.status === "fulfilled") {
      for (const assignment of result.value) {
        allGroups.set(assignment.principalId, assignment.principalDisplayName);
      }
    }
  }

  // Map to PlatformGroup with team classification, sorted alphabetically
  return Array.from(allGroups.entries())
    .map(([id, displayName]) => ({
      id,
      displayName,
      teamCategory: classifyGroup(displayName),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
