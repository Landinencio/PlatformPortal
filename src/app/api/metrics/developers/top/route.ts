import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { mergeDevelopersByIdentity } from '@/lib/developer-identity';

// Force dynamic rendering to access runtime environment variables
export const dynamic = 'force-dynamic';

type TopDeveloperRow = {
    developer_email: string | null;
    developer_name: string | null;
    teams: Array<string | null> | null;
    project_ids: Array<number | string> | null;
    total_commits: number | string | null;
    total_lines_added: number | string | null;
    total_lines_removed: number | string | null;
    total_mrs_opened: number | string | null;
    total_mrs_merged: number | string | null;
    total_reviews_given: number | string | null;
    first_activity: string | null;
    last_activity: string | null;
};

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const team = searchParams.get('team') || 'all';
        const requestedDays = parseInt(searchParams.get('days') || '30');
        const days = Number.isFinite(requestedDays) && requestedDays > 0 ? requestedDays : 30;
        const requestedLimit = parseInt(searchParams.get('limit') || '10');
        const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 10;
        const projectId = searchParams.get('projectId');
        const projectName = searchParams.get('project');

        const sinceDate = new Date();
        sinceDate.setDate(sinceDate.getDate() - days);

        let query = `
            SELECT 
                developer_email,
                MAX(developer_name) as developer_name,
                array_agg(DISTINCT team) as teams,
                array_agg(DISTINCT project_id) as project_ids,
                SUM(commits_count) as total_commits,
                SUM(lines_added) as total_lines_added,
                SUM(lines_removed) as total_lines_removed,
                SUM(mrs_opened) as total_mrs_opened,
                SUM(mrs_merged) as total_mrs_merged,
                SUM(reviews_given) as total_reviews_given,
                MIN(first_commit_time) as first_activity,
                MAX(last_commit_time) as last_activity
            FROM developer_activity_daily
            WHERE snapshot_date >= $1
        `;

        const params: Array<string | number> = [sinceDate.toISOString().split('T')[0]];

        if (team !== 'all') {
            query += ` AND team = $2`;
            params.push(team);
        }

        if (projectId) {
            query += ` AND project_id = $${params.length + 1}`;
            params.push(parseInt(projectId));
        } else if (projectName) {
            query += ` AND project_name = $${params.length + 1}`;
            params.push(projectName);
        }

        query += `
            GROUP BY developer_email
            ORDER BY total_commits DESC
        `;

        const result = await pool.query<TopDeveloperRow>(query, params);
        const mergedDevelopers = mergeDevelopersByIdentity(
            result.rows.map((row) => ({
                email: row.developer_email,
                name: row.developer_name,
                teams: (row.teams || []).filter((value): value is string => Boolean(value)),
                projectIds: row.project_ids || [],
                commits: row.total_commits,
                linesAdded: row.total_lines_added,
                linesRemoved: row.total_lines_removed,
                mrsOpened: row.total_mrs_opened,
                mrsMerged: row.total_mrs_merged,
                reviewsGiven: row.total_reviews_given,
                firstActivity: row.first_activity,
                lastActivity: row.last_activity,
            }))
        );

        const sorted = mergedDevelopers
            .sort((left, right) => {
                if (right.commits !== left.commits) return right.commits - left.commits;
                if (right.mrsMerged !== left.mrsMerged) return right.mrsMerged - left.mrsMerged;
                return right.reviewsGiven - left.reviewsGiven;
            })
            .slice(0, Math.max(1, limit));

        return NextResponse.json({
            developers: sorted.map((developer) => ({
                email: developer.email || 'unknown@example.com',
                canonicalKey: developer.canonicalKey,
                allEmails: developer.allEmails,
                name: developer.name || developer.email.split('@')[0] || 'Unknown',
                teams: developer.teams,
                commits: developer.commits,
                linesAdded: developer.linesAdded,
                linesRemoved: developer.linesRemoved,
                mrsOpened: developer.mrsOpened,
                mrsMerged: developer.mrsMerged,
                reviewsGiven: developer.reviewsGiven,
                projectsActive: developer.projectsActive,
                firstActivity: developer.firstActivity,
                lastActivity: developer.lastActivity,
            })),
            period: { days, start: sinceDate.toISOString(), team },
        });
    } catch (error) {
        console.error('Error fetching top developers:', error);
        return NextResponse.json(
            { error: 'Failed to fetch developers', details: String(error) },
            { status: 500 }
        );
    }
}
