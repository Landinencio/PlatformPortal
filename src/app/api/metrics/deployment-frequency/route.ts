import { NextResponse } from "next/server";

import { getDoraCoreDashboard, parseDashboardFilters } from "@/lib/metrics-dashboard";

export const dynamic = "force-dynamic";

/** Round to 2 decimals, preserving null (days without snapshot data). */
function round2(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return parseFloat(value.toFixed(2));
}

/** Round to integer, preserving null (days without snapshot data). */
function roundInt(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.round(value);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filters = parseDashboardFilters(searchParams);
    const dora = await getDoraCoreDashboard(filters, { includeClusterSignals: false });

    const daysWithData = dora.trend.length;
    const deployments = dora.summary.totals.deployments ?? 0;
    const perDay = daysWithData > 0 ? deployments / daysWithData : 0;

    return NextResponse.json({
      current: round2(dora.summary.deploymentFrequency.current) ?? 0,
      per_day: round2(perDay) ?? 0,
      trend: dora.trend.map((row) => ({
        date: row.date,
        value: round2(row.deploymentFrequency),
        deployments: roundInt(row.deployments),
        uniqueDeployments: roundInt(row.uniqueDeployments),
        rollbacks: roundInt(row.rollbacks),
        hotfixes: roundInt(row.hotfixes),
        features: roundInt(row.features),
        projects: roundInt(row.projects),
      })),
      change: round2(dora.summary.deploymentFrequency.change) ?? 0,
      projectCount: dora.trend.length > 0 ? (roundInt(dora.trend[dora.trend.length - 1].projects) ?? 0) : 0,
      totals: {
        deployments: roundInt(dora.summary.totals.deployments) ?? 0,
        uniqueDeployments: roundInt(dora.summary.totals.uniqueDeployments) ?? 0,
        rollbacks: roundInt(dora.summary.totals.rollbacks) ?? 0,
        hotfixes: roundInt(dora.summary.totals.hotfixes) ?? 0,
        features: roundInt(dora.summary.totals.features) ?? 0,
        projectDays: roundInt(dora.trend.reduce((total, row) => total + (row.projects ?? 0), 0)) ?? 0,
      },
      meta: {
        daysRequested: dora.meta.daysRequested,
        daysWithData: dora.meta.daysWithData,
        latestSnapshot: dora.meta.latestSnapshot,
        filters: { teams: filters.teams, projectIds: filters.projectIds },
      },
    });
  } catch (error) {
    console.error("Deployment frequency error:", error);
    return NextResponse.json({ error: "Failed to fetch deployment frequency" }, { status: 500 });
  }
}
