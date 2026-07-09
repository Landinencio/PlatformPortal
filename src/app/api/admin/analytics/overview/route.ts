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
          (SELECT COUNT(DISTINCT user_email) FROM portal_user_activity
           WHERE occurred_at >= NOW() - INTERVAL '${days} days') as total_users,
          (SELECT COUNT(DISTINCT user_email) FROM portal_user_activity
           WHERE occurred_at >= NOW() - INTERVAL '7 days') as active_users_7d,
          (SELECT COUNT(DISTINCT user_email) FROM portal_user_activity
           WHERE occurred_at >= NOW() - INTERVAL '30 days') as active_users_30d,
          (SELECT COUNT(*) FROM portal_tickets
           WHERE created_at >= NOW() - INTERVAL '${days} days') as total_tickets,
          (SELECT COUNT(*) FROM access_requests
           WHERE created_at >= NOW() - INTERVAL '${days} days') as total_access_requests,
          (SELECT COUNT(*) FROM infra_requests
           WHERE created_at >= NOW() - INTERVAL '${days} days') as total_infra_requests
      ),
      previous_period AS (
        SELECT
          (SELECT COUNT(DISTINCT user_email) FROM portal_user_activity
           WHERE occurred_at >= NOW() - INTERVAL '${days * 2} days'
             AND occurred_at < NOW() - INTERVAL '${days} days') as total_users,
          (SELECT COUNT(DISTINCT user_email) FROM portal_user_activity
           WHERE occurred_at >= NOW() - INTERVAL '14 days'
             AND occurred_at < NOW() - INTERVAL '7 days') as active_users_7d,
          (SELECT COUNT(DISTINCT user_email) FROM portal_user_activity
           WHERE occurred_at >= NOW() - INTERVAL '60 days'
             AND occurred_at < NOW() - INTERVAL '30 days') as active_users_30d,
          (SELECT COUNT(*) FROM portal_tickets
           WHERE created_at >= NOW() - INTERVAL '${days * 2} days'
             AND created_at < NOW() - INTERVAL '${days} days') as total_tickets,
          (SELECT COUNT(*) FROM access_requests
           WHERE created_at >= NOW() - INTERVAL '${days * 2} days'
             AND created_at < NOW() - INTERVAL '${days} days') as total_access_requests,
          (SELECT COUNT(*) FROM infra_requests
           WHERE created_at >= NOW() - INTERVAL '${days * 2} days'
             AND created_at < NOW() - INTERVAL '${days} days') as total_infra_requests
      )
      SELECT
        c.total_users, c.active_users_7d, c.active_users_30d,
        c.total_tickets, c.total_access_requests, c.total_infra_requests,
        p.total_users as prev_total_users, p.active_users_7d as prev_active_users_7d,
        p.active_users_30d as prev_active_users_30d,
        p.total_tickets as prev_total_tickets,
        p.total_access_requests as prev_total_access_requests,
        p.total_infra_requests as prev_total_infra_requests
      FROM current_period c, previous_period p
    `);

    // Weekly active users
    const { rows: weeklyActiveUsers } = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('week', occurred_at), 'IYYY-IW') as week,
        COUNT(DISTINCT user_email) as count
      FROM portal_user_activity
      WHERE occurred_at >= NOW() - INTERVAL '${days} days'
      GROUP BY 1
      ORDER BY 1
    `);

    // Role distribution
    const { rows: roleDistribution } = await pool.query(`
      SELECT user_role as role, COUNT(DISTINCT user_email) as count
      FROM portal_user_activity
      WHERE occurred_at >= NOW() - INTERVAL '${days} days'
      GROUP BY user_role
      ORDER BY count DESC
    `);

    // Peak hours
    const { rows: peakHours } = await pool.query(`
      SELECT EXTRACT(HOUR FROM occurred_at)::int as hour, COUNT(*) as count
      FROM portal_user_activity
      WHERE occurred_at >= NOW() - INTERVAL '${days} days'
      GROUP BY 1
      ORDER BY 1
    `);

    // Users list with role and last seen
    const { rows: usersList } = await pool.query(`
      SELECT
        user_email as email,
        MAX(user_name) as name,
        MAX(user_role) as role,
        MAX(occurred_at) as last_seen,
        COUNT(*) as total_events
      FROM portal_user_activity
      WHERE occurred_at >= NOW() - INTERVAL '${days} days'
      GROUP BY user_email
      ORDER BY last_seen DESC
    `);

    const kpi = kpiRows[0];
    const trends = {
      totalUsers: calculateTrend(Number(kpi.total_users), Number(kpi.prev_total_users)),
      activeUsers7d: calculateTrend(Number(kpi.active_users_7d), Number(kpi.prev_active_users_7d)),
      activeUsers30d: calculateTrend(Number(kpi.active_users_30d), Number(kpi.prev_active_users_30d)),
      totalTickets: calculateTrend(Number(kpi.total_tickets), Number(kpi.prev_total_tickets)),
      totalAccessRequests: calculateTrend(Number(kpi.total_access_requests), Number(kpi.prev_total_access_requests)),
      totalInfraRequests: calculateTrend(Number(kpi.total_infra_requests), Number(kpi.prev_total_infra_requests)),
    };

    return NextResponse.json({
      period: { days, from: from.toISOString(), to: to.toISOString() },
      data: {
        kpis: {
          totalUsers: Number(kpi.total_users),
          activeUsers7d: Number(kpi.active_users_7d),
          activeUsers30d: Number(kpi.active_users_30d),
          totalTickets: Number(kpi.total_tickets),
          totalAccessRequests: Number(kpi.total_access_requests),
          totalInfraRequests: Number(kpi.total_infra_requests),
        },
        trends,
        weeklyActiveUsers: weeklyActiveUsers.map(r => ({ week: r.week, count: Number(r.count) })),
        roleDistribution: roleDistribution.map(r => ({ role: r.role, count: Number(r.count) })),
        peakHours: peakHours.map(r => ({ hour: Number(r.hour), count: Number(r.count) })),
        usersList: usersList.map(r => ({
          email: r.email,
          name: r.name || r.email,
          role: r.role || "unknown",
          lastSeen: r.last_seen,
          totalEvents: Number(r.total_events),
        })),
      },
    });
  } catch (error) {
    console.error("[admin/analytics/overview] Query failed:", error);
    return NextResponse.json({ error: "Failed to fetch analytics" }, { status: 500 });
  }
}
