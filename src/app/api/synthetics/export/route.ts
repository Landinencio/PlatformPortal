import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import * as XLSX from 'xlsx';
import { format } from 'date-fns';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        // Fetch detailed logs for the last 30 days
        // 1. Get List of Monitors
        const monitorsResult = await pool.query('SELECT id, name, url FROM synthetic_monitors WHERE active = true ORDER BY name ASC');
        const monitors = monitorsResult.rows;

        // 2. Fetch Aggregated Stats for last 30 days
        const statsQuery = `
            SELECT 
                monitor_id,
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
                ) as reachable_checks,
                AVG(COALESCE(total_ms, response_time_ms))::int as avg_latency,
                percentile_disc(0.95) WITHIN GROUP (ORDER BY COALESCE(total_ms, response_time_ms))::int as p95_latency,
                percentile_disc(0.99) WITHIN GROUP (ORDER BY COALESCE(total_ms, response_time_ms))::int as p99_latency,
                MAX(checked_at) as last_check,
                BOOL_AND(is_up) as all_up
            FROM synthetic_checks
            WHERE checked_at > NOW() - INTERVAL '30 days'
            GROUP BY monitor_id
        `;
        const statsResult = await pool.query(statsQuery);
        const statsMap = new Map(statsResult.rows.map((r: any) => [r.monitor_id, r]));

        // 3. Get Latest Specific Details (SSL, Status)
        const latestDetailsQuery = `
            SELECT DISTINCT ON (monitor_id) 
                monitor_id, status_code, ssl_days_remaining, ssl_valid, error_kind, error_message
            FROM synthetic_checks
            WHERE checked_at > NOW() - INTERVAL '24 hours'
            ORDER BY monitor_id, checked_at DESC
        `;
        const latestResult = await pool.query(latestDetailsQuery);
        const latestMap = new Map(latestResult.rows.map((r: any) => [r.monitor_id, r]));

        // Transform data for Excel
        const data = monitors.map((m: any) => {
            const stats = statsMap.get(m.id) || {};
            const latest = latestMap.get(m.id) || {};

            const totalChecks = parseInt(stats.total_checks || 0);
            const reachabilitySamples = parseInt(stats.reachability_samples || stats.total_checks || 0);
            const uptime = totalChecks ? ((parseInt(stats.up_checks) / totalChecks) * 100).toFixed(2) + '%' : 'N/A';
            const reachability = reachabilitySamples ? ((parseInt(stats.reachable_checks) / reachabilitySamples) * 100).toFixed(2) + '%' : 'N/A';

            return {
                'Monitor Name': m.name,
                'URL': m.url,
                'Current Status': latest.status_code ? (latest.status_code >= 200 && latest.status_code < 400 ? 'UP' : 'DOWN') : 'UNKNOWN',
                'Uptime (30d)': uptime,
                'Reachability (30d)': reachability,
                'Avg Latency (30d)': stats.avg_latency ? `${stats.avg_latency} ms` : '-',
                'P95 Latency (30d)': stats.p95_latency ? `${stats.p95_latency} ms` : '-',
                'P99 Latency (30d)': stats.p99_latency ? `${stats.p99_latency} ms` : '-',
                'SSL Valid': latest.ssl_valid ? 'Yes' : 'No',
                'SSL Days Left': latest.ssl_days_remaining || '-',
                'Last Error Kind': latest.error_kind || '-',
                'Last Error Message': latest.error_message || '-',
                'Last Check': stats.last_check ? format(new Date(stats.last_check), 'yyyy-MM-dd HH:mm:ss') : '-'
            };
        });

        // Create Workbook
        const worksheet = XLSX.utils.json_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Synthetic Logs");

        // Generate Buffer
        const buf = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

        // Return File
        return new NextResponse(buf, {
            status: 200,
            headers: {
                'Content-Disposition': `attachment; filename="availability_report_${format(new Date(), 'yyyyMMdd')}.xlsx"`,
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            },
        });

    } catch (error) {
        console.error('Export error:', error);
        return NextResponse.json(
            { error: 'Failed to generate export', details: String(error) },
            { status: 500 }
        );
    }
}
