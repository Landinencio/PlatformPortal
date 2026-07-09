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
          COUNT(*) as total_created,
          COUNT(DISTINCT user_email) as unique_creators
        FROM portal_user_activity
        WHERE occurred_at >= NOW() - INTERVAL '${days} days'
          AND (action LIKE '%repo%' OR event_type = 'repo_created')
      ),
      previous_period AS (
        SELECT
          COUNT(*) as total_created,
          COUNT(DISTINCT user_email) as unique_creators
        FROM portal_user_activity
        WHERE occurred_at >= NOW() - INTERVAL '${days * 2} days'
          AND occurred_at < NOW() - INTERVAL '${days} days'
          AND (action LIKE '%repo%' OR event_type = 'repo_created')
      )
      SELECT
        c.total_created, c.unique_creators,
        p.total_created as prev_total_created, p.unique_creators as prev_unique_creators
      FROM current_period c, previous_period p
    `);

    // Daily volume
    const { rows: dailyVolume } = await pool.query(`
      SELECT DATE(occurred_at) as date, COUNT(*) as count
      FROM portal_user_activity
      WHERE occurred_at >= NOW() - INTERVAL '${days} days'
        AND (action LIKE '%repo%' OR event_type = 'repo_created')
      GROUP BY 1
      ORDER BY 1
    `);

    // Top creators
    const { rows: topCreators } = await pool.query(`
      SELECT
        user_email as email,
        MAX(user_name) as name,
        COUNT(*) as count
      FROM portal_user_activity
      WHERE occurred_at >= NOW() - INTERVAL '${days} days'
        AND (action LIKE '%repo%' OR event_type = 'repo_created')
      GROUP BY user_email
      ORDER BY count DESC
      LIMIT 10
    `);

    const kpi = kpiRows[0];
    const trends = {
      totalCreated: calculateTrend(Number(kpi.total_created), Number(kpi.prev_total_created)),
      uniqueCreators: calculateTrend(Number(kpi.unique_creators), Number(kpi.prev_unique_creators)),
    };

    return NextResponse.json({
      period: { days, from: from.toISOString(), to: to.toISOString() },
      data: {
        kpis: {
          totalCreated: Number(kpi.total_created),
          uniqueCreators: Number(kpi.unique_creators),
        },
        trends,
        dailyVolume: dailyVolume.map(r => ({ date: r.date, count: Number(r.count) })),
        topCreators: topCreators.map(r => ({ email: r.email, name: r.name || r.email, count: Number(r.count) })),
      },
    });
  } catch (error) {
    console.error("[admin/analytics/repos] Query failed:", error);
    return NextResponse.json({ error: "Failed to fetch analytics" }, { status: 500 });
  }
}
