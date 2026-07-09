import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
import pool from '@/lib/db';
import { subDays, format } from 'date-fns';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const team = searchParams.get('team') || 'all';
        const days = parseInt(searchParams.get('days') || '30');
        const projectId = searchParams.get('projectId');
        const projectName = searchParams.get('project');

        const endDate = new Date();
        const startDate = subDays(endDate, days);

        // Get historical code quality from PostgreSQL
        // IMPORTANT: Only include projects with actual SonarQube data (coverage > 0)
        // This excludes libraries and projects without CI/CD pipelines
        let query = `
      SELECT 
        snapshot_date,
        AVG(CASE WHEN coverage > 0 THEN coverage ELSE NULL END) as avg_coverage,
        COUNT(CASE WHEN coverage > 0 THEN 1 END) as projects_with_coverage,
        COUNT(*) as total_projects,
        SUM(bugs) as total_bugs,
        SUM(vulnerabilities) as total_vulnerabilities,
        SUM(code_smells) as total_code_smells,
        SUM(tech_debt_minutes) as total_tech_debt
      FROM dora_metrics_daily
      WHERE snapshot_date >= $1 AND snapshot_date <= $2
    `;
        const params: any[] = [format(startDate, 'yyyy-MM-dd'), format(endDate, 'yyyy-MM-dd')];

        if (team !== 'all') {
            query += ` AND team = $3`;
            params.push(team);
        }

        if (projectId) {
            query += ` AND project_id = $${params.length + 1}`;
            params.push(parseInt(projectId));
        } else if (projectName) {
            query += ` AND project_name = $${params.length + 1}`;
            params.push(projectName);
        }

        query += ` GROUP BY snapshot_date ORDER BY snapshot_date ASC`;

        const result = await pool.query(query, params);

        // Calculate current values (last data point)
        const latestData = result.rows[result.rows.length - 1] || {};
        const coverage = parseFloat(latestData.avg_coverage || 0);
        const techDebtHours = parseInt(latestData.total_tech_debt || 0) / 60;

        return NextResponse.json({
            coverage: parseFloat(coverage.toFixed(2)),
            projects_with_data: parseInt(latestData.projects_with_coverage || 0),
            total_projects: parseInt(latestData.total_projects || 0),
            bugs: parseInt(latestData.total_bugs || 0),
            vulnerabilities: parseInt(latestData.total_vulnerabilities || 0),
            code_smells: parseInt(latestData.total_code_smells || 0),
            tech_debt_hours: parseFloat(techDebtHours.toFixed(2)),
            trend: result.rows.map((row: any) => ({
                date: row.snapshot_date,
                coverage: parseFloat(row.avg_coverage || 0),
                bugs: parseInt(row.total_bugs || 0),
                vulnerabilities: parseInt(row.total_vulnerabilities || 0),
                code_smells: parseInt(row.total_code_smells || 0),
            })),
            meta: {
                daysRequested: days,
                daysWithData: result.rows.length,
                latestSnapshot: latestData.snapshot_date || null,
            },
        });
    } catch (error) {
        console.error('Code quality error:', error);
        return NextResponse.json(
            { error: 'Failed to fetch code quality metrics' },
            { status: 500 }
        );
    }
}
