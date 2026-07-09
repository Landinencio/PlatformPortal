import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { subDays, format, startOfWeek } from 'date-fns';
import { parseMetricFilters, buildWhereClause } from '@/lib/query-filters';
import { mean, median, stdDev, calculateStats } from '@/lib/statistics';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filters = parseMetricFilters(searchParams);

    const endDate = new Date();
    const startDate = subDays(endDate, filters.days);

    const baseParams = [format(startDate, 'yyyy-MM-dd'), format(endDate, 'yyyy-MM-dd')];
    const { clause: filterClause, params: filterParams } = buildWhereClause(filters, 3, {
      teamColumn: 'team',
      projectColumn: 'project_id',
    });

    // Get all MRs for the period.
    // Canonical semantics: deduplicate to the latest snapshot per
    // (project_id, mr_iid) and window by reference_at, not snapshot_date.
    const query = `
      WITH latest AS (
        SELECT DISTINCT ON (project_id, mr_iid)
          lifetime_hours,
          lead_time_hours,
          review_time_hours,
          commit_count,
          review_count,
          reviewer_count,
          state,
          merged_at,
          created_at,
          author_username,
          CASE
            WHEN state = 'merged' AND merged_at IS NOT NULL THEN merged_at
            ELSE created_at
          END AS reference_at,
          snapshot_date
        FROM gitlab_mr_analytics
        WHERE 1 = 1
        ${filterClause}
        ORDER BY project_id, mr_iid, snapshot_date DESC
      )
      SELECT
        lifetime_hours,
        lead_time_hours,
        review_time_hours,
        commit_count,
        review_count,
        reviewer_count,
        state,
        merged_at,
        created_at,
        author_username
      FROM latest
      WHERE reference_at >= $1 AND reference_at <= $2
    `;

    const result = await pool.query(query, [...baseParams, ...filterParams]);
    const allMRs = result.rows;

    // Separate merged and open MRs
    const mergedMRs = allMRs.filter((mr: any) => mr.state === 'merged');
    const openMRs = allMRs.filter((mr: any) => mr.state === 'opened');

    // Calculate statistics
    const lifetimeValues = mergedMRs.map((mr: any) => parseFloat(mr.lifetime_hours || 0));
    const leadTimeValues = allMRs.map((mr: any) => parseFloat(mr.lead_time_hours || 0));
    const reviewTimeValues = mergedMRs.map((mr: any) => parseFloat(mr.review_time_hours || 0)).filter((v) => v > 0);

    const lifetimeStats = calculateStats(lifetimeValues);
    const leadTimeStats = calculateStats(leadTimeValues);
    const reviewTimeStats = calculateStats(reviewTimeValues, true); // exclude zeros

    // Weekly breakdown
    const weeklyData = new Map<string, any>();
    mergedMRs.forEach((mr: any) => {
      const weekStart = startOfWeek(new Date(mr.merged_at || mr.created_at));
      const weekKey = format(weekStart, 'yyyy-MM-dd');

      if (!weeklyData.has(weekKey)) {
        weeklyData.set(weekKey, {
          week: weekKey,
          weekLabel: format(weekStart, 'MMM dd'),
          mrs: [],
          reviewTimes: [],
          leadTimes: [],
        });
      }

      const week = weeklyData.get(weekKey);
      week.mrs.push(mr);
      if (mr.review_time_hours > 0) {
        week.reviewTimes.push(parseFloat(mr.review_time_hours));
      }
      week.leadTimes.push(parseFloat(mr.lead_time_hours || 0));
    });

    const weeklyBreakdown = Array.from(weeklyData.values())
      .map((week) => ({
        week: week.weekLabel,
        weekDate: week.week,
        volume: week.mrs.length,
        reviewTimeMedian: median(week.reviewTimes, true),
        leadTimeMedian: median(week.leadTimes),
      }))
      .sort((a, b) => a.weekDate.localeCompare(b.weekDate));

    // Contributor stats
    const contributorMap = new Map<string, any>();
    allMRs.forEach((mr: any) => {
      const username = mr.author_username;
      if (!contributorMap.has(username)) {
        contributorMap.set(username, {
          username,
          mrsCreated: 0,
          mrsReviewed: 0,
          commentsGiven: 0,
        });
      }
      const contributor = contributorMap.get(username);
      contributor.mrsCreated++;
    });

    // Count reviews given (from reviewers field) — deduplicated + windowed.
    const reviewQuery = `
      WITH latest AS (
        SELECT DISTINCT ON (project_id, mr_iid)
          reviewers,
          CASE
            WHEN state = 'merged' AND merged_at IS NOT NULL THEN merged_at
            ELSE created_at
          END AS reference_at,
          snapshot_date
        FROM gitlab_mr_analytics
        WHERE 1 = 1
        ${filterClause}
        ORDER BY project_id, mr_iid, snapshot_date DESC
      )
      SELECT
        jsonb_array_elements(reviewers) as reviewer
      FROM latest
      WHERE reference_at >= $1 AND reference_at <= $2
        AND jsonb_typeof(reviewers) = 'array'
    `;
    const reviewResult = await pool.query(reviewQuery, [...baseParams, ...filterParams]);
    reviewResult.rows.forEach((row: any) => {
      const reviewer = row.reviewer;
      const username = reviewer.username;
      if (!contributorMap.has(username)) {
        contributorMap.set(username, {
          username,
          mrsCreated: 0,
          mrsReviewed: 0,
          commentsGiven: 0,
        });
      }
      const contributor = contributorMap.get(username);
      contributor.mrsReviewed++;
      contributor.commentsGiven += reviewer.comments || 0;
    });

    const contributors = Array.from(contributorMap.values())
      .sort((a, b) => b.mrsReviewed - a.mrsReviewed)
      .slice(0, 20);

    // Calculate GAP and volatility
    const gap = reviewTimeStats.mean - reviewTimeStats.median;
    const isVolatile = reviewTimeStats.stdDev > reviewTimeStats.median * 1.5;
    const isStable = reviewTimeStats.stdDev < reviewTimeStats.median * 0.5;

    return NextResponse.json({
      summary: {
        totalMRs: allMRs.length,
        mergedMRs: mergedMRs.length,
        openMRs: openMRs.length,
        uniqueContributors: contributorMap.size,
      },
      lifetime: lifetimeStats,
      leadTime: leadTimeStats,
      reviewTime: reviewTimeStats,
      analysis: {
        gap: parseFloat(gap.toFixed(2)),
        hasOutliers: Math.abs(gap) > 0.5,
        volatility: isVolatile ? 'volatile' : isStable ? 'very_stable' : 'stable',
        stdDevRatio: reviewTimeStats.median > 0 ? reviewTimeStats.stdDev / reviewTimeStats.median : 0,
      },
      weeklyBreakdown,
      contributors,
    });
  } catch (error) {
    console.error('MR stats error:', error);
    return NextResponse.json(
      { error: 'Failed to calculate MR stats', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
