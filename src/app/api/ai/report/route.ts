import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { bedrockClient } from '@/lib/bedrock';
import pool from '@/lib/db';
import { subDays, format } from 'date-fns';
import { parseMetricFilters, buildWhereClause } from '@/lib/query-filters';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const body = await request.json();
    const { period = 'weekly', teams = [], days = 7 } = body;

    const endDate = new Date();
    const startDate = subDays(endDate, days);

    const filters = { teams, projectIds: [], developers: [], days };
    const baseParams = [format(startDate, 'yyyy-MM-dd'), format(endDate, 'yyyy-MM-dd')];
    const { clause: filterClause, params: filterParams } = buildWhereClause(filters, 3);

    // Aggregate metrics for the period
    const query = `
      SELECT 
        SUM(deployment_count) as total_deploys,
        SUM(deployment_failures) as total_failures,
        AVG(CASE WHEN lead_time_count > 0 THEN lead_time_sum_hours / lead_time_count ELSE 0 END) as avg_lead_time,
        AVG(CASE WHEN mttr_count > 0 THEN mttr_sum_hours / mttr_count ELSE 0 END) as avg_mttr,
        SUM(CASE WHEN deployment_count + deployment_failures > 0 
          THEN deployment_failures::float / (deployment_count + deployment_failures) * 100 
          ELSE 0 END) / COUNT(*) as avg_cfr,
        COUNT(DISTINCT project_id) as project_count,
        COUNT(DISTINCT developer_email) as developer_count
      FROM dora_metrics_daily d
      LEFT JOIN developer_activity_daily da ON d.snapshot_date = da.snapshot_date AND d.project_id = da.project_id
      WHERE d.snapshot_date >= $1 AND d.snapshot_date <= $2
      ${filterClause}
    `;

    const result = await pool.query(query, [...baseParams, ...filterParams]);
    const row = result.rows[0];

    const metrics = {
      totalDeploys: parseInt(row.total_deploys || '0'),
      incidents: parseInt(row.total_failures || '0'),
      leadTime: parseFloat(row.avg_lead_time || '0'),
      leadTimeChange: 0, // Would need previous period comparison
      cfr: parseFloat(row.avg_cfr || '0'),
      mttr: parseFloat(row.avg_mttr || '0'),
      projectCount: parseInt(row.project_count || '0'),
      developerCount: parseInt(row.developer_count || '0'),
    };

    const report = await bedrockClient.generateReport(
      `${format(startDate, 'MMM dd')} - ${format(endDate, 'MMM dd, yyyy')}`,
      teams.length > 0 ? teams : ['All Teams'],
      metrics
    );

    return NextResponse.json({
      report,
      format: 'markdown',
      period: {
        start: format(startDate, 'yyyy-MM-dd'),
        end: format(endDate, 'yyyy-MM-dd'),
        days,
      },
      teams: teams.length > 0 ? teams : ['All Teams'],
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Report generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate report', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
