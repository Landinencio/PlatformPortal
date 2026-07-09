import { NextResponse } from "next/server";

import { getDoraCoreDashboard, parseDashboardFilters, trendMetricOrZero } from "@/lib/metrics-dashboard";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filters = parseDashboardFilters(searchParams);
    const dora = await getDoraCoreDashboard(filters, { includeClusterSignals: false });

    const leadTime = trendMetricOrZero(dora.summary.leadTimeForChanges);
    const sortedLeadTimes = dora.trend
      .map((row) => row.leadTimeHours)
      .filter((value) => Number.isFinite(value) && value >= 0)
      .sort((left, right) => left - right);
    const p50 = sortedLeadTimes[Math.floor(sortedLeadTimes.length * 0.5)] || 0;
    const p90 = sortedLeadTimes[Math.floor(sortedLeadTimes.length * 0.9)] || 0;

    return NextResponse.json({
      current: parseFloat(leadTime.current.toFixed(2)),
      average: parseFloat(leadTime.current.toFixed(2)),
      currentMr: parseFloat(dora.summary.leadTimeFromMr.current.toFixed(2)),
      averageMr: parseFloat(dora.summary.leadTimeFromMr.current.toFixed(2)),
      changeMr: parseFloat(dora.summary.leadTimeFromMr.change.toFixed(2)),
      p50: parseFloat(p50.toFixed(2)),
      p90: parseFloat(p90.toFixed(2)),
      trend: dora.trend.map((row) => ({
        date: row.date,
        value: parseFloat(row.leadTimeHours.toFixed(2)),
        valueMr: parseFloat(row.leadTimeMrHours.toFixed(2)),
        count: Math.round(row.deployments),
        countMr: Math.round(row.deployments),
      })),
      change: parseFloat(leadTime.change.toFixed(2)),
      totals: {
        leadTimeCount: Math.round(dora.summary.methodology.samples.leadTimeFromLastCommit),
        leadTimeMrCount: Math.round(dora.summary.methodology.samples.leadTimeFromMr),
      },
      meta: {
        daysRequested: dora.meta.daysRequested,
        daysWithData: dora.meta.daysWithData,
        latestSnapshot: dora.meta.latestSnapshot,
        filters: { teams: filters.teams, projectIds: filters.projectIds },
      },
    });
  } catch (error) {
    console.error("Lead time error:", error);
    return NextResponse.json({ error: "Failed to fetch lead time" }, { status: 500 });
  }
}
