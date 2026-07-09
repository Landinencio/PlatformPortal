import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export const dynamic = 'force-dynamic';

const escapeLabel = (value: string) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\"/g, '\\"');
const toUnixSeconds = (value: string | Date | null | undefined) =>
    value ? Math.floor(new Date(value).getTime() / 1000) : null;

export async function GET(request: Request) {
    try {
        const expectedToken = process.env.SYNTHETICS_TOKEN;
        if (expectedToken) {
            const authHeader = request.headers.get('authorization');
            if (authHeader !== `Bearer ${expectedToken}`) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
        }

        const metricsResult = await pool.query(`
            SELECT
                m.id,
                m.name,
                m.url,
                m.active,
                m.interval_seconds,
                latest.checked_at,
                latest.is_up,
                latest.status_code,
                latest.total_ms,
                latest.ttfb_ms,
                latest.dns_ms,
                latest.tcp_ms,
                latest.tls_ms,
                latest.dns_ok,
                latest.tcp_ok,
                latest.tls_ok,
                latest.ssl_days_remaining,
                latest.error_kind,
                latest.region,
                COALESCE(stats.total_checks, 0) AS total_checks,
                COALESCE(stats.up_checks, 0) AS up_checks,
                COALESCE(stats.down_checks, 0) AS down_checks,
                COALESCE(stats.checks_24h, 0) AS checks_24h,
                COALESCE(stats.up_checks_24h, 0) AS up_checks_24h,
                COALESCE(stats.down_checks_24h, 0) AS down_checks_24h,
                stats.last_down_at
            FROM synthetic_monitors m
            LEFT JOIN LATERAL (
                SELECT
                    c.checked_at,
                    c.is_up,
                    c.status_code,
                    c.total_ms,
                    c.ttfb_ms,
                    c.dns_ms,
                    c.tcp_ms,
                    c.tls_ms,
                    c.dns_ok,
                    c.tcp_ok,
                    c.tls_ok,
                    c.ssl_days_remaining,
                    c.error_kind,
                    c.region
                FROM synthetic_checks c
                WHERE c.monitor_id = m.id
                ORDER BY c.checked_at DESC
                LIMIT 1
            ) latest ON true
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*)::int AS total_checks,
                    COUNT(*) FILTER (WHERE c.is_up)::int AS up_checks,
                    COUNT(*) FILTER (WHERE NOT c.is_up)::int AS down_checks,
                    COUNT(*) FILTER (WHERE c.checked_at >= NOW() - INTERVAL '24 hours')::int AS checks_24h,
                    COUNT(*) FILTER (WHERE c.checked_at >= NOW() - INTERVAL '24 hours' AND c.is_up)::int AS up_checks_24h,
                    COUNT(*) FILTER (WHERE c.checked_at >= NOW() - INTERVAL '24 hours' AND NOT c.is_up)::int AS down_checks_24h,
                    MAX(c.checked_at) FILTER (WHERE NOT c.is_up) AS last_down_at
                FROM synthetic_checks c
                WHERE c.monitor_id = m.id
            ) stats ON true
            ORDER BY m.id
        `);

        const lines: string[] = [];
        lines.push('# HELP synthetics_monitor_info Monitor metadata (value is always 1)');
        lines.push('# TYPE synthetics_monitor_info gauge');
        lines.push('# HELP synthetics_monitor_active Indicates monitor enabled state (1=active,0=inactive)');
        lines.push('# TYPE synthetics_monitor_active gauge');
        lines.push('# HELP synthetics_monitor_interval_seconds Expected check interval configured on monitor');
        lines.push('# TYPE synthetics_monitor_interval_seconds gauge');
        lines.push('# HELP synthetics_last_check_timestamp_seconds Unix timestamp of last check');
        lines.push('# TYPE synthetics_last_check_timestamp_seconds gauge');
        lines.push('# HELP synthetics_last_failure_timestamp_seconds Unix timestamp of latest failed check');
        lines.push('# TYPE synthetics_last_failure_timestamp_seconds gauge');
        lines.push('# HELP synthetics_check_age_seconds Seconds since last check');
        lines.push('# TYPE synthetics_check_age_seconds gauge');
        lines.push('# HELP synthetics_monitor_stale Monitor stale state when last check is delayed (1=stale,0=fresh)');
        lines.push('# TYPE synthetics_monitor_stale gauge');
        lines.push('# HELP synthetics_has_data Indicates whether the monitor has any recorded checks (1=yes,0=no)');
        lines.push('# TYPE synthetics_has_data gauge');
        lines.push('# HELP synthetics_up Latest check status (1=up,0=down)');
        lines.push('# TYPE synthetics_up gauge');
        lines.push('# HELP synthetics_site_up Latest check status by site label (1=up,0=down)');
        lines.push('# TYPE synthetics_site_up gauge');
        lines.push('# HELP synthetics_reachable Latest reachability status (1=reachable,0=not reachable)');
        lines.push('# TYPE synthetics_reachable gauge');
        lines.push('# HELP synthetics_http_status Latest HTTP status code');
        lines.push('# TYPE synthetics_http_status gauge');
        lines.push('# HELP synthetics_latency_ms Latest total latency in milliseconds');
        lines.push('# TYPE synthetics_latency_ms gauge');
        lines.push('# HELP synthetics_ttfb_ms Latest time-to-first-byte in milliseconds');
        lines.push('# TYPE synthetics_ttfb_ms gauge');
        lines.push('# HELP synthetics_layer_latency_ms Latest phase timing in milliseconds');
        lines.push('# TYPE synthetics_layer_latency_ms gauge');
        lines.push('# HELP synthetics_layer_ok Latest reachability per layer (1=ok,0=fail)');
        lines.push('# TYPE synthetics_layer_ok gauge');
        lines.push('# HELP synthetics_ssl_days Remaining SSL days');
        lines.push('# TYPE synthetics_ssl_days gauge');
        lines.push('# HELP synthetics_error_kind Latest error kind (1=active kind)');
        lines.push('# TYPE synthetics_error_kind gauge');
        lines.push('# HELP synthetics_checks_count Check counts by status and window');
        lines.push('# TYPE synthetics_checks_count gauge');
        lines.push('# HELP synthetics_availability_ratio_24h Availability ratio over last 24 hours (0..1)');
        lines.push('# TYPE synthetics_availability_ratio_24h gauge');

        for (const row of metricsResult.rows) {
            const labels = `monitor_id="${row.id}",site="${escapeLabel(row.name)}",monitor="${escapeLabel(row.name)}",url="${escapeLabel(row.url)}",region="${escapeLabel(row.region || 'unknown')}"`;
            const monitorActive = row.active ? 1 : 0;
            const expectedInterval = Number(row.interval_seconds || 60);
            const lastCheckTs = toUnixSeconds(row.checked_at);
            const lastFailureTs = toUnixSeconds(row.last_down_at);
            const nowMs = Date.now();
            const ageSeconds = row.checked_at
                ? Math.max(0, Math.floor((nowMs - new Date(row.checked_at).getTime()) / 1000))
                : -1;
            const staleThreshold = Math.max(expectedInterval * 2, 120);
            const stale = row.checked_at ? (ageSeconds > staleThreshold ? 1 : 0) : 1;

            const hasData = row.checked_at ? 1 : 0;
            lines.push(`synthetics_monitor_info{${labels}} 1`);
            lines.push(`synthetics_monitor_active{${labels}} ${monitorActive}`);
            lines.push(`synthetics_monitor_interval_seconds{${labels}} ${expectedInterval}`);
            lines.push(`synthetics_check_age_seconds{${labels}} ${ageSeconds}`);
            lines.push(`synthetics_monitor_stale{${labels}} ${stale}`);
            lines.push(`synthetics_has_data{${labels}} ${hasData}`);

            if (lastCheckTs !== null) {
                lines.push(`synthetics_last_check_timestamp_seconds{${labels}} ${lastCheckTs}`);
            }
            if (lastFailureTs !== null) {
                lines.push(`synthetics_last_failure_timestamp_seconds{${labels}} ${lastFailureTs}`);
            }

            const totalChecks = Number(row.total_checks || 0);
            const upChecks = Number(row.up_checks || 0);
            const downChecks = Number(row.down_checks || 0);
            const checks24h = Number(row.checks_24h || 0);
            const upChecks24h = Number(row.up_checks_24h || 0);
            const downChecks24h = Number(row.down_checks_24h || 0);
            const availability24h = checks24h > 0 ? upChecks24h / checks24h : (row.is_up ? 1 : 0);

            lines.push(`synthetics_checks_count{${labels},window="all",status="all"} ${totalChecks}`);
            lines.push(`synthetics_checks_count{${labels},window="all",status="up"} ${upChecks}`);
            lines.push(`synthetics_checks_count{${labels},window="all",status="down"} ${downChecks}`);
            lines.push(`synthetics_checks_count{${labels},window="24h",status="all"} ${checks24h}`);
            lines.push(`synthetics_checks_count{${labels},window="24h",status="up"} ${upChecks24h}`);
            lines.push(`synthetics_checks_count{${labels},window="24h",status="down"} ${downChecks24h}`);
            lines.push(`synthetics_availability_ratio_24h{${labels}} ${availability24h.toFixed(4)}`);

            if (!row.checked_at) continue;

            const reachable = row.dns_ok !== false && row.tcp_ok !== false && (row.tls_ok === null || row.tls_ok === true);
            lines.push(`synthetics_up{${labels}} ${row.is_up ? 1 : 0}`);
            lines.push(`synthetics_site_up{${labels}} ${row.is_up ? 1 : 0}`);
            lines.push(`synthetics_reachable{${labels}} ${reachable ? 1 : 0}`);
            lines.push(`synthetics_http_status{${labels}} ${row.status_code ?? -1}`);

            if (row.total_ms !== null && row.total_ms !== undefined) {
                lines.push(`synthetics_latency_ms{${labels}} ${row.total_ms}`);
            }
            if (row.ttfb_ms !== null && row.ttfb_ms !== undefined) {
                lines.push(`synthetics_ttfb_ms{${labels}} ${row.ttfb_ms}`);
            }

            if (row.dns_ms !== null && row.dns_ms !== undefined) {
                lines.push(`synthetics_layer_latency_ms{${labels},layer="dns"} ${row.dns_ms}`);
            }
            if (row.tcp_ms !== null && row.tcp_ms !== undefined) {
                lines.push(`synthetics_layer_latency_ms{${labels},layer="tcp"} ${row.tcp_ms}`);
            }
            if (row.tls_ms !== null && row.tls_ms !== undefined) {
                lines.push(`synthetics_layer_latency_ms{${labels},layer="tls"} ${row.tls_ms}`);
            }

            if (row.dns_ok !== null && row.dns_ok !== undefined) {
                lines.push(`synthetics_layer_ok{${labels},layer="dns"} ${row.dns_ok ? 1 : 0}`);
            }
            if (row.tcp_ok !== null && row.tcp_ok !== undefined) {
                lines.push(`synthetics_layer_ok{${labels},layer="tcp"} ${row.tcp_ok ? 1 : 0}`);
            }
            if (row.tls_ok !== null && row.tls_ok !== undefined) {
                lines.push(`synthetics_layer_ok{${labels},layer="tls"} ${row.tls_ok ? 1 : 0}`);
            }

            if (row.ssl_days_remaining !== null && row.ssl_days_remaining !== undefined) {
                lines.push(`synthetics_ssl_days{${labels}} ${row.ssl_days_remaining}`);
            }

            if (row.error_kind) {
                lines.push(`synthetics_error_kind{${labels},kind="${escapeLabel(row.error_kind)}"} 1`);
            }
        }

        return new NextResponse(lines.join('\n'), {
            status: 200,
            headers: {
                'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
            },
        });
    } catch (error) {
        console.error('Failed to build metrics:', error);
        return NextResponse.json({ error: 'Failed to build metrics' }, { status: 500 });
    }
}
