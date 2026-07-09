import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    try {
        const expectedToken = process.env.SYNTHETICS_TOKEN;
        if (expectedToken) {
            const authHeader = request.headers.get('authorization');
            if (authHeader !== `Bearer ${expectedToken}`) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
        }
        const rawRetentionDays = Number(process.env.SYNTHETICS_RAW_RETENTION_DAYS || 90);
        const rollupRetentionDays = Number(process.env.SYNTHETICS_ROLLUP_RETENTION_DAYS || 365);
        const rollupCutoffDays = Number(process.env.SYNTHETICS_ROLLUP_CUTOFF_DAYS || 2);

        // 1) Upsert daily rollups for completed days
        const rollupQuery = `
            INSERT INTO synthetic_checks_rollup_daily (
                monitor_id, day, total_checks, up_checks, reachable_checks,
                avg_total_ms, p95_ms, p99_ms, last_status_code, last_error_kind, last_check_at
            )
            SELECT
                monitor_id,
                date_trunc('day', checked_at)::date AS day,
                COUNT(*) AS total_checks,
                COUNT(*) FILTER (WHERE is_up = true) AS up_checks,
                COUNT(*) FILTER (
                    WHERE dns_ok = true
                      AND tcp_ok = true
                      AND (tls_ok IS NULL OR tls_ok = true)
                ) AS reachable_checks,
                AVG(COALESCE(total_ms, response_time_ms))::int AS avg_total_ms,
                percentile_disc(0.95) WITHIN GROUP (ORDER BY COALESCE(total_ms, response_time_ms))::int AS p95_ms,
                percentile_disc(0.99) WITHIN GROUP (ORDER BY COALESCE(total_ms, response_time_ms))::int AS p99_ms,
                (ARRAY_AGG(status_code ORDER BY checked_at DESC))[1] AS last_status_code,
                (ARRAY_AGG(error_kind ORDER BY checked_at DESC))[1] AS last_error_kind,
                MAX(checked_at) AS last_check_at
            FROM synthetic_checks
            WHERE checked_at < NOW() - ($1 * INTERVAL '1 day')
            GROUP BY monitor_id, date_trunc('day', checked_at)
            ON CONFLICT (monitor_id, day)
            DO UPDATE SET
                total_checks = EXCLUDED.total_checks,
                up_checks = EXCLUDED.up_checks,
                reachable_checks = EXCLUDED.reachable_checks,
                avg_total_ms = EXCLUDED.avg_total_ms,
                p95_ms = EXCLUDED.p95_ms,
                p99_ms = EXCLUDED.p99_ms,
                last_status_code = EXCLUDED.last_status_code,
                last_error_kind = EXCLUDED.last_error_kind,
                last_check_at = EXCLUDED.last_check_at
            RETURNING monitor_id, day
        `;

        const rollupResult = await pool.query(rollupQuery, [rollupCutoffDays]);

        // 2) Trim raw checks beyond retention
        const deleteRawResult = await pool.query(
            `DELETE FROM synthetic_checks WHERE checked_at < NOW() - ($1 * INTERVAL '1 day')`,
            [rawRetentionDays]
        );

        // 3) Trim rollups beyond retention
        const deleteRollupResult = await pool.query(
            `DELETE FROM synthetic_checks_rollup_daily WHERE day < CURRENT_DATE - ($1 * INTERVAL '1 day')`,
            [rollupRetentionDays]
        );

        return NextResponse.json({
            success: true,
            rollupsUpserted: rollupResult.rowCount || 0,
            rawDeleted: deleteRawResult.rowCount || 0,
            rollupsDeleted: deleteRollupResult.rowCount || 0,
        });
    } catch (error) {
        console.error('Failed to rollup synthetics:', error);
        return NextResponse.json({ error: 'Failed to rollup synthetics' }, { status: 500 });
    }
}
