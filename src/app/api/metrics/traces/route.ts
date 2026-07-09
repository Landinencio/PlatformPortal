import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { subDays, format } from 'date-fns';

export const dynamic = 'force-dynamic';

// GET: Query deployment traces for full traceability
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const days = parseInt(searchParams.get('days') || '30');
        const projectId = searchParams.get('projectId');
        const commitSha = searchParams.get('commit');
        const mrId = searchParams.get('mrId');
        const deployType = searchParams.get('type'); // feature, hotfix, rollback

        const endDate = new Date();
        const startDate = subDays(endDate, days);

        let query = `
            SELECT 
                snapshot_date, project_id, project_name,
                commit_sha, commit_created_at, commit_author_email,
                mr_id, mr_iid, mr_created_at, mr_merged_at, mr_title, mr_labels, mr_source_branch,
                deploy_id, deploy_created_at, deploy_type, deploy_environment,
                lead_time_commit_hours, lead_time_mr_hours
            FROM deployment_traces
            WHERE snapshot_date >= $1 AND snapshot_date <= $2
        `;
        const params: any[] = [format(startDate, 'yyyy-MM-dd'), format(endDate, 'yyyy-MM-dd')];

        if (projectId) {
            query += ` AND project_id = $${params.length + 1}`;
            params.push(parseInt(projectId));
        }

        if (commitSha) {
            query += ` AND commit_sha = $${params.length + 1}`;
            params.push(commitSha);
        }

        if (mrId) {
            query += ` AND (mr_id = $${params.length + 1} OR mr_iid = $${params.length + 1})`;
            params.push(parseInt(mrId));
        }

        if (deployType) {
            query += ` AND deploy_type = $${params.length + 1}`;
            params.push(deployType);
        }

        query += ` ORDER BY deploy_created_at DESC LIMIT 500`;

        const result = await pool.query(query, params);

        // Calculate summary stats
        const traces = result.rows;
        const summary = {
            total: traces.length,
            byType: {
                feature: traces.filter((t: any) => t.deploy_type === 'feature').length,
                hotfix: traces.filter((t: any) => t.deploy_type === 'hotfix').length,
                rollback: traces.filter((t: any) => t.deploy_type === 'rollback').length,
            },
            avgLeadTimeCommit: traces.length > 0
                ? traces.reduce((sum: number, t: any) => sum + (t.lead_time_commit_hours || 0), 0) / traces.length
                : 0,
            avgLeadTimeMr: traces.filter((t: any) => t.lead_time_mr_hours).length > 0
                ? traces.reduce((sum: number, t: any) => sum + (t.lead_time_mr_hours || 0), 0) / traces.filter((t: any) => t.lead_time_mr_hours).length
                : 0,
        };

        return NextResponse.json({
            traces,
            summary,
            meta: {
                daysRequested: days,
                filters: { projectId, commitSha, mrId, deployType },
            },
        });
    } catch (error) {
        console.error('Traces query error:', error);
        return NextResponse.json(
            { error: 'Failed to fetch deployment traces' },
            { status: 500 }
        );
    }
}
