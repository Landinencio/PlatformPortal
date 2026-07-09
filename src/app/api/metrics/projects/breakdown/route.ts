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

        const params: any[] = [format(startDate, 'yyyy-MM-dd'), format(endDate, 'yyyy-MM-dd')];
        let windowedWhere = 'snapshot_date >= $1 AND snapshot_date <= $2';

        if (team !== 'all') {
            windowedWhere += ` AND team = $${params.length + 1}`;
            params.push(team);
        }

        let query = `
            WITH windowed AS (
                SELECT *
                FROM dora_metrics_daily
                WHERE ${windowedWhere}
            ),
            dora_agg AS (
                SELECT
                    project_id,
                    project_name,
                    project_path,
                    SUM(deployment_count)::float / GREATEST(COUNT(DISTINCT snapshot_date), 1) as deployment_frequency,
                    CASE WHEN SUM(lead_time_count) > 0 THEN SUM(lead_time_sum_hours) / SUM(lead_time_count) ELSE NULL END as lead_time_hours,
                    CASE 
                        WHEN (SUM(deployment_count) + SUM(deployment_failures)) > 0 
                        THEN (SUM(deployment_failures)::float / (SUM(deployment_count) + SUM(deployment_failures))) * 100 
                        ELSE 0 
                    END as change_failure_rate,
                    CASE WHEN SUM(mttr_count) > 0 THEN SUM(mttr_sum_hours) / SUM(mttr_count) ELSE NULL END as mttr_hours
                FROM windowed
                GROUP BY project_id, project_name, project_path
            ),
            latest_quality AS (
                SELECT DISTINCT ON (project_id)
                    project_id,
                    coverage,
                    bugs,
                    vulnerabilities,
                    code_smells,
                    tech_debt_minutes
                FROM windowed
                ORDER BY project_id, snapshot_date DESC
            )
            SELECT
                dora_agg.project_id,
                dora_agg.project_name,
                dora_agg.project_path,
                dora_agg.deployment_frequency,
                dora_agg.lead_time_hours,
                dora_agg.change_failure_rate,
                dora_agg.mttr_hours,
                latest_quality.coverage,
                latest_quality.bugs,
                latest_quality.vulnerabilities,
                latest_quality.code_smells,
                latest_quality.tech_debt_minutes
            FROM dora_agg
            LEFT JOIN latest_quality ON latest_quality.project_id = dora_agg.project_id
        `;

        if (projectId) {
            query += ` WHERE dora_agg.project_id = $${params.length + 1}`;
            params.push(parseInt(projectId));
        } else if (projectName) {
            query += ` WHERE dora_agg.project_name = $${params.length + 1}`;
            params.push(projectName);
        }

        query += `
            ORDER BY coverage DESC NULLS LAST
            LIMIT 50
        `;

        const result = await pool.query(query, params);

        return NextResponse.json({
            projects: result.rows.map((row: any) => ({
                id: row.project_id,
                name: row.project_name,
                path: row.project_path,
                deployment_frequency: parseFloat(row.deployment_frequency || 0),
                lead_time_hours: row.lead_time_hours ? parseFloat(row.lead_time_hours) : null,
                change_failure_rate: parseFloat(row.change_failure_rate || 0),
                mttr_hours: row.mttr_hours ? parseFloat(row.mttr_hours) : null,
                coverage: row.coverage ? parseFloat(row.coverage) : 0,
                bugs: parseInt(row.bugs || 0),
                vulnerabilities: parseInt(row.vulnerabilities || 0),
                code_smells: parseInt(row.code_smells || 0),
                tech_debt_hours: Math.round((parseInt(row.tech_debt_minutes || 0) / 60) * 10) / 10,
            })),
        });
    } catch (error) {
        console.error('Project breakdown error:', error);
        return NextResponse.json(
            { error: 'Failed to fetch project breakdown' },
            { status: 500 }
        );
    }
}
