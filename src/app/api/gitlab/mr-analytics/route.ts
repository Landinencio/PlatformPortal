import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { subDays, format } from 'date-fns';
import { parseMetricFilters, buildWhereClause } from '@/lib/query-filters';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filters = parseMetricFilters(searchParams);
    const state = searchParams.get('state') || 'all'; // all, opened, merged, closed
    const authorFilter = searchParams.get('author');

    const endDate = new Date();
    const startDate = subDays(endDate, filters.days);

    const baseParams = [format(startDate, 'yyyy-MM-dd'), format(endDate, 'yyyy-MM-dd')];
    const { clause: filterClause, params: filterParams } = buildWhereClause(filters, 3, {
      teamColumn: 'team',
      projectColumn: 'project_id',
    });

    let stateClause = '';
    let authorClause = '';
    let additionalParams: any[] = [];

    if (state !== 'all') {
      stateClause = ` AND state = $${baseParams.length + filterParams.length + 1}`;
      additionalParams.push(state);
    }

    if (authorFilter) {
      authorClause = ` AND author_username = $${baseParams.length + filterParams.length + additionalParams.length + 1}`;
      additionalParams.push(authorFilter);
    }

    // Canonical semantics: deduplicate to the latest snapshot per
    // (project_id, mr_iid) and window by reference_at (merged_at for merged,
    // created_at otherwise). Querying raw rows by snapshot_date returned one
    // copy of every MR per daily snapshot (≈90× duplication).
    const query = `
      WITH latest AS (
        SELECT DISTINCT ON (project_id, mr_iid)
          id,
          snapshot_date,
          project_id,
          project_name,
          team,
          mr_id,
          mr_iid,
          title,
          state,
          web_url,
          author_name,
          author_username,
          author_avatar_url,
          created_at,
          merged_at,
          updated_at,
          first_comment_at,
          lifetime_hours,
          lead_time_hours,
          review_time_hours,
          commit_count,
          review_count,
          reviewer_count,
          reviewers,
          labels,
          source_branch,
          CASE
            WHEN state = 'merged' AND merged_at IS NOT NULL THEN merged_at
            ELSE created_at
          END AS reference_at
        FROM gitlab_mr_analytics
        WHERE 1 = 1
        ${filterClause}
        ORDER BY project_id, mr_iid, snapshot_date DESC
      )
      SELECT
        id,
        snapshot_date,
        project_id,
        project_name,
        team,
        mr_id,
        mr_iid,
        title,
        state,
        web_url,
        author_name,
        author_username,
        author_avatar_url,
        created_at,
        merged_at,
        updated_at,
        first_comment_at,
        lifetime_hours,
        lead_time_hours,
        review_time_hours,
        commit_count,
        review_count,
        reviewer_count,
        reviewers,
        labels,
        source_branch
      FROM latest
      WHERE reference_at >= $1 AND reference_at <= $2
      ${stateClause}
      ${authorClause}
      ORDER BY reference_at DESC
      LIMIT 500
    `;

    const result = await pool.query(query, [...baseParams, ...filterParams, ...additionalParams]);

    const mrs = result.rows.map((row: any) => ({
      ...row,
      reviewers: typeof row.reviewers === 'string' ? JSON.parse(row.reviewers) : row.reviewers,
    }));

    return NextResponse.json({
      mrs,
      count: mrs.length,
      filters: {
        days: filters.days,
        teams: filters.teams,
        projectIds: filters.projectIds,
        state,
        author: authorFilter,
      },
    });
  } catch (error) {
    console.error('MR analytics query error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch MR analytics', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
