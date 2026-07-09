import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get('range') || '24h';

    let interval = '24 hours';
    let bucketExpr = "date_trunc('hour', checked_at) + floor(extract(minute from checked_at)/5) * interval '5 minutes'";

    if (range === '7d') {
        interval = '7 days';
        bucketExpr = "date_trunc('hour', checked_at)";
    } else if (range === '30d') {
        interval = '30 days';
        bucketExpr = "date_trunc('day', checked_at)";
    }

    try {
        // 1. Get List of Monitors
        const monitorsResult = await pool.query('SELECT * FROM synthetic_monitors WHERE active = true ORDER BY name ASC');
        const monitors = monitorsResult.rows;

        // 2. Get Latest Check for each monitor (Real-time status)
        const latestChecksResult = await pool.query(`
            SELECT DISTINCT ON (monitor_id) *
            FROM synthetic_checks
            ORDER BY monitor_id, checked_at DESC
        `);
        const latestChecks = new Map(latestChecksResult.rows.map((r: any) => [r.monitor_id, r]));

        // 3. History aggregation (sparklines)
        const historyResult = await pool.query(`
            SELECT 
                monitor_id,
                ${bucketExpr} as bucket,
                AVG(COALESCE(total_ms, response_time_ms))::int as total_ms,
                AVG(ttfb_ms)::int as ttfb_ms,
                BOOL_AND(is_up) as is_up,
                BOOL_AND(COALESCE(dns_ok, true)) as dns_ok,
                BOOL_AND(COALESCE(tcp_ok, true)) as tcp_ok,
                BOOL_AND(COALESCE(tls_ok, true)) as tls_ok
            FROM synthetic_checks
            WHERE checked_at > NOW() - INTERVAL '${interval}'
            GROUP BY monitor_id, bucket
            ORDER BY bucket ASC
        `);

        const historyByMonitor = new Map();
        historyResult.rows.forEach((row: any) => {
            if (!historyByMonitor.has(row.monitor_id)) {
                historyByMonitor.set(row.monitor_id, []);
            }
            const reachable = Boolean(row.dns_ok && row.tcp_ok && row.tls_ok);
            historyByMonitor.get(row.monitor_id).push({
                time: row.bucket,
                val: row.total_ms,
                up: row.is_up,
                reachable
            });
        });

        // 4. Availability & Reachability (over selected range)
        const availabilityResult = await pool.query(`
            SELECT monitor_id, 
                   COUNT(*) as total_checks, 
                   COUNT(*) FILTER (WHERE is_up = true) as up_checks,
                   COUNT(*) FILTER (
                       WHERE dns_ok IS NOT NULL
                         AND tcp_ok IS NOT NULL
                   ) as reachability_samples,
                   COUNT(*) FILTER (
                       WHERE dns_ok = true 
                         AND tcp_ok = true 
                         AND (tls_ok IS NULL OR tls_ok = true)
                   ) as reachable_checks
            FROM synthetic_checks
            WHERE checked_at > NOW() - INTERVAL '${interval}'
            GROUP BY monitor_id
        `);
        const availabilityMap = new Map(availabilityResult.rows.map((r: any) => {
            const totalChecks = parseInt(r.total_checks);
            const reachableSamples = parseInt(r.reachability_samples || r.total_checks);
            return [
                r.monitor_id,
                {
                    availability: totalChecks ? (parseInt(r.up_checks) / totalChecks) * 100 : 100,
                    reachability: reachableSamples ? (parseInt(r.reachable_checks) / reachableSamples) * 100 : 100,
                    totalChecks,
                }
            ];
        }));

        // 5. Latency percentiles
        const latencyPercentiles = await pool.query(`
            SELECT 
                monitor_id,
                percentile_disc(0.95) WITHIN GROUP (ORDER BY COALESCE(total_ms, response_time_ms))::int as p95,
                percentile_disc(0.99) WITHIN GROUP (ORDER BY COALESCE(total_ms, response_time_ms))::int as p99
            FROM synthetic_checks
            WHERE checked_at > NOW() - INTERVAL '${interval}'
              AND COALESCE(total_ms, response_time_ms) IS NOT NULL
            GROUP BY monitor_id
        `);
        const percentileMap = new Map(latencyPercentiles.rows.map((r: any) => [
            r.monitor_id,
            { p95: r.p95, p99: r.p99 }
        ]));

        // 6. Error breakdown
        const errorBreakdownResult = await pool.query(`
            SELECT monitor_id, error_kind, COUNT(*)::int as count
            FROM synthetic_checks
            WHERE checked_at > NOW() - INTERVAL '${interval}'
              AND error_kind IS NOT NULL
            GROUP BY monitor_id, error_kind
        `);
        const errorBreakdownMap = new Map<number, Record<string, number>>();
        errorBreakdownResult.rows.forEach((row: any) => {
            if (!errorBreakdownMap.has(row.monitor_id)) {
                errorBreakdownMap.set(row.monitor_id, {});
            }
            errorBreakdownMap.get(row.monitor_id)![row.error_kind] = row.count;
        });

        // 7. Latest failure
        const lastFailureResult = await pool.query(`
            SELECT DISTINCT ON (monitor_id) monitor_id, error_kind, error_message, checked_at
            FROM synthetic_checks
            WHERE is_up = false
            ORDER BY monitor_id, checked_at DESC
        `);
        const lastFailureMap = new Map(lastFailureResult.rows.map((r: any) => [r.monitor_id, r]));

        // 8. Consecutive Uptime (Time since last DOWN)
        const lastDownResult = await pool.query(`
            SELECT 
                monitor_id,
                MAX(checked_at) FILTER (WHERE is_up = false) as last_down,
                MIN(checked_at) as first_seen
            FROM synthetic_checks
            GROUP BY monitor_id
        `);
        const lastDownMap = new Map(lastDownResult.rows.map((r: any) => [r.monitor_id, r]));

        // 9. SLA tracking — 30-day availability for SLA calculation
        const slaResult = await pool.query(`
            SELECT
                monitor_id,
                COUNT(*)::int as total_checks_30d,
                COUNT(*) FILTER (WHERE is_up = true)::int as up_checks_30d,
                COUNT(*) FILTER (WHERE is_up = false)::int as down_checks_30d,
                MIN(checked_at) as first_check_30d,
                MAX(checked_at) as last_check_30d
            FROM synthetic_checks
            WHERE checked_at > NOW() - INTERVAL '30 days'
            GROUP BY monitor_id
        `);
        const slaMap = new Map(slaResult.rows.map((r: any) => {
            const total = parseInt(r.total_checks_30d);
            const up = parseInt(r.up_checks_30d);
            const availability30d = total > 0 ? (up / total) * 100 : 100;
            // Classify SLA tier
            let slaTier = "N/A";
            if (availability30d >= 99.99) slaTier = "99.99%";
            else if (availability30d >= 99.95) slaTier = "99.95%";
            else if (availability30d >= 99.9) slaTier = "99.9%";
            else if (availability30d >= 99.5) slaTier = "99.5%";
            else if (availability30d >= 99.0) slaTier = "99.0%";
            else slaTier = `${availability30d.toFixed(2)}%`;

            // Estimated downtime in the 30-day window
            const downtimeMinutes = total > 0 ? Math.round((parseInt(r.down_checks_30d) / total) * 30 * 24 * 60) : 0;

            return [r.monitor_id, {
                availability30d: parseFloat(availability30d.toFixed(4)),
                slaTier,
                totalChecks30d: total,
                downChecks30d: parseInt(r.down_checks_30d),
                estimatedDowntimeMinutes: downtimeMinutes,
            }];
        }));

        // 10. Recent checks for detail tables
        const recentChecksResult = await pool.query(`
            SELECT * FROM (
                SELECT *, ROW_NUMBER() OVER (PARTITION BY monitor_id ORDER BY checked_at DESC) as rn
                FROM synthetic_checks
                WHERE checked_at > NOW() - INTERVAL '${interval}'
            ) sub
            WHERE rn <= 50
            ORDER BY monitor_id, checked_at DESC
        `);
        const recentChecksByMonitor = new Map();
        recentChecksResult.rows.forEach((row: any) => {
            if (!recentChecksByMonitor.has(row.monitor_id)) {
                recentChecksByMonitor.set(row.monitor_id, []);
            }
            recentChecksByMonitor.get(row.monitor_id).push({
                time: row.checked_at,
                status: row.is_up ? 'UP' : 'DOWN',
                statusCode: row.status_code,
                totalMs: row.total_ms ?? row.response_time_ms,
                ttfbMs: row.ttfb_ms,
                dnsMs: row.dns_ms,
                tcpMs: row.tcp_ms,
                tlsMs: row.tls_ms,
                errorKind: row.error_kind,
                errorMessage: row.error_message,
                region: row.region,
                reachable: row.dns_ok !== false && row.tcp_ok !== false && (row.tls_ok === null || row.tls_ok === true),
            });
        });

        // Assemble Response
        const data = monitors.map((m: any) => {
            const latest = latestChecks.get(m.id);
            const availabilityStats = availabilityMap.get(m.id);
            const percentiles = percentileMap.get(m.id);
            const lastFailure = lastFailureMap.get(m.id);
            const consecutiveMeta = lastDownMap.get(m.id);
            const slaData = slaMap.get(m.id);

            const reachableLatest = latest
                ? (latest.dns_ok !== false && latest.tcp_ok !== false && (latest.tls_ok === null || latest.tls_ok === true))
                : false;

            // Calculate duration since last down
            let consecutiveUpStr = 'N/A';
            if (latest && consecutiveMeta) {
                const lastDown = consecutiveMeta.last_down;
                const firstSeen = consecutiveMeta.first_seen;
                const now = new Date().getTime();
                let diffMs = 0;

                if (lastDown) {
                    diffMs = now - new Date(lastDown).getTime();
                } else {
                    diffMs = firstSeen ? now - new Date(firstSeen).getTime() : 0;
                }

                // Format duration
                const hours = Math.floor(diffMs / (1000 * 60 * 60));
                const days = Math.floor(hours / 24);

                if (days > 0) consecutiveUpStr = `${days}d ${hours % 24}h`;
                else consecutiveUpStr = `${hours}h`;
            }

            return {
                id: m.id,
                name: m.name,
                url: m.url,
                status: latest
                    ? (latest.is_up ? 'UP' : (reachableLatest ? 'DEGRADED' : 'DOWN'))
                    : 'UNKNOWN',
                lastCheck: latest ? latest.checked_at : null,
                responseTime: latest ? (latest.total_ms ?? latest.response_time_ms ?? 0) : 0,
                ttfb: latest ? latest.ttfb_ms ?? null : null,
                sslDays: latest ? latest.ssl_days_remaining : null,
                availability: availabilityStats ? Number(availabilityStats.availability).toFixed(2) : '100.00',
                reachability: availabilityStats ? Number(availabilityStats.reachability).toFixed(2) : '100.00',
                p95: percentiles?.p95 ?? null,
                p99: percentiles?.p99 ?? null,
                history: historyByMonitor.get(m.id) || [],
                consecutiveUpDuration: consecutiveUpStr,
                errorBreakdown: errorBreakdownMap.get(m.id) || {},
                lastError: lastFailure ? {
                    kind: lastFailure.error_kind,
                    message: lastFailure.error_message,
                    at: lastFailure.checked_at
                } : null,
                recentChecks: recentChecksByMonitor.get(m.id) || [],
                sla: slaData || { availability30d: 100, slaTier: "N/A", totalChecks30d: 0, downChecks30d: 0, estimatedDowntimeMinutes: 0 },
            };
        });

        return NextResponse.json(data);

    } catch (error) {
        console.error('Failed to fetch synthetic stats:', error);
        return NextResponse.json(
            { error: 'Failed to fetch stats' },
            { status: 500 }
        );
    }
}
