import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { bedrockClient } from '@/lib/bedrock';
import pool from '@/lib/db';
import { subDays, format } from 'date-fns';
import { parseMetricFilters, buildWhereClause } from '@/lib/query-filters';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const filters = parseMetricFilters(searchParams);

    const endDate = new Date();
    const startDate = subDays(endDate, filters.days);

    const baseParams = [format(startDate, 'yyyy-MM-dd'), format(endDate, 'yyyy-MM-dd')];
    const { clause: filterClause, params: filterParams } = buildWhereClause(filters, 3);

    // Get time series data for anomaly detection
    const query = `
      SELECT 
        snapshot_date,
        SUM(deployment_count) as deployments,
        SUM(deployment_failures) as failures,
        AVG(CASE WHEN lead_time_count > 0 THEN lead_time_sum_hours / lead_time_count ELSE 0 END) as avg_lead_time,
        AVG(CASE WHEN mttr_count > 0 THEN mttr_sum_hours / mttr_count ELSE 0 END) as avg_mttr,
        SUM(CASE WHEN deployment_count + deployment_failures > 0 
          THEN deployment_failures::float / (deployment_count + deployment_failures) * 100 
          ELSE 0 END) as cfr,
        array_agg(DISTINCT project_name) as projects
      FROM dora_metrics_daily
      WHERE snapshot_date >= $1 AND snapshot_date <= $2
      ${filterClause}
      GROUP BY snapshot_date
      ORDER BY snapshot_date ASC
    `;

    const result = await pool.query(query, [...baseParams, ...filterParams]);

    const metrics = result.rows.map((row: any) => ({
      date: row.snapshot_date,
      deployments: parseFloat(row.deployments || 0),
      failures: parseFloat(row.failures || 0),
      leadTime: parseFloat(row.avg_lead_time || 0),
      mttr: parseFloat(row.avg_mttr || 0),
      cfr: parseFloat(row.cfr || 0),
      projects: row.projects || [],
    }));

    const context = {
      team: filters.teams.length > 0 ? filters.teams[0] : undefined,
      projects: [...new Set(metrics.flatMap((m: any) => m.projects))],
      period: `${filters.days} días`,
    };

    const anomalies = await bedrockClient.detectAnomalies(metrics, context);

    return NextResponse.json({
      anomalies,
      detectedAt: new Date().toISOString(),
      context,
      dataPoints: metrics.length,
    });
  } catch (error) {
    console.error('Anomaly detection error:', error);
    return NextResponse.json(
      { error: 'Failed to detect anomalies', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
