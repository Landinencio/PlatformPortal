import { NextResponse } from 'next/server';
import pool from '@/lib/db';

// Force dynamic rendering to access runtime environment variables
export const dynamic = 'force-dynamic';

export async function GET(
    request: Request,
    { params }: { params: { email: string } }
) {
    try {
        const { searchParams } = new URL(request.url);
        const days = parseInt(searchParams.get('days') || '30');
        const email = decodeURIComponent(params.email);

        const sinceDate = new Date();
        sinceDate.setDate(sinceDate.getDate() - days);

        const since = sinceDate.toISOString().split('T')[0];

        // Get developer summary
        const summaryQuery = `
            SELECT 
                developer_email,
                developer_name,
                team,
                SUM(commits_count) as total_commits,
                SUM(lines_added) as total_lines_added,
                SUM(lines_removed) as total_lines_removed,
                SUM(mrs_opened) as total_mrs_opened,
                SUM(mrs_merged) as total_mrs_merged,
                SUM(reviews_given) as total_reviews_given,
                COUNT(DISTINCT project_id) as projects_active
            FROM developer_activity_daily
            WHERE developer_email = $1 AND snapshot_date >= $2
            GROUP BY developer_email, developer_name, team
        `;

        const summaryResult = await pool.query(summaryQuery, [email, since]);

        if (summaryResult.rows.length === 0) {
            return NextResponse.json(
                { error: 'Developer not found' },
                { status: 404 }
            );
        }

        const developer = summaryResult.rows[0];

        // Get activity by project
        const projectsQuery = `
            SELECT 
                project_name,
                project_path,
                SUM(commits_count) as commits,
                SUM(mrs_merged) as mrs_merged,
                SUM(reviews_given) as reviews,
                MAX(last_commit_time) as last_activity
            FROM developer_activity_daily
            WHERE developer_email = $1 AND snapshot_date >= $2
            GROUP BY project_name, project_path
            ORDER BY commits DESC
        `;

        const projectsResult = await pool.query(projectsQuery, [email, since]);

        // Get daily trend
        const trendQuery = `
            SELECT 
                snapshot_date,
                SUM(commits_count) as commits,
                SUM(mrs_merged) as mrs_merged
            FROM developer_activity_daily
            WHERE developer_email = $1 AND snapshot_date >= $2
            GROUP BY snapshot_date
            ORDER BY snapshot_date ASC
        `;

        const trendResult = await pool.query(trendQuery, [email, since]);

        return NextResponse.json({
            developer: {
                email: developer.developer_email,
                name: developer.developer_name || developer.developer_email.split('@')[0],
                team: developer.team,
                metrics: {
                    commits: parseInt(developer.total_commits) || 0,
                    linesAdded: parseInt(developer.total_lines_added) || 0,
                    linesRemoved: parseInt(developer.total_lines_removed) || 0,
                    mrsOpened: parseInt(developer.total_mrs_opened) || 0,
                    mrsMerged: parseInt(developer.total_mrs_merged) || 0,
                    reviewsGiven: parseInt(developer.total_reviews_given) || 0,
                    projectsActive: parseInt(developer.projects_active) || 0,
                },
            },
            activityByProject: projectsResult.rows,
            trend: trendResult.rows,
            period: { days },
        });
    } catch (error) {
        console.error('Error fetching developer details:', error);
        return NextResponse.json(
            { error: 'Failed to fetch developer', details: String(error) },
            { status: 500 }
        );
    }
}
