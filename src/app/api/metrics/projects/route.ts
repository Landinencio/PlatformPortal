import { NextResponse } from 'next/server';
import pool from '@/lib/db';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const includeInactive = searchParams.get('includeInactive') === 'true';
        const inactiveDays = parseInt(searchParams.get('inactiveDays') || '30');
        const requestedDays = parseInt(searchParams.get('days') || '90');
        const lookbackDays = Number.isFinite(requestedDays) && requestedDays > 0
            ? Math.min(requestedDays, 365)
            : 90;

        const result = await pool.query(`
            WITH dora_activity AS (
                SELECT
                    project_id,
                    team,
                    project_name,
                    project_path,
                    snapshot_date::date AS activity_date
                FROM dora_metrics_daily
                WHERE snapshot_date >= CURRENT_DATE - $1::int
            ),
            latest_mrs AS (
                SELECT DISTINCT ON (project_id, mr_iid)
                    project_id,
                    team,
                    project_name,
                    CASE
                        WHEN state = 'merged' AND merged_at IS NOT NULL THEN merged_at::date
                        ELSE created_at::date
                    END AS activity_date,
                    snapshot_date
                FROM gitlab_mr_analytics
                WHERE CASE
                    WHEN state = 'merged' AND merged_at IS NOT NULL THEN merged_at::date
                    ELSE created_at::date
                END >= CURRENT_DATE - $1::int
                ORDER BY project_id, mr_iid, snapshot_date DESC
            ),
            unioned_projects AS (
                SELECT
                    project_id,
                    team,
                    project_name,
                    project_path,
                    activity_date
                FROM dora_activity
                UNION ALL
                SELECT
                    project_id,
                    team,
                    project_name,
                    NULL::text AS project_path,
                    activity_date
                FROM latest_mrs
            ),
            project_activity AS (
                SELECT
                    project_id,
                    MAX(activity_date) AS last_activity
                FROM unioned_projects
                GROUP BY project_id
            ),
            project_catalog AS (
                SELECT DISTINCT ON (project_id)
                    team,
                    project_id,
                    project_name,
                    project_path
                FROM unioned_projects
                ORDER BY project_id, activity_date DESC
            )
            SELECT DISTINCT
                pc.team,
                pc.project_id,
                pc.project_name,
                COALESCE(pc.project_path, pc.project_name) AS project_path,
                SPLIT_PART(COALESCE(pc.project_path, ''), '/', 2) AS gitlab_group,
                pa.last_activity,
                pa.last_activity AS last_commit_date
            FROM project_catalog pc
            JOIN project_activity pa ON pc.project_id = pa.project_id
            ${!includeInactive ? `WHERE pa.last_activity >= CURRENT_DATE - $2::int` : ''}
            ${!includeInactive ? 'AND' : 'WHERE'} COALESCE(pc.project_path, '') NOT LIKE '%infrastructure/aws%'
              AND COALESCE(pc.project_path, '') NOT LIKE '%platform-engineering/aws%'
              AND COALESCE(pc.project_path, '') NOT LIKE '%terraform-modules%'
              AND pc.project_name NOT IN ('k8s-common-config', 'kube-configs', 'go-sdk-config')
            ORDER BY pc.team, pc.project_name
        `, includeInactive ? [lookbackDays] : [lookbackDays, inactiveDays]);

        const groupsMap = new Map<string, { name: string; path: string; projects: any[] }>();
        for (const row of result.rows) {
            if (!groupsMap.has(row.team)) {
                groupsMap.set(row.team, { name: row.team, path: row.team, projects: [] });
            }
            groupsMap.get(row.team)!.projects.push({
                id: row.project_id,
                name: row.project_name,
                full_path: row.project_path,
                gitlabGroup: row.gitlab_group || null,
                lastActivity: row.last_activity,
                lastCommit: row.last_commit_date,
            });
        }

        const groups = Array.from(groupsMap.values());
        const totalProjects = groups.reduce((sum, g) => sum + g.projects.length, 0);

        // Collect unique GitLab top-level groups (digital, retail, sre-infra, etc.)
        const gitlabGroupsSet = new Set<string>();
        for (const group of groups) {
            for (const project of group.projects) {
                if (project.gitlabGroup) gitlabGroupsSet.add(project.gitlabGroup);
            }
        }
        const gitlabGroups = [...gitlabGroupsSet].sort();

        return NextResponse.json({ 
            groups,
            gitlabGroups,
            meta: {
                totalProjects,
                totalGroups: groups.length,
                includeInactive,
                inactiveDays,
                lookbackDays,
            }
        });
    } catch (error) {
        console.error('Error fetching projects:', error);
        return NextResponse.json(
            { error: 'Failed to fetch projects' },
            { status: 500 }
        );
    }
}
