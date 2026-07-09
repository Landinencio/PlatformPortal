import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { bedrockClient } from '@/lib/bedrock';
import pool from '@/lib/db';
import { subDays, format } from 'date-fns';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const body = await request.json();
    const { projectId, mrIid, commitSha } = body;

    if (!projectId) {
      return NextResponse.json(
        { error: 'projectId is required' },
        { status: 400 }
      );
    }

    // Get project info
    const projectQuery = `
      SELECT DISTINCT project_name
      FROM dora_metrics_daily
      WHERE project_id = $1
      LIMIT 1
    `;
    const projectResult = await pool.query(projectQuery, [projectId]);
    const projectName = projectResult.rows[0]?.project_name || `Project ${projectId}`;

    // Get recent failures for this project
    const failuresQuery = `
      SELECT SUM(deployment_failures) as total_failures
      FROM dora_metrics_daily
      WHERE project_id = $1
        AND snapshot_date >= $2
    `;
    const thirtyDaysAgo = format(subDays(new Date(), 30), 'yyyy-MM-dd');
    const failuresResult = await pool.query(failuresQuery, [projectId, thirtyDaysAgo]);
    const recentFailures = parseInt(failuresResult.rows[0]?.total_failures || '0');

    // Get average coverage (if available from SonarQube)
    const coverageQuery = `
      SELECT AVG(coverage) as avg_coverage
      FROM dora_metrics_daily
      WHERE project_id = $1
        AND snapshot_date >= $2
        AND coverage > 0
    `;
    const coverageResult = await pool.query(coverageQuery, [projectId, thirtyDaysAgo]);
    const coverage = parseFloat(coverageResult.rows[0]?.avg_coverage || '0');

    // Mock MR data (in real scenario, fetch from GitLab API)
    const deployment = {
      projectId,
      projectName,
      mrIid: mrIid || 0,
      commitSha: commitSha || 'unknown',
      changes: {
        additions: Math.floor(Math.random() * 500) + 50,
        deletions: Math.floor(Math.random() * 200) + 20,
      },
      coverage: coverage > 0 ? coverage : undefined,
      reviewers: Math.floor(Math.random() * 3) + 1,
      recentFailures,
    };

    const riskAssessment = await bedrockClient.assessRisk(deployment);

    return NextResponse.json({
      ...riskAssessment,
      deployment: {
        projectId,
        projectName,
        mrIid,
        commitSha,
      },
      assessedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Risk assessment error:', error);
    return NextResponse.json(
      { error: 'Failed to assess risk', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
