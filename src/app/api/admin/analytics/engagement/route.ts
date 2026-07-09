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
          COUNT(DISTINCT user_email) as unique_users,
          COUNT(DISTINCT portal_session_id) as total_sessions,
          COUNT(*) FILTER (WHERE event_type = 'page_view') as total_page_views,
          ROUND(AVG(duration_seconds) FILTER (WHERE duration_seconds > 0) / 60.0, 1) as avg_session_duration,
          COUNT(*) FILTER (WHERE event_type = 'login') as total_logins
        FROM portal_user_activity
        WHERE occurred_at >= NOW() - INTERVAL '${days} days'
      ),
      previous_period AS (
        SELECT
          COUNT(DISTINCT user_email) as unique_users,
          COUNT(DISTINCT portal_session_id) as total_sessions,
          COUNT(*) FILTER (WHERE event_type = 'page_view') as total_page_views,
          ROUND(AVG(duration_seconds) FILTER (WHERE duration_seconds > 0) / 60.0, 1) as avg_session_duration,
          COUNT(*) FILTER (WHERE event_type = 'login') as total_logins
        FROM portal_user_activity
        WHERE occurred_at >= NOW() - INTERVAL '${days * 2} days'
          AND occurred_at < NOW() - INTERVAL '${days} days'
      )
      SELECT
        c.unique_users, c.total_sessions, c.total_page_views,
        c.avg_session_duration, c.total_logins,
        p.unique_users as prev_unique_users, p.total_sessions as prev_total_sessions,
        p.total_page_views as prev_total_page_views,
        p.avg_session_duration as prev_avg_session_duration,
        p.total_logins as prev_total_logins
      FROM current_period c, previous_period p
    `);

    // Daily active users
    const { rows: dailyActiveUsers } = await pool.query(`
      SELECT
        DATE(occurred_at) as date,
        COUNT(DISTINCT user_email) as count
      FROM portal_user_activity
      WHERE occurred_at >= NOW() - INTERVAL '${days} days'
      GROUP BY 1
      ORDER BY 1
    `);

    // Top paths
    const { rows: topPaths } = await pool.query(`
      SELECT
        path,
        COUNT(*) as views,
        COUNT(DISTINCT user_email) as unique_users
      FROM portal_user_activity
      WHERE occurred_at >= NOW() - INTERVAL '${days} days'
        AND event_type = 'page_view'
        AND path IS NOT NULL
      GROUP BY path
      ORDER BY views DESC
      LIMIT 10
    `);

    // Section views (group by first path segment)
    const { rows: sectionViews } = await pool.query(`
      SELECT
        SPLIT_PART(path, '/', 2) as section,
        COUNT(*) as views
      FROM portal_user_activity
      WHERE occurred_at >= NOW() - INTERVAL '${days} days'
        AND event_type = 'page_view'
        AND path IS NOT NULL
        AND path != '/'
      GROUP BY 1
      ORDER BY views DESC
    `);

    // User ranking - top 20
    const { rows: userRanking } = await pool.query(`
      SELECT
        user_email as email,
        MAX(user_name) as name,
        MAX(user_role) as role,
        COUNT(*) as total_events,
        COUNT(DISTINCT portal_session_id) as session_count,
        COALESCE(ROUND(SUM(duration_seconds)::numeric / 60.0, 1), 0) as total_minutes,
        MAX(occurred_at) as last_seen
      FROM portal_user_activity
      WHERE occurred_at >= NOW() - INTERVAL '${days} days'
      GROUP BY user_email
      ORDER BY total_events DESC
      LIMIT 20
    `);

    // Hourly distribution
    const { rows: hourlyDistribution } = await pool.query(`
      SELECT EXTRACT(HOUR FROM occurred_at)::int as hour, COUNT(*) as count
      FROM portal_user_activity
      WHERE occurred_at >= NOW() - INTERVAL '${days} days'
      GROUP BY 1
      ORDER BY 1
    `);

    const kpi = kpiRows[0];
    const trends = {
      uniqueUsers: calculateTrend(Number(kpi.unique_users), Number(kpi.prev_unique_users)),
      totalSessions: calculateTrend(Number(kpi.total_sessions), Number(kpi.prev_total_sessions)),
      totalPageViews: calculateTrend(Number(kpi.total_page_views), Number(kpi.prev_total_page_views)),
      avgSessionDuration: calculateTrend(Number(kpi.avg_session_duration || 0), Number(kpi.prev_avg_session_duration || 0)),
      totalLogins: calculateTrend(Number(kpi.total_logins), Number(kpi.prev_total_logins)),
    };

    return NextResponse.json({
      period: { days, from: from.toISOString(), to: to.toISOString() },
      data: {
        kpis: {
          uniqueUsers: Number(kpi.unique_users),
          totalSessions: Number(kpi.total_sessions),
          totalPageViews: Number(kpi.total_page_views),
          avgSessionDuration: Number(kpi.avg_session_duration || 0),
          totalLogins: Number(kpi.total_logins),
        },
        trends,
        dailyActiveUsers: dailyActiveUsers.map(r => ({ date: r.date, count: Number(r.count) })),
        topPaths: topPaths.map(r => ({ path: r.path, views: Number(r.views), uniqueUsers: Number(r.unique_users) })),
        sectionViews: sectionViews.map(r => ({ section: r.section, views: Number(r.views) })),
        userRanking: userRanking.map(r => ({
          email: r.email,
          name: r.name || r.email,
          role: r.role,
          totalEvents: Number(r.total_events),
          sessionCount: Number(r.session_count),
          totalMinutes: Number(r.total_minutes),
          lastSeen: r.last_seen,
        })),
        hourlyDistribution: hourlyDistribution.map(r => ({ hour: Number(r.hour), count: Number(r.count) })),
      },
    });
  } catch (error) {
    console.error("[admin/analytics/engagement] Query failed:", error);
    return NextResponse.json({ error: "Failed to fetch analytics" }, { status: 500 });
  }
}
