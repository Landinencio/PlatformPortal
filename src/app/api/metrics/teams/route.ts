import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
import pool from '@/lib/db';

// Get list of teams
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const requestedDays = parseInt(searchParams.get('days') || '90');
        const lookbackDays = Number.isFinite(requestedDays) && requestedDays > 0
            ? Math.min(requestedDays, 365)
            : 90;

        const result = await pool.query(`
      WITH dora_teams AS (
        SELECT team, project_id
        FROM dora_metrics_daily
        WHERE snapshot_date >= CURRENT_DATE - $1::int
      ),
      mr_teams AS (
        SELECT DISTINCT ON (project_id, mr_iid)
          team,
          project_id,
          CASE
            WHEN state = 'merged' AND merged_at IS NOT NULL THEN merged_at::date
            ELSE created_at::date
          END AS reference_date,
          snapshot_date
        FROM gitlab_mr_analytics
        WHERE CASE
          WHEN state = 'merged' AND merged_at IS NOT NULL THEN merged_at::date
          ELSE created_at::date
        END >= CURRENT_DATE - $1::int
        ORDER BY project_id, mr_iid, snapshot_date DESC
      ),
      unioned AS (
        SELECT team, project_id FROM dora_teams
        UNION
        SELECT team, project_id FROM mr_teams
      )
      SELECT team, COUNT(DISTINCT project_id) as project_count
      FROM unioned
      GROUP BY team
      ORDER BY team ASC
    `, [lookbackDays]);

        return NextResponse.json({
            teams: result.rows.map((row: any) => ({
                name: row.team,
                projectCount: parseInt(row.project_count),
            })),
            meta: {
                lookbackDays,
            },
        });
    } catch (error) {
        console.error('Teams error:', error);
        return NextResponse.json(
            { error: 'Failed to fetch teams' },
            { status: 500 }
        );
    }
}
