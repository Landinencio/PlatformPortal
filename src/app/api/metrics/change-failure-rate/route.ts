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

    const cfr = trendMetricOrZero(dora.summary.changeFailureRate);
    const cfrSource = dora.summary.reliabilitySignals.cfrSource;
    const failuresTotal = cfrSource === 'hybrid'
      ? dora.summary.reliabilitySignals.runtimeFailures
      : dora.summary.totals.failures;
    const deploymentsTotal = dora.summary.totals.deployments;
    const attemptsTotal = deploymentsTotal + failuresTotal;
    const latestTrendRow = dora.trend[dora.trend.length - 1];

    return NextResponse.json({
      current: Number(cfr.current.toFixed(2)),
      rate: Number(cfr.current.toFixed(2)),
      trend: dora.trend.map((row) => {
        const rowSource = row.cfrSource || cfrSource;
        const deployments = Math.round(toNumber(row.deployments));
        const failures = rowSource === 'hybrid'
          ? Math.round(toNumber(row.runtimeFailures))
          : Math.round(toNumber(row.gitlabFailures));
        return {
          date: row.date,
          value: Number(toNumber(row.changeFailureRate).toFixed(2)),
          failures,
          deployments,
          attempts: deployments + failures,
          source: rowSource,
          coveragePct: Number(toNumber(row.correlationCoverage).toFixed(1)),
          confidence: Number((toNumber(row.correlationConfidence) * 100).toFixed(1)),
        };
      }),
      change: Number(cfr.change.toFixed(2)),
      projectCount: latestTrendRow ? Math.round(toNumber(latestTrendRow.projects)) : 0,
      totals: {
        failures: Math.round(failuresTotal),
        deployments: Math.round(deploymentsTotal),
        attempts: Math.round(attemptsTotal),
        correlatedDeployments: Math.round(dora.summary.reliabilitySignals.correlatedDeployments),
      },
      meta: {
        daysRequested: dora.meta.daysRequested,
        daysWithData: dora.meta.daysWithData,
        latestSnapshot: dora.meta.latestSnapshot,
        filters: { teams: dora.meta.teams, projectIds: dora.meta.projectIds },
        source: cfrSource,
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
    console.error('Change failure rate error:', error);
    return NextResponse.json({ error: 'Failed to fetch change failure rate' }, { status: 500 });
  }
}
