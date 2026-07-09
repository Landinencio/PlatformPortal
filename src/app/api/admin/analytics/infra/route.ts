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
    // KPIs with trends
    const { rows: kpiRows } = await pool.query(`
      WITH current_period AS (
        SELECT
          COUNT(*) as total_requests,
          ROUND(COUNT(*) FILTER (WHERE status IN ('approved', 'executed'))::numeric / NULLIF(COUNT(*) FILTER (WHERE status IN ('approved', 'executed', 'rejected')), 0) * 100, 1) as approval_rate,
          COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
          ROUND(AVG(EXTRACT(EPOCH FROM (reviewed_at - created_at)) / 3600.0) FILTER (WHERE reviewed_at IS NOT NULL)::numeric, 1) as avg_time_to_review
        FROM infra_requests
        WHERE created_at >= NOW() - INTERVAL '${days} days'
      ),
      previous_period AS (
        SELECT
          COUNT(*) as total_requests,
          ROUND(COUNT(*) FILTER (WHERE status IN ('approved', 'executed'))::numeric / NULLIF(COUNT(*) FILTER (WHERE status IN ('approved', 'executed', 'rejected')), 0) * 100, 1) as approval_rate,
          COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
          ROUND(AVG(EXTRACT(EPOCH FROM (reviewed_at - created_at)) / 3600.0) FILTER (WHERE reviewed_at IS NOT NULL)::numeric, 1) as avg_time_to_review
        FROM infra_requests
        WHERE created_at >= NOW() - INTERVAL '${days * 2} days'
          AND created_at < NOW() - INTERVAL '${days} days'
      )
      SELECT
        c.total_requests, c.approval_rate, c.pending_count, c.avg_time_to_review,
        p.total_requests as prev_total_requests, p.approval_rate as prev_approval_rate,
        p.pending_count as prev_pending_count, p.avg_time_to_review as prev_avg_time_to_review
      FROM current_period c, previous_period p
    `);

    // By resource type
    const { rows: byResourceType } = await pool.query(`
      SELECT resource_type as type, COUNT(*) as count
      FROM infra_requests
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY resource_type
      ORDER BY count DESC
    `);

    // Daily volume
    const { rows: dailyVolume } = await pool.query(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM infra_requests
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY 1
      ORDER BY 1
    `);

    // By team
    const { rows: byTeam } = await pool.query(`
      SELECT team, COUNT(*) as count
      FROM infra_requests
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY team
      ORDER BY count DESC
    `);

    // Top requestors
    const { rows: topRequestors } = await pool.query(`
      SELECT
        requestor_email as email,
        MAX(requestor_name) as name,
        COUNT(*) as count
      FROM infra_requests
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY requestor_email
      ORDER BY count DESC
      LIMIT 10
    `);

    const kpi = kpiRows[0];
    const trends = {
      totalRequests: calculateTrend(Number(kpi.total_requests), Number(kpi.prev_total_requests)),
      approvalRate: calculateTrend(Number(kpi.approval_rate || 0), Number(kpi.prev_approval_rate || 0)),
      pendingCount: calculateTrend(Number(kpi.pending_count), Number(kpi.prev_pending_count)),
      avgTimeToReview: calculateTrend(Number(kpi.avg_time_to_review || 0), Number(kpi.prev_avg_time_to_review || 0)),
    };

    return NextResponse.json({
      period: { days, from: from.toISOString(), to: to.toISOString() },
      data: {
        kpis: {
          totalRequests: Number(kpi.total_requests),
          approvalRate: Number(kpi.approval_rate || 0),
          pendingCount: Number(kpi.pending_count),
          avgTimeToReview: Number(kpi.avg_time_to_review || 0),
        },
        trends,
        byResourceType: byResourceType.map(r => ({ type: r.type, count: Number(r.count) })),
        dailyVolume: dailyVolume.map(r => ({ date: r.date, count: Number(r.count) })),
        byTeam: byTeam.map(r => ({ team: r.team, count: Number(r.count) })),
        topRequestors: topRequestors.map(r => ({ email: r.email, name: r.name || r.email, count: Number(r.count) })),
      },
    });
  } catch (error) {
    console.error("[admin/analytics/infra] Query failed:", error);
    return NextResponse.json({ error: "Failed to fetch analytics" }, { status: 500 });
  }
}
