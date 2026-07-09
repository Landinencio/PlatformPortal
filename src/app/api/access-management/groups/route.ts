import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import { graphClient } from "@/lib/graph-client";
import { gitlabClient } from "@/lib/gitlab";
import { fetchPlatformGroups } from "@/lib/access-management/platform-groups";
import { canSeeTeam, type TeamCategory } from "@/lib/access-management/team-mapping";
import { roleFromTokenData } from "@/lib/rbac";

const VALID_PLATFORMS = ["aws", "argocd", "sonarqube", "gitlab"];

const GITLAB_ISKAYPET_GROUP_ID = 66335040;

const GITLAB_EXCLUDED_SUBGROUPS = [
  "sre-infra",
  "platform-engineering",
  "platform engineering",
  "repository-templates",
  "repository templates",
  "staff-members",
  "staff members",
];

/**
 * GET /api/access-management/groups?platform=...&team=...&parentGroup=...
 *
 * - platform=aws|argocd|sonarqube → returns Azure AD groups assigned to the
 *   Enterprise App. If `team` is passed, filters by team category. Admins see
 *   everything, others only see groups in PUBLIC_TEAMS plus their selected team.
 * - platform=gitlab → unchanged (subgroups/projects of Iskaypet group).
 */
export async function GET(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const platform = searchParams.get("platform");
  const team = (searchParams.get("team") || "").toLowerCase() as TeamCategory;
  const parentGroup = searchParams.get("parentGroup");

  const session = (auth as any).session;
  const userRole = roleFromTokenData({
    appRole: (session?.user as any)?.appRole,
    roles: (session?.user as any)?.roles,
  });

  if (!platform || !VALID_PLATFORMS.includes(platform)) {
    return NextResponse.json(
      { error: `Invalid or missing platform. Must be one of: ${VALID_PLATFORMS.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    if (platform === "gitlab") {
      if (!parentGroup) {
        // Level 1: Return allowed subgroups of Iskaypet
        const subgroups = await gitlabClient.listSubgroups(GITLAB_ISKAYPET_GROUP_ID);
        const filtered = subgroups
          .filter((g) => {
            const lower = g.full_path.toLowerCase();
            const name = g.name.toLowerCase();
            return !GITLAB_EXCLUDED_SUBGROUPS.some(
              (excluded) => lower.includes(excluded) || name.includes(excluded),
            );
          })
          .map((g) => ({
            id: String(g.id),
            displayName: g.name,
            description: g.full_path,
          }))
          .sort((a, b) => a.displayName.localeCompare(b.displayName));

        return NextResponse.json({ groups: filtered, level: "subgroup" });
      }

      // Level 2: Return projects and subgroups inside the selected parent group
      const groupId = parseInt(parentGroup, 10);
      if (isNaN(groupId)) {
        return NextResponse.json({ error: "Invalid parentGroup ID" }, { status: 400 });
      }

      const [subgroups, projects] = await Promise.all([
        gitlabClient.listSubgroups(groupId),
        gitlabClient.listGroupProjects(groupId),
      ]);

      const filteredSubgroups = subgroups
        .filter((g) => {
          const lower = (g.full_path + " " + g.name).toLowerCase();
          return !GITLAB_EXCLUDED_SUBGROUPS.some((excluded) => lower.includes(excluded));
        })
        .map((g) => ({
          id: String(g.id),
          displayName: `📁 ${g.name}`,
          description: g.full_path,
          type: "group" as const,
        }));

      const filteredProjects = projects
        .filter((p) => {
          const lower = (p.path_with_namespace + " " + p.name).toLowerCase();
          return !lower.includes("sre") && !lower.includes("platform-engineering");
        })
        .map((p) => ({
          id: String(p.id),
          displayName: p.name,
          description: p.path_with_namespace,
          type: "project" as const,
        }));

      const items = [...filteredSubgroups, ...filteredProjects].sort((a, b) =>
        a.displayName.localeCompare(b.displayName),
      );

      return NextResponse.json({ groups: items, level: "project" });
    }

    // Azure AD platforms (aws, argocd, sonarqube)
    const allGroups = await fetchPlatformGroups(platform, () => graphClient.getToken());

    const isAdmin = userRole === "admin" || userRole === "directores";

    // Platforms where groups are split by team (so we filter by team).
    // ArgoCD and SonarQube currently have transversal groups (not per-squad)
    // so we return all groups to any authenticated user regardless of team.
    // TODO(steering): standardise ArgoCD/SonarQube groups per squad to enable
    // proper team-based filtering on these platforms too.
    const PLATFORMS_WITH_TEAM_GROUPS = new Set(["aws"]);
    const platformHasTeamGroups = PLATFORMS_WITH_TEAM_GROUPS.has(platform);

    // Filter logic:
    //   - Platforms WITHOUT team-based groups (argocd, sonarqube): return
    //     all groups regardless of `team` param.
    //   - Platforms WITH team-based groups (aws):
    //       team=...  → return only groups in that team (auth check first)
    //       no team   → admins see all, others see PUBLIC_TEAMS-only groups
    let groups = allGroups;
    if (platformHasTeamGroups) {
      if (team) {
        if (!isAdmin && !canSeeTeam(userRole, team)) {
          return NextResponse.json(
            { error: `Team "${team}" no disponible para tu rol` },
            { status: 403 },
          );
        }
        groups = allGroups.filter((g) => g.teamCategory === team);
      } else if (!isAdmin) {
        groups = allGroups.filter((g) => canSeeTeam(userRole, g.teamCategory));
      }
    }

    return NextResponse.json({
      groups,
      meta: {
        userRole,
        teamFilter: team || null,
        platformHasTeamGroups,
        totalUnfiltered: allGroups.length,
      },
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[access-management/groups] Error for ${platform}:`, errorMsg);
    return NextResponse.json({ error: errorMsg, platform }, { status: 500 });
  }
}
