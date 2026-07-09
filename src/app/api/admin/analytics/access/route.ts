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
          COUNT(*) FILTER (WHERE request_type IN ('grant', 'onboard')) as grant_count,
          COUNT(*) FILTER (WHERE request_type IN ('revoke', 'offboard')) as revoke_count,
          COUNT(*) FILTER (WHERE status = 'executed') as executed_count
        FROM access_requests
        WHERE created_at >= NOW() - INTERVAL '${days} days'
      ),
      previous_period AS (
        SELECT
          COUNT(*) as total_requests,
          COUNT(*) FILTER (WHERE request_type IN ('grant', 'onboard')) as grant_count,
          COUNT(*) FILTER (WHERE request_type IN ('revoke', 'offboard')) as revoke_count,
          COUNT(*) FILTER (WHERE status = 'executed') as executed_count
        FROM access_requests
        WHERE created_at >= NOW() - INTERVAL '${days * 2} days'
          AND created_at < NOW() - INTERVAL '${days} days'
      )
      SELECT
        c.total_requests, c.grant_count, c.revoke_count, c.executed_count,
        p.total_requests as prev_total_requests, p.grant_count as prev_grant_count,
        p.revoke_count as prev_revoke_count, p.executed_count as prev_executed_count
      FROM current_period c, previous_period p
    `);

    // By platform
    const { rows: byPlatform } = await pool.query(`
      SELECT platform, COUNT(*) as count
      FROM access_requests
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY platform
      ORDER BY count DESC
    `);

    // Daily volume
    const { rows: dailyVolume } = await pool.query(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM access_requests
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY 1
      ORDER BY 1
    `);

    // Top requestors
    const { rows: topRequestors } = await pool.query(`
      SELECT
        requestor_email as email,
        requestor_email as name,
        COUNT(*) as count
      FROM access_requests
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY requestor_email
      ORDER BY count DESC
      LIMIT 10
    `);

    // Status distribution
    const { rows: statusDistribution } = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM access_requests
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY status
      ORDER BY count DESC
    `);

    const kpi = kpiRows[0];
    const trends = {
      totalRequests: calculateTrend(Number(kpi.total_requests), Number(kpi.prev_total_requests)),
      grantCount: calculateTrend(Number(kpi.grant_count), Number(kpi.prev_grant_count)),
      revokeCount: calculateTrend(Number(kpi.revoke_count), Number(kpi.prev_revoke_count)),
      executedCount: calculateTrend(Number(kpi.executed_count), Number(kpi.prev_executed_count)),
    };

    return NextResponse.json({
      period: { days, from: from.toISOString(), to: to.toISOString() },
      data: {
        kpis: {
          totalRequests: Number(kpi.total_requests),
          grantCount: Number(kpi.grant_count),
          revokeCount: Number(kpi.revoke_count),
          executedCount: Number(kpi.executed_count),
        },
        trends,
        byPlatform: byPlatform.map(r => ({ platform: r.platform, count: Number(r.count) })),
        dailyVolume: dailyVolume.map(r => ({ date: r.date, count: Number(r.count) })),
        topRequestors: topRequestors.map(r => ({ email: r.email, name: r.name, count: Number(r.count) })),
        statusDistribution: statusDistribution.map(r => ({ status: r.status, count: Number(r.count) })),
      },
    });
  } catch (error) {
    console.error("[admin/analytics/access] Query failed:", error);
    return NextResponse.json({ error: "Failed to fetch analytics" }, { status: 500 });
  }
}
