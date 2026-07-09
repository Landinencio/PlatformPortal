import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { cached, cacheKey } from "@/lib/cache";
import { requireUserAuth } from "@/lib/api-auth";
import { aggregateTeamActivity, type CanonicalMrRow } from "@/lib/mr-metrics-canonical";
import { resolveDateWindow } from "@/lib/metrics-window";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const days = Math.min(Math.max(Number(searchParams.get("days")) || 30, 7), 180);
  const teams = searchParams.get("teams")?.split(",").filter(Boolean) ?? [];
  const projectIds = searchParams.get("projectIds")?.split(",").map(Number).filter(Boolean) ?? [];
  // Author filter carries GitLab usernames (already expanded from canonical keys
  // by the client via options.authors[].usernames). Empty ⇒ no author filter.
  const authors = searchParams.get("authors")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

  // Custom date range (YYYY-MM-DD). When both are present they win over `days`
  // (mirrors the DORA core dashboard). Otherwise we use a rolling `days` window
  // ending now.
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const { startDate: windowStart, endDate: windowEnd } = resolveDateWindow({
    from: fromParam,
    to: toParam,
    days,
  });

  const key = cacheKey("team-activity", {
    from: windowStart.toISOString(),
    to: windowEnd.toISOString(),
    teams,
    projectIds,
    authors: [...authors].sort(),
  });

  const data = await cached(
    key,
    () => fetchTeamActivity(windowStart, windowEnd, teams, projectIds, authors),
    5 * 60 * 1000
  );

  return NextResponse.json(data);
}

async function fetchTeamActivity(
  windowStart: Date,
  windowEnd: Date,
  teams: string[],
  projectIds: number[],
  authors: string[]
) {
  // Scope filters (team/project) only. The MR window is applied by reference_at
  // (merged_at for merged, created_at otherwise) inside the canonical helper,
  // NOT by snapshot_date — that is what previously inflated counts to the full
  // 90-day backlog regardless of the selected window.
  const conditions: string[] = ["1 = 1"];
  const params: unknown[] = [];
  let paramIdx = 0;

  if (teams.length > 0) {
    paramIdx++;
    conditions.push(`team = ANY($${paramIdx})`);
    params.push(teams);
  }
  if (projectIds.length > 0) {
    paramIdx++;
    conditions.push(`project_id = ANY($${paramIdx})`);
    params.push(projectIds);
  }

  const scopeClause = conditions.join(" AND ");

  // Deduplicate to the most recent snapshot per (project_id, mr_iid).
  const query = `
    SELECT DISTINCT ON (project_id, mr_iid)
      project_id,
      mr_iid,
      team,
      title,
      state,
      author_username,
      author_name,
      author_avatar_url,
      project_name,
      web_url,
      created_at,
      merged_at,
      snapshot_date,
      lifetime_hours,
      review_time_hours,
      reviewers
    FROM gitlab_mr_analytics
    WHERE ${scopeClause}
    ORDER BY project_id, mr_iid, snapshot_date DESC
  `;

  const { rows } = await pool.query(query, params);

  const canonicalRows: CanonicalMrRow[] = rows.map((row: Record<string, unknown>) => ({
    projectId: Number(row.project_id),
    mrIid: Number(row.mr_iid),
    team: (row.team as string) ?? null,
    title: (row.title as string) ?? null,
    state: (row.state as string) ?? null,
    authorUsername: (row.author_username as string) ?? null,
    authorName: (row.author_name as string) ?? null,
    authorAvatarUrl: (row.author_avatar_url as string) ?? null,
    projectName: (row.project_name as string) ?? null,
    webUrl: (row.web_url as string) ?? null,
    createdAt: (row.created_at as Date) ?? null,
    mergedAt: (row.merged_at as Date) ?? null,
    snapshotDate: row.snapshot_date as Date,
    lifetimeHours: row.lifetime_hours != null ? Number(row.lifetime_hours) : null,
    reviewTimeHours: row.review_time_hours != null ? Number(row.review_time_hours) : null,
    reviewers: typeof row.reviewers === "string" ? safeParse(row.reviewers) : row.reviewers,
  }));

  const { summary, contributors } = aggregateTeamActivity(canonicalRows, windowStart, windowEnd);

  // Author filter: keep only the selected contributors (by GitLab username) and
  // recompute the summary so the headline numbers match the filtered grid. The
  // selected author's reviewsGiven (earned across ALL MRs during aggregation) is
  // preserved — we filter after aggregation, not before.
  if (authors.length > 0) {
    const wanted = new Set(authors);
    const filtered = contributors.filter((c) => wanted.has(c.username));
    const activeContributors = filtered.filter((c) => c.mrsMerged > 0 || c.reviewsGiven > 0).length;
    const mergedContributors = filtered.filter((c) => c.mrsMerged > 0);
    const avgTimeToMergeHours =
      mergedContributors.length > 0
        ? Math.round(
            (mergedContributors.reduce((sum, c) => sum + c.avgTimeToMergeHours, 0) /
              mergedContributors.length) *
              10
          ) / 10
        : 0;
    return {
      summary: {
        totalMRsMerged: filtered.reduce((sum, c) => sum + c.mrsMerged, 0),
        totalMRsOpen: filtered.reduce((sum, c) => sum + c.mrsOpen, 0),
        totalReviews: filtered.reduce((sum, c) => sum + c.reviewsGiven, 0),
        activeContributors,
        avgTimeToMergeHours,
      },
      contributors: filtered,
      filters: {
        from: windowStart.toISOString(),
        to: windowEnd.toISOString(),
        teams,
        projectIds,
        authors,
      },
    };
  }

  return {
    summary,
    contributors,
    filters: {
      from: windowStart.toISOString(),
      to: windowEnd.toISOString(),
      teams,
      projectIds,
      authors,
    },
  };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}
