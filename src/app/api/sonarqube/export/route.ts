import { NextResponse } from 'next/server';
import { sonarQubeClient } from '@/lib/sonarqube';
import pool from '@/lib/db';
import { format, subDays } from 'date-fns';

export const dynamic = 'force-dynamic';

// GET: Export SonarQube metrics for multiple projects
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const projectKeys = searchParams.get('projectKeys')?.split(',') || [];
        const days = parseInt(searchParams.get('days') || '30');

        if (projectKeys.length === 0) {
            return NextResponse.json(
                { error: 'At least one projectKey is required' },
                { status: 400 }
            );
        }

        const endDate = new Date();
        const startDate = subDays(endDate, days);

        // Get current metrics from SonarQube API for all projects
        const projectsData = await Promise.all(
            projectKeys.map(async (key) => {
                try {
                    const metrics = await sonarQubeClient.getProjectMetrics(key);
                    const qualityGate = await sonarQubeClient.getQualityGateStatus(key);
                    
                    // Get historical data
                    const historicalResult = await pool.query(
                        `SELECT snapshot_date, coverage, bugs, vulnerabilities, code_smells, tech_debt_minutes, quality_gate_status
                         FROM sonarqube_metrics_daily
                         WHERE sonar_project_key = $1 AND snapshot_date >= $2 AND snapshot_date <= $3
                         ORDER BY snapshot_date DESC
                         LIMIT 1`,
                        [key, format(startDate, 'yyyy-MM-dd'), format(endDate, 'yyyy-MM-dd')]
                    );

                    const historical = historicalResult.rows[0];

                    return {
                        projectKey: key,
                        current: metrics,
                        qualityGate,
                        historical,
                        trends: {
                            coverageChange: historical ? (metrics?.coverage || 0) - (historical.coverage || 0) : 0,
                            bugsChange: historical ? (metrics?.bugs || 0) - (historical.bugs || 0) : 0,
                            vulnerabilitiesChange: historical ? (metrics?.vulnerabilities || 0) - (historical.vulnerabilities || 0) : 0,
                        }
                    };
                } catch (error) {
                    console.error(`Error fetching metrics for ${key}:`, error);
                    return {
                        projectKey: key,
                        error: 'Failed to fetch metrics',
                    };
                }
            })
        );

        return NextResponse.json({
            projects: projectsData,
            meta: {
                totalProjects: projectKeys.length,
                daysRequested: days,
                exportDate: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
            },
        });
    } catch (error) {
        console.error('Error exporting SonarQube metrics:', error);
        return NextResponse.json(
            { error: 'Failed to export SonarQube metrics' },
            { status: 500 }
        );
    }
}
