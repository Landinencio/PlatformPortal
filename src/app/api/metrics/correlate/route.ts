import { NextResponse } from "next/server";
import { correlateDeployments, correlateDeploymentsRange } from "@/lib/deployment-correlation";
import { subDays, parseISO } from "date-fns";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes

/**
 * POST /api/metrics/correlate
 * 
 * Correlates GitLab deploys with ArgoCD syncs
 * 
 * Query params:
 * - date: specific date (YYYY-MM-DD) - defaults to yesterday
 * - days: number of days to correlate (1-30) - overrides date param
 * 
 * Examples:
 * - POST /api/metrics/correlate (correlate yesterday)
 * - POST /api/metrics/correlate?date=2026-03-02 (specific date)
 * - POST /api/metrics/correlate?days=7 (last 7 days)
 */
export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const dateParam = searchParams.get("date");
    const daysParam = searchParams.get("days");
    
    // Multi-day correlation
    if (daysParam) {
      const days = Math.min(Math.max(parseInt(daysParam), 1), 30);
      console.log(`Starting correlation for last ${days} days...`);
      
      const result = await correlateDeploymentsRange(days);
      
      const summary = {
        totalGitLabDeploys: result.results.reduce((sum, r) => sum + r.gitlabDeploys, 0),
        totalArgocdSyncs: result.results.reduce((sum, r) => sum + r.argocdSyncs, 0),
        totalCorrelations: result.results.reduce((sum, r) => sum + r.correlations, 0),
        totalHighConfidence: result.results.reduce((sum, r) => sum + r.highConfidence, 0),
        totalMediumConfidence: result.results.reduce((sum, r) => sum + r.mediumConfidence, 0),
        totalLowConfidence: result.results.reduce((sum, r) => sum + r.lowConfidence, 0),
        totalUncorrelated: result.results.reduce((sum, r) => sum + r.uncorrelated, 0),
      };
      
      return NextResponse.json({
        success: result.success,
        days: result.totalDays,
        summary,
        details: result.results,
      });
    }
    
    // Single day correlation
    const date = dateParam 
      ? parseISO(dateParam)
      : subDays(new Date(), 1);
    
    console.log(`Starting correlation for ${date.toISOString().split("T")[0]}...`);
    
    const result = await correlateDeployments(date);
    
    return NextResponse.json(result);
  } catch (error) {
    console.error("Correlation error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to correlate deployments",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/metrics/correlate
 * 
 * Get correlation statistics
 * 
 * Query params:
 * - days: number of days to analyze (default: 7)
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Math.min(Math.max(parseInt(searchParams.get("days") || "7"), 1), 90);
    
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    
    const result = await pool.query(`
      SELECT 
        correlation_date,
        COUNT(*) as total_correlations,
        COUNT(*) FILTER (WHERE correlation_confidence >= 0.8) as high_confidence,
        COUNT(*) FILTER (WHERE correlation_confidence >= 0.5 AND correlation_confidence < 0.8) as medium_confidence,
        COUNT(*) FILTER (WHERE correlation_confidence < 0.5) as low_confidence,
        AVG(correlation_confidence) as avg_confidence,
        AVG(time_diff_minutes) as avg_time_diff_minutes,
        COUNT(DISTINCT gitlab_project_id) as unique_projects,
        COUNT(DISTINCT argocd_app_name) as unique_apps,
        COUNT(*) FILTER (WHERE correlation_method = 'repo-match') as repo_matches,
        COUNT(*) FILTER (WHERE correlation_method = 'workload-mapping') as workload_matches,
        COUNT(*) FILTER (WHERE correlation_method = 'name-match') as name_matches,
        COUNT(*) FILTER (WHERE correlation_method = 'timestamp-proximity') as timestamp_matches
      FROM deployment_correlation
      WHERE correlation_date >= CURRENT_DATE - $1::int
      GROUP BY correlation_date
      ORDER BY correlation_date DESC
    `, [days]);
    
    await pool.end();
    
    const summary = {
      totalCorrelations: result.rows.reduce((sum, row) => sum + Number(row.total_correlations), 0),
      avgConfidence: result.rows.length > 0
        ? result.rows.reduce((sum, row) => sum + Number(row.avg_confidence), 0) / result.rows.length
        : 0,
      avgTimeDiff: result.rows.length > 0
        ? result.rows.reduce((sum, row) => sum + Number(row.avg_time_diff_minutes), 0) / result.rows.length
        : 0,
      uniqueProjects: Math.max(...result.rows.map(row => Number(row.unique_projects)), 0),
      uniqueApps: Math.max(...result.rows.map(row => Number(row.unique_apps)), 0),
      repoMatches: result.rows.reduce((sum, row) => sum + Number(row.repo_matches || 0), 0),
      workloadMatches: result.rows.reduce((sum, row) => sum + Number(row.workload_matches || 0), 0),
      nameMatches: result.rows.reduce((sum, row) => sum + Number(row.name_matches || 0), 0),
      timestampMatches: result.rows.reduce((sum, row) => sum + Number(row.timestamp_matches || 0), 0),
    };
    
    return NextResponse.json({
      success: true,
      days,
      summary,
      daily: result.rows,
    });
  } catch (error) {
    console.error("Failed to get correlation stats:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to get correlation statistics",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
