import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";
import { validateDaysParam, calculateTrend, getDateRange } from "@/lib/admin-analytics";

export async function GET(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;
  const role = (auth.session.user as any)?.appRole || "externos";
  if (role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const days = validateDaysParam(searchParams.get("days"));
  const { from, to } = getDateRange(days);

  try {
    // KPIs with trends using UNION of both tables
    const { rows: kpiRows } = await pool.query(`
      WITH all_reviews AS (
        SELECT reviewed_at, status, reviewer_email, reviewer_name, created_at
        FROM access_requests
        WHERE reviewed_at IS NOT NULL AND reviewed_at >= NOW() - INTERVAL '${days} days'
        UNION ALL
        SELECT reviewed_at, status, reviewer_email, reviewer_name, created_at
        FROM infra_requests
        WHERE reviewed_at IS NOT NULL AND reviewed_at >= NOW() - INTERVAL '${days} days'
      ),
      prev_reviews AS (
        SELECT reviewed_at, status, reviewer_email, reviewer_name, created_at
        FROM access_requests
        WHERE reviewed_at IS NOT NULL
          AND reviewed_at >= NOW() - INTERVAL '${days * 2} days'
          AND reviewed_at < NOW() - INTERVAL '${days} days'
        UNION ALL
        SELECT reviewed_at, status, reviewer_email, reviewer_name, created_at
        FROM infra_requests
        WHERE reviewed_at IS NOT NULL
          AND reviewed_at >= NOW() - INTERVAL '${days * 2} days'
          AND reviewed_at < NOW() - INTERVAL '${days} days'
      ),
      current_kpis AS (
        SELECT
          COUNT(*) as total_reviews,
          ROUND(COUNT(*) FILTER (WHERE status IN ('approved', 'executed', 'execute_failed'))::numeric / NULLIF(COUNT(*), 0) * 100, 1) as approval_rate,
          ROUND(AVG(EXTRACT(EPOCH FROM (reviewed_at - created_at)) / 3600.0)::numeric, 1) as avg_time_to_review
        FROM all_reviews
      ),
      prev_kpis AS (
        SELECT
          COUNT(*) as total_reviews,
          ROUND(COUNT(*) FILTER (WHERE status IN ('approved', 'executed', 'execute_failed'))::numeric / NULLIF(COUNT(*), 0) * 100, 1) as approval_rate,
          ROUND(AVG(EXTRACT(EPOCH FROM (reviewed_at - created_at)) / 3600.0)::numeric, 1) as avg_time_to_review
        FROM prev_reviews
      ),
      pending AS (
        SELECT
          (SELECT COUNT(*) FROM access_requests WHERE status = 'pending') +
          (SELECT COUNT(*) FROM infra_requests WHERE status = 'pending') as pending_count
      )
      SELECT
        c.total_reviews, c.approval_rate, c.avg_time_to_review,
        pe.pending_count,
        p.total_reviews as prev_total_reviews,
        p.approval_rate as prev_approval_rate,
        p.avg_time_to_review as prev_avg_time_to_review
      FROM current_kpis c, prev_kpis p, pending pe
    `);

    // Top reviewers
    const { rows: topReviewers } = await pool.query(`
      WITH all_reviews AS (
        SELECT
          LOWER(REPLACE(reviewer_email, '@emefinpetcare.com', '@iskaypet.com')) as reviewer_email,
          reviewer_name, status
        FROM access_requests
        WHERE reviewed_at IS NOT NULL AND reviewed_at >= NOW() - INTERVAL '${days} days'
        UNION ALL
        SELECT
          LOWER(REPLACE(reviewer_email, '@emefinpetcare.com', '@iskaypet.com')) as reviewer_email,
          reviewer_name, status
        FROM infra_requests
        WHERE reviewed_at IS NOT NULL AND reviewed_at >= NOW() - INTERVAL '${days} days'
      )
      SELECT
        reviewer_email as email,
        MAX(reviewer_name) as name,
        COUNT(*) FILTER (WHERE status IN ('approved', 'executed', 'execute_failed')) as approved,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
        COUNT(*) as total
      FROM all_reviews
      WHERE reviewer_email IS NOT NULL
      GROUP BY reviewer_email
      ORDER BY total DESC
      LIMIT 10
    `);

    // Approval rate by team (from access_requests business_team)
    const { rows: approvalRateByTeam } = await pool.query(`
      SELECT
        COALESCE(business_team, 'Sin equipo') as team,
        ROUND(COUNT(*) FILTER (WHERE status IN ('approved', 'executed', 'execute_failed'))::numeric / NULLIF(COUNT(*), 0) * 100, 1) as rate,
        COUNT(*) as total
      FROM access_requests
      WHERE reviewed_at IS NOT NULL AND reviewed_at >= NOW() - INTERVAL '${days} days'
      GROUP BY 1
      ORDER BY total DESC
    `);

    // Daily volume
    const { rows: dailyVolume } = await pool.query(`
      WITH all_reviews AS (
        SELECT reviewed_at, status
        FROM access_requests
        WHERE reviewed_at IS NOT NULL AND reviewed_at >= NOW() - INTERVAL '${days} days'
        UNION ALL
        SELECT reviewed_at, status
        FROM infra_requests
        WHERE reviewed_at IS NOT NULL AND reviewed_at >= NOW() - INTERVAL '${days} days'
      )
      SELECT
        DATE(reviewed_at) as date,
        COUNT(*) FILTER (WHERE status IN ('approved', 'executed', 'execute_failed')) as approved,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected
      FROM all_reviews
      GROUP BY 1
      ORDER BY 1
    `);

    const kpi = kpiRows[0];
    const trends = {
      totalReviews: calculateTrend(Number(kpi.total_reviews), Number(kpi.prev_total_reviews)),
      approvalRate: calculateTrend(Number(kpi.approval_rate || 0), Number(kpi.prev_approval_rate || 0)),
      avgTimeToReview: calculateTrend(Number(kpi.avg_time_to_review || 0), Number(kpi.prev_avg_time_to_review || 0)),
    };

    return NextResponse.json({
      period: { days, from: from.toISOString(), to: to.toISOString() },
      data: {
        kpis: {
          totalReviews: Number(kpi.total_reviews),
          approvalRate: Number(kpi.approval_rate || 0),
          avgTimeToReview: Number(kpi.avg_time_to_review || 0),
          pendingCount: Number(kpi.pending_count),
        },
        trends,
        topReviewers: topReviewers.map(r => ({
          email: r.email,
          name: r.name || r.email,
          approved: Number(r.approved),
          rejected: Number(r.rejected),
          total: Number(r.total),
        })),
        approvalRateByTeam: approvalRateByTeam.map(r => ({
          team: r.team,
          rate: Number(r.rate || 0),
          total: Number(r.total),
        })),
        dailyVolume: dailyVolume.map(r => ({
          date: r.date,
          approved: Number(r.approved),
          rejected: Number(r.rejected),
        })),
      },
    });
  } catch (error) {
    console.error("[admin/analytics/approvals] Query failed:", error);
    return NextResponse.json({ error: "Failed to fetch analytics" }, { status: 500 });
  }
}
