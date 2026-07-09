import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
import { getDoraCoreDashboard, parseDashboardFilters, trendMetricOrZero } from '@/lib/metrics-dashboard';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filters = parseDashboardFilters(searchParams);
    const dora = await getDoraCoreDashboard(filters, { includeClusterSignals: false });
    const toNumber = (value: unknown) => {
      const parsed = Number(value ?? 0);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const mttr = trendMetricOrZero(dora.summary.mttr);
    const mttrSource = dora.summary.reliabilitySignals.mttrSource;
    const incidentsTotal = dora.trend.reduce((sum, row) => {
      const rowSource = row.mttrSource || mttrSource;
      const incidents = rowSource === 'hybrid'
        ? toNumber(row.runtimeMttrIncidents)
        : toNumber(row.gitlabMttrIncidents);
      return sum + incidents;
    }, 0);

    return NextResponse.json({
      current: Number(mttr.current.toFixed(2)),
      mttr_hours: Number(mttr.current.toFixed(2)),
      incidents: Math.round(incidentsTotal),
      trend: dora.trend.map((row) => {
        const rowSource = row.mttrSource || mttrSource;
        const incidents = rowSource === 'hybrid'
          ? Math.round(toNumber(row.runtimeMttrIncidents))
          : Math.round(toNumber(row.gitlabMttrIncidents));
        return {
          date: row.date,
          value: Number(toNumber(row.mttrHours).toFixed(2)),
          incidents,
          source: rowSource,
          coveragePct: Number(toNumber(row.correlationCoverage).toFixed(1)),
          confidence: Number((toNumber(row.correlationConfidence) * 100).toFixed(1)),
        };
      }),
      change: Number(mttr.change.toFixed(2)),
      totals: { incidents: Math.round(incidentsTotal) },
      meta: {
        daysRequested: dora.meta.daysRequested,
        daysWithData: dora.meta.daysWithData,
        latestSnapshot: dora.meta.latestSnapshot,
        filters: { teams: dora.meta.teams, projectIds: dora.meta.projectIds },
        source: mttrSource,
        reliability: {
          coveragePct: Number(dora.summary.reliabilitySignals.coveragePct.toFixed(1)),
          minCoveragePct: Number(dora.summary.reliabilitySignals.minCoveragePct.toFixed(1)),
          confidenceThreshold: Number((dora.summary.reliabilitySignals.confidenceThreshold * 100).toFixed(1)),
          averageConfidence: Number((dora.summary.reliabilitySignals.averageConfidence * 100).toFixed(1)),
          reason: dora.summary.reliabilitySignals.reason,
        },
      },
    });
  } catch (error) {
    console.error('MTTR error:', error);
    return NextResponse.json({ error: 'Failed to fetch MTTR' }, { status: 500 });
  }
}
