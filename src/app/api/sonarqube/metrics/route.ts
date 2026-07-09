import { NextResponse } from 'next/server';
import { sonarQubeClient } from '@/lib/sonarqube';
import pool from '@/lib/db';
import { format, subDays } from 'date-fns';

export const dynamic = 'force-dynamic';

// GET: Get metrics for a specific SonarQube project
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const projectKey = searchParams.get('projectKey');
        const days = parseInt(searchParams.get('days') || '30');

        if (!projectKey) {
            return NextResponse.json(
                { error: 'projectKey is required' },
                { status: 400 }
            );
        }

        // Get current metrics from SonarQube API
        const currentMetrics = await sonarQubeClient.getProjectMetrics(projectKey);

        if (!currentMetrics) {
            return NextResponse.json(
                { error: 'Project not found in SonarQube' },
                { status: 404 }
            );
        }

        // Get historical data from our database
        const endDate = new Date();
        const startDate = subDays(endDate, days);

        const historicalResult = await pool.query(
            `SELECT snapshot_date, coverage, bugs, vulnerabilities, code_smells, tech_debt_minutes, quality_gate_status
             FROM sonarqube_metrics_daily
             WHERE sonar_project_key = $1 AND snapshot_date >= $2 AND snapshot_date <= $3
             ORDER BY snapshot_date ASC`,
            [projectKey, format(startDate, 'yyyy-MM-dd'), format(endDate, 'yyyy-MM-dd')]
        );

        return NextResponse.json({
            projectKey,
            current: currentMetrics,
            trend: historicalResult.rows,
            meta: {
                daysRequested: days,
                daysWithData: historicalResult.rows.length,
            },
        });
    } catch (error) {
        console.error('Error fetching SonarQube metrics:', error);
        return NextResponse.json(
            { error: 'Failed to fetch SonarQube metrics' },
            { status: 500 }
        );
    }
}
