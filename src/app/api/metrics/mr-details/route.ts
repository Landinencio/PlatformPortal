/**
 * GET /api/metrics/mr-details
 * Returns per-MR review metrics for the management tab.
 *
 * Query params:
 *   days — lookback period (default 30)
 *   teams — comma-separated team filter
 *   projectIds — comma-separated project IDs
 *   authors — comma-separated author usernames
 *   page — pagination (default 1)
 *   limit — results per page (default 50, max 200)
 */

import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const days = Math.min(365, Math.max(1, parseInt(searchParams.get("days") || "30", 10)));
  const teams = (searchParams.get("teams") || "").split(",").filter(Boolean);
  const projectIds = (searchParams.get("projectIds") || "").split(",").map(Number).filter(Boolean);
  const authors = (searchParams.get("authors") || "").split(",").filter(Boolean);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const limit = Math.min(200, Math.max(10, parseInt(searchParams.get("limit") || "50", 10)));
  const offset = (page - 1) * limit;

  // Custom date range (YYYY-MM-DD). When both present they win over `days`.
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const isValidDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const useRange = isValidDate(fromParam) && isValidDate(toParam);

  try {
    // Build WHERE clause. Date window first.
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (useRange) {
      conditions.push(`merged_at >= $${paramIdx}::date AND merged_at < ($${paramIdx + 1}::date + INTERVAL '1 day')`);
      params.push(fromParam, toParam);
      paramIdx += 2;
    } else {
      conditions.push(`merged_at >= NOW() - INTERVAL '${days} days'`);
    }

    if (teams.length > 0) {
      conditions.push(`team = ANY($${paramIdx})`);
      params.push(teams);
      paramIdx++;
    }
    if (projectIds.length > 0) {
      conditions.push(`project_id = ANY($${paramIdx})`);
      params.push(projectIds);
      paramIdx++;
    }
    if (authors.length > 0) {
      conditions.push(`author_username = ANY($${paramIdx})`);
      params.push(authors);
      paramIdx++;
    }

    const whereClause = conditions.join(" AND ");

    // Get total count
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) as total FROM mr_review_metrics WHERE ${whereClause}`,
      params
    );
    const total = Number(countRows[0].total);

    // Get MRs
    const { rows } = await pool.query(
      `SELECT * FROM mr_review_metrics 
       WHERE ${whereClause}
       ORDER BY merged_at DESC NULLS LAST
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    // Get summary stats
    const { rows: summaryRows } = await pool.query(
      `SELECT 
         COUNT(*) as total_mrs,
         ROUND(AVG(review_time_hours)::numeric, 1) as avg_review_time,
         ROUND(AVG(time_to_pr_hours)::numeric, 1) as avg_time_to_pr,
         ROUND(AVG(comment_count)::numeric, 1) as avg_comments,
         ROUND(AVG(commit_count)::numeric, 1) as avg_commits,
         ROUND(AVG(reviewer_count)::numeric, 1) as avg_reviewers,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY review_time_hours) as median_review_time,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY time_to_pr_hours) as median_time_to_pr
       FROM mr_review_metrics
       WHERE ${whereClause}`,
      params
    );

    const summary = summaryRows[0];

    return NextResponse.json({
      mrs: rows.map((r) => ({
        id: r.id,
        projectPath: r.project_path,
        team: r.team,
        mrIid: r.mr_iid,
        title: r.mr_title,
        url: r.mr_url,
        author: r.author_name || r.author_username,
        authorUsername: r.author_username,
        targetBranch: r.target_branch,
        createdAt: r.created_at,
        mergedAt: r.merged_at,
        firstCommitAt: r.first_commit_at,
        timeToPrHours: r.time_to_pr_hours ? Number(r.time_to_pr_hours) : null,
        reviewTimeHours: r.review_time_hours ? Number(r.review_time_hours) : null,
        commitCount: r.commit_count,
        commentCount: r.comment_count,
        reviewerCount: r.reviewer_count,
        linesAdded: r.lines_added,
        linesRemoved: r.lines_removed,
      })),
      summary: {
        totalMRs: Number(summary.total_mrs),
        avgReviewTime: Number(summary.avg_review_time || 0),
        avgTimeToPr: Number(summary.avg_time_to_pr || 0),
        avgComments: Number(summary.avg_comments || 0),
        avgCommits: Number(summary.avg_commits || 0),
        avgReviewers: Number(summary.avg_reviewers || 0),
        medianReviewTime: summary.median_review_time ? Number(Number(summary.median_review_time).toFixed(1)) : 0,
        medianTimeToPr: summary.median_time_to_pr ? Number(Number(summary.median_time_to_pr).toFixed(1)) : 0,
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("[mr-details] Query failed:", error);
    return NextResponse.json({ error: "Failed to fetch MR details" }, { status: 500 });
  }
}
