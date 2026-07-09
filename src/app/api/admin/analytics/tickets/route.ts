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
          COUNT(*) as total_tickets,
          COUNT(*) FILTER (WHERE type = 'incident') as total_incidents,
          COUNT(*) FILTER (WHERE type = 'request') as total_requests,
          COUNT(*) FILTER (WHERE status != 'closed') as open_count
        FROM portal_tickets
        WHERE created_at >= NOW() - INTERVAL '${days} days'
      ),
      previous_period AS (
        SELECT
          COUNT(*) as total_tickets,
          COUNT(*) FILTER (WHERE type = 'incident') as total_incidents,
          COUNT(*) FILTER (WHERE type = 'request') as total_requests,
          COUNT(*) FILTER (WHERE status != 'closed') as open_count
        FROM portal_tickets
        WHERE created_at >= NOW() - INTERVAL '${days * 2} days'
          AND created_at < NOW() - INTERVAL '${days} days'
      )
      SELECT
        c.total_tickets, c.total_incidents, c.total_requests, c.open_count,
        p.total_tickets as prev_total_tickets, p.total_incidents as prev_total_incidents,
        p.total_requests as prev_total_requests, p.open_count as prev_open_count
      FROM current_period c, previous_period p
    `);

    // Daily volume
    const { rows: dailyVolume } = await pool.query(`
      SELECT
        DATE(created_at) as date,
        COUNT(*) FILTER (WHERE type = 'incident') as incidents,
        COUNT(*) FILTER (WHERE type = 'request') as requests
      FROM portal_tickets
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY 1
      ORDER BY 1
    `);

    // Top requestors
    const { rows: topRequestors } = await pool.query(`
      SELECT
        requestor_email as email,
        MAX(requestor_name) as name,
        COUNT(*) FILTER (WHERE type = 'incident') as incidents,
        COUNT(*) FILTER (WHERE type = 'request') as requests,
        COUNT(*) as total
      FROM portal_tickets
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY requestor_email
      ORDER BY total DESC
      LIMIT 10
    `);

    // By team
    const { rows: byTeam } = await pool.query(`
      SELECT
        COALESCE(business_team, 'Sin equipo') as team,
        COUNT(*) as count
      FROM portal_tickets
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY 1
      ORDER BY count DESC
    `);

    // Status distribution
    const { rows: statusDistribution } = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM portal_tickets
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY status
      ORDER BY count DESC
    `);

    // Priority distribution
    const { rows: priorityDistribution } = await pool.query(`
      SELECT priority, COUNT(*) as count
      FROM portal_tickets
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY priority
      ORDER BY count DESC
    `);

    const kpi = kpiRows[0];
    const trends = {
      totalTickets: calculateTrend(Number(kpi.total_tickets), Number(kpi.prev_total_tickets)),
      totalIncidents: calculateTrend(Number(kpi.total_incidents), Number(kpi.prev_total_incidents)),
      totalRequests: calculateTrend(Number(kpi.total_requests), Number(kpi.prev_total_requests)),
      openCount: calculateTrend(Number(kpi.open_count), Number(kpi.prev_open_count)),
    };

    return NextResponse.json({
      period: { days, from: from.toISOString(), to: to.toISOString() },
      data: {
        kpis: {
          totalTickets: Number(kpi.total_tickets),
          totalIncidents: Number(kpi.total_incidents),
          totalRequests: Number(kpi.total_requests),
          openCount: Number(kpi.open_count),
        },
        trends,
        dailyVolume: dailyVolume.map(r => ({ date: r.date, incidents: Number(r.incidents), requests: Number(r.requests) })),
        topRequestors: topRequestors.map(r => ({
          email: r.email,
          name: r.name || r.email,
          incidents: Number(r.incidents),
          requests: Number(r.requests),
          total: Number(r.total),
        })),
        byTeam: byTeam.map(r => ({ team: r.team, count: Number(r.count) })),
        statusDistribution: statusDistribution.map(r => ({ status: r.status, count: Number(r.count) })),
        priorityDistribution: priorityDistribution.map(r => ({ priority: r.priority, count: Number(r.count) })),
      },
    });
  } catch (error) {
    console.error("[admin/analytics/tickets] Query failed:", error);
    return NextResponse.json({ error: "Failed to fetch analytics" }, { status: 500 });
  }
}
