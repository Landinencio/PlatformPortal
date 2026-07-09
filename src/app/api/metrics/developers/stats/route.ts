import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
import pool from '@/lib/db';
import { subDays, format } from 'date-fns';
import { mergeDevelopersByIdentity } from '@/lib/developer-identity';

type DeveloperStatsRow = {
    developer_email: string | null;
    developer_name: string | null;
    total_commits: number | string | null;
    total_lines_added: number | string | null;
    total_lines_removed: number | string | null;
    total_mrs_opened: number | string | null;
    total_mrs_merged: number | string | null;
    total_reviews: number | string | null;
};

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const team = searchParams.get('team') || 'all';
        const requestedDays = parseInt(searchParams.get('days') || '30');
        const days = Number.isFinite(requestedDays) && requestedDays > 0 ? requestedDays : 30;
        const projectId = searchParams.get('projectId');
        const projectName = searchParams.get('project');

        const endDate = new Date();
        const startDate = subDays(endDate, days);

        let query = `
            SELECT 
                developer_email,
                MAX(developer_name) as developer_name,
                SUM(commits_count) as total_commits,
                SUM(lines_added) as total_lines_added,
                SUM(lines_removed) as total_lines_removed,
                SUM(mrs_opened) as total_mrs_opened,
                SUM(mrs_merged) as total_mrs_merged,
                SUM(reviews_given) as total_reviews
            FROM developer_activity_daily
            WHERE snapshot_date >= $1 AND snapshot_date <= $2
        `;
        const params: Array<string | number> = [format(startDate, 'yyyy-MM-dd'), format(endDate, 'yyyy-MM-dd')];

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

        query += ` GROUP BY developer_email`;

        const result = await pool.query<DeveloperStatsRow>(query, params);
        const mergedDevelopers = mergeDevelopersByIdentity(
            result.rows.map((row) => ({
                email: row.developer_email,
                name: row.developer_name,
                commits: row.total_commits,
                linesAdded: row.total_lines_added,
                linesRemoved: row.total_lines_removed,
                mrsOpened: row.total_mrs_opened,
                mrsMerged: row.total_mrs_merged,
                reviewsGiven: row.total_reviews,
            }))
        );

        const totals = mergedDevelopers.reduce(
            (acc, developer) => {
                acc.commits += developer.commits;
                acc.mrsOpened += developer.mrsOpened;
                acc.mrsMerged += developer.mrsMerged;
                acc.reviews += developer.reviewsGiven;
                return acc;
            },
            { commits: 0, mrsOpened: 0, mrsMerged: 0, reviews: 0 }
        );

        return NextResponse.json({
            active_devs: mergedDevelopers.length,
            commits: totals.commits,
            mrs_opened: totals.mrsOpened,
            mrs_merged: totals.mrsMerged,
            reviews: totals.reviews,
        });
    } catch (error) {
        console.error('Developer stats error:', error);
        return NextResponse.json(
            { error: 'Failed to fetch developer statistics' },
            { status: 500 }
        );
    }
}
