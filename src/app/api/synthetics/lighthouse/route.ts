/**
 * GET /api/synthetics/lighthouse
 * Returns Lighthouse audit data for the dashboard.
 * 
 * Query params:
 *   monitorId — filter by specific monitor (optional)
 *   days — how many days of history (default 90)
 */

import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";

export async function GET(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const monitorId = searchParams.get("monitorId");
  const days = Math.min(365, Math.max(7, parseInt(searchParams.get("days") || "90", 10)));

  try {
    // Summary per site per scan date
    const summaryQuery = monitorId
      ? `SELECT ls.*, sm.name as site_name, sm.url as site_url
         FROM lighthouse_summary ls
         JOIN synthetic_monitors sm ON sm.id = ls.monitor_id
         WHERE ls.monitor_id = $1 AND ls.scan_date >= NOW() - INTERVAL '${days} days'
         ORDER BY ls.scan_date DESC`
      : `SELECT ls.*, sm.name as site_name, sm.url as site_url
         FROM lighthouse_summary ls
         JOIN synthetic_monitors sm ON sm.id = ls.monitor_id
         WHERE ls.scan_date >= NOW() - INTERVAL '${days} days'
         ORDER BY ls.scan_date DESC`;

    const summaryParams = monitorId ? [parseInt(monitorId, 10)] : [];
    const { rows: summary } = await pool.query(summaryQuery, summaryParams);

    // Latest scan details (routes) per site
    const latestQuery = monitorId
      ? `SELECT la.*, sm.name as site_name
         FROM lighthouse_audits la
         JOIN synthetic_monitors sm ON sm.id = la.monitor_id
         WHERE la.monitor_id = $1
           AND la.scan_date = (SELECT MAX(scan_date) FROM lighthouse_audits WHERE monitor_id = $1)
         ORDER BY la.score_performance ASC NULLS LAST`
      : `WITH latest_dates AS (
           SELECT monitor_id, MAX(scan_date) as max_date
           FROM lighthouse_audits
           WHERE scan_date >= NOW() - INTERVAL '${days} days'
           GROUP BY monitor_id
         )
         SELECT la.*, sm.name as site_name
         FROM lighthouse_audits la
         JOIN synthetic_monitors sm ON sm.id = la.monitor_id
         JOIN latest_dates ld ON ld.monitor_id = la.monitor_id AND ld.max_date = la.scan_date
         ORDER BY la.monitor_id, la.score_performance ASC NULLS LAST`;

    const latestParams = monitorId ? [parseInt(monitorId, 10)] : [];
    const { rows: latestRoutes } = await pool.query(latestQuery, latestParams);

    // Available sites
    const { rows: sites } = await pool.query(
      `SELECT DISTINCT sm.id, sm.name, sm.url
       FROM synthetic_monitors sm
       JOIN lighthouse_audits la ON la.monitor_id = sm.id
       ORDER BY sm.name`
    );

    // Latest scores grouped by page_type (one row per (monitor, scan_date, page_type))
    const byTypeQuery = monitorId
      ? `SELECT lst.*, sm.name as site_name
         FROM lighthouse_summary_by_type lst
         JOIN synthetic_monitors sm ON sm.id = lst.monitor_id
         WHERE lst.monitor_id = $1 AND lst.scan_date >= NOW() - INTERVAL '${days} days'
         ORDER BY lst.scan_date DESC, lst.page_type ASC`
      : `SELECT lst.*, sm.name as site_name
         FROM lighthouse_summary_by_type lst
         JOIN synthetic_monitors sm ON sm.id = lst.monitor_id
         WHERE lst.scan_date >= NOW() - INTERVAL '${days} days'
         ORDER BY lst.scan_date DESC, lst.page_type ASC`;
    const byTypeParams = monitorId ? [parseInt(monitorId, 10)] : [];
    const { rows: byType } = await pool.query(byTypeQuery, byTypeParams);

    return NextResponse.json({
      sites,
      summary: summary.map((r) => ({
        monitorId: r.monitor_id,
        siteName: r.site_name,
        siteUrl: r.site_url,
        scanDate: r.scan_date,
        totalRoutes: Number(r.total_routes),
        avgPerformance: Number(r.avg_performance),
        avgAccessibility: Number(r.avg_accessibility),
        avgBestPractices: Number(r.avg_best_practices),
        avgSeo: Number(r.avg_seo),
        avgLcpMs: Number(r.avg_lcp_ms),
        avgCls: Number(r.avg_cls),
        avgTbtMs: Number(r.avg_tbt_ms),
      })),
      byType: byType.map((r) => ({
        monitorId: r.monitor_id,
        siteName: r.site_name,
        scanDate: r.scan_date,
        pageType: r.page_type,
        routes: Number(r.routes),
        avgPerformance: Number(r.avg_performance),
        avgAccessibility: Number(r.avg_accessibility),
        avgBestPractices: Number(r.avg_best_practices),
        avgSeo: Number(r.avg_seo),
        avgLcpMs: Number(r.avg_lcp_ms),
        avgCls: r.avg_cls !== null ? Number(r.avg_cls) : null,
        avgTbtMs: Number(r.avg_tbt_ms),
      })),
      latestRoutes: latestRoutes.map((r) => ({
        monitorId: r.monitor_id,
        siteName: r.site_name,
        route: r.route,
        pageType: r.page_type,
        scanDate: r.scan_date,
        performance: r.score_performance,
        accessibility: r.score_accessibility,
        bestPractices: r.score_best_practices,
        seo: r.score_seo,
        lcpMs: r.lcp_ms,
        cls: r.cls ? Number(r.cls) : null,
        tbtMs: r.tbt_ms,
        fcpMs: r.fcp_ms,
        siMs: r.si_ms,
        ttfbMs: r.ttfb_ms,
        pageSizeKb: r.page_size_kb,
        requestCount: r.request_count,
        pageTitle: r.page_title,
        opportunities: r.opportunities || [],
        diagnostics: r.diagnostics || [],
      })),
    });
  } catch (error) {
    console.error("[synthetics/lighthouse] Query failed:", error);
    return NextResponse.json({ error: "Failed to fetch lighthouse data" }, { status: 500 });
  }
}
