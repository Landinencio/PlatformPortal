import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import https from 'https';
import http from 'http';
import dns from 'dns';
import { differenceInDays } from 'date-fns';

export const dynamic = 'force-dynamic';

interface Monitor {
    id: number;
    name: string;
    url: string;
    interval_seconds: number;
    method?: string;
    timeout_ms?: number;
    expected_status_min?: number;
    expected_status_max?: number;
    expected_keyword?: string | null;
    expected_content_regex?: string | null;
    allow_insecure?: boolean;
    custom_headers?: Record<string, string> | null;
    tags?: string[];
}

interface CheckResult {
    monitorId: number;
    isUp: boolean;
    statusCode: number;
    responseTimeMs: number;
    sslValid: boolean | null;
    sslDaysRemaining: number | null;
    errorMessage: string | null;
    errorKind: string | null;
    dnsOk: boolean | null;
    tcpOk: boolean | null;
    tlsOk: boolean | null;
    httpOk: boolean | null;
    contentOk: boolean | null;
    dnsMs: number | null;
    tcpMs: number | null;
    tlsMs: number | null;
    ttfbMs: number | null;
    downloadMs: number | null;
    totalMs: number | null;
    ipAddress: string | null;
    region: string;
}

const classifyError = (error: any, isHttps: boolean) => {
    const code = error?.code || '';
    const message = String(error?.message || '');

    if (["ENOTFOUND", "EAI_AGAIN", "ENODATA"].includes(code)) return "DNS";
    if (["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) return "TCP";
    if (["ETIMEDOUT"].includes(code)) return "TIMEOUT";
    if (code.startsWith("ERR_TLS") || code.includes("CERT_") || message.includes("SSL") || message.includes("TLS")) return "TLS";

    // If HTTPS and we already connected, TLS errors often show up as generic socket hangups
    if (isHttps && message.toLowerCase().includes("socket hang up")) return "TLS";
    return "UNKNOWN";
};

const checkUrl = async (monitor: Monitor): Promise<CheckResult> => {
    const start = Date.now();
    const region = process.env.SYNTHETICS_REGION || process.env.AWS_REGION || "local";

    const baseResult: CheckResult = {
        monitorId: monitor.id,
        isUp: false,
        statusCode: 0,
        responseTimeMs: 0,
        sslValid: null,
        sslDaysRemaining: null,
        errorMessage: null,
        errorKind: null,
        dnsOk: null,
        tcpOk: null,
        tlsOk: null,
        httpOk: null,
        contentOk: null,
        dnsMs: null,
        tcpMs: null,
        tlsMs: null,
        ttfbMs: null,
        downloadMs: null,
        totalMs: null,
        ipAddress: null,
        region,
    };

    return new Promise((resolve) => {
        try {
            const url = new URL(monitor.url);
            const isHttps = url.protocol === 'https:';
            const requestModule = isHttps ? https : http;
            const method = (monitor.method || 'GET').toUpperCase();
            const timeoutMs = monitor.timeout_ms || 10000;
            const expectedMin = monitor.expected_status_min ?? 200;
            const expectedMax = monitor.expected_status_max ?? 399;
            const expectedKeyword = monitor.expected_keyword || null;
            const expectedRegex = monitor.expected_content_regex || null;

            if (!['http:', 'https:'].includes(url.protocol)) {
                resolve({
                    ...baseResult,
                    errorKind: "CONFIG",
                    errorMessage: `Unsupported protocol: ${url.protocol}`,
                    responseTimeMs: Date.now() - start,
                    totalMs: Date.now() - start,
                });
                return;
            }

            // 1) DNS resolution
            const dnsStart = Date.now();
            dns.promises.lookup(url.hostname).then((lookup) => {
                // Handle case where lookup might return an array or object differently than expected
                const address = Array.isArray(lookup) ? lookup[0]?.address : lookup?.address;
                const family = Array.isArray(lookup) ? lookup[0]?.family : lookup?.family;

                if (!address) {
                    throw new Error(`DNS lookup returned no address for ${url.hostname}`);
                }

                baseResult.dnsOk = true;
                baseResult.dnsMs = Date.now() - dnsStart;
                baseResult.ipAddress = address;

                const requestStart = Date.now();
                let firstByteAt: number | null = null;
                let body = "";
                let bodyBytes = 0;
                const maxBodyBytes = 200 * 1024;

                const options: any = {
                    hostname: url.hostname,
                    port: url.port || (isHttps ? 443 : 80),
                    path: url.pathname + url.search,
                    method,
                    timeout: timeoutMs,
                    headers: {
                        'User-Agent': 'PlatformPortal-SyntheticMonitor/2.0',
                        'Accept': '*/*',
                        ...(monitor.custom_headers || {}),
                    },
                    lookup: (_hostname: string, opts: any, cb: any) => {
                        if (opts.all) {
                            cb(null, [{ address, family: family || 4 }]);
                        } else {
                            cb(null, address, family || 4);
                        }
                    },
                };

                if (isHttps) {
                    options.agent = new https.Agent({
                        rejectUnauthorized: !monitor.allow_insecure,
                        maxCachedSessions: 0,
                    });
                    options.servername = url.hostname;
                }

                const req = requestModule.request(options, (res) => {
                    const now = Date.now();
                    firstByteAt = now;
                    baseResult.ttfbMs = now - start;
                    baseResult.statusCode = res.statusCode || 0;
                    baseResult.httpOk = baseResult.statusCode >= expectedMin && baseResult.statusCode <= expectedMax;

                    let sslValid: boolean | null = null;
                    let sslDays: number | null = null;

                    try {
                        if (isHttps && res.socket && 'getPeerCertificate' in res.socket) {
                            const socket = res.socket as import('tls').TLSSocket;
                            const cert = socket.getPeerCertificate();
                            if (cert && Object.keys(cert).length > 0 && cert.valid_to) {
                                const validTo = new Date(cert.valid_to);
                                sslValid = new Date() < validTo;
                                sslDays = differenceInDays(validTo, new Date());
                            }
                        }
                    } catch (sslError) {
                        console.error('SSL check error:', sslError);
                    }

                    baseResult.sslValid = sslValid;
                    baseResult.sslDaysRemaining = sslDays;

                    if (!expectedKeyword && !expectedRegex || method === "HEAD") {
                        res.resume();
                    } else {
                        res.on('data', (chunk: Buffer) => {
                            if (bodyBytes >= maxBodyBytes) return;
                            bodyBytes += chunk.length;
                            if (bodyBytes <= maxBodyBytes) {
                                body += chunk.toString('utf8');
                            }
                        });
                    }

                    res.on('end', () => {
                        const end = Date.now();
                        baseResult.totalMs = end - start;
                        baseResult.downloadMs = baseResult.ttfbMs ? Math.max(0, baseResult.totalMs - baseResult.ttfbMs) : null;
                        baseResult.responseTimeMs = baseResult.totalMs || 0;

                        if (expectedKeyword && method !== "HEAD") {
                            baseResult.contentOk = body.includes(expectedKeyword);
                        } else if (expectedRegex && method !== "HEAD") {
                            try {
                                baseResult.contentOk = new RegExp(expectedRegex).test(body);
                            } catch {
                                baseResult.contentOk = false;
                            }
                        } else {
                            baseResult.contentOk = true;
                        }

                        if (!baseResult.httpOk) {
                            baseResult.errorKind = "HTTP";
                            baseResult.errorMessage = `HTTP ${baseResult.statusCode}`;
                        } else if (baseResult.contentOk === false) {
                            baseResult.errorKind = "CONTENT";
                            baseResult.errorMessage = expectedRegex
                                ? `Regex not matched: ${expectedRegex}`
                                : `Missing keyword: ${expectedKeyword}`;
                        }

                        baseResult.isUp = Boolean(baseResult.httpOk && baseResult.contentOk);

                        resolve({
                            ...baseResult,
                        });
                    });
                });

                req.on('socket', (socket) => {
                    socket.once('connect', () => {
                        baseResult.tcpOk = true;
                        baseResult.tcpMs = Date.now() - requestStart;
                    });

                    if (isHttps) {
                        socket.once('secureConnect', () => {
                            baseResult.tlsOk = true;
                            if (baseResult.tcpMs != null) {
                                baseResult.tlsMs = Date.now() - requestStart - baseResult.tcpMs;
                            }
                        });
                    }
                });

                req.on('timeout', () => {
                    req.destroy();
                    const end = Date.now();
                    baseResult.totalMs = end - start;
                    baseResult.responseTimeMs = baseResult.totalMs || timeoutMs;
                    baseResult.errorKind = "TIMEOUT";
                    baseResult.errorMessage = "Timeout";
                    baseResult.httpOk = false;
                    baseResult.contentOk = false;
                    baseResult.isUp = false;
                    resolve({ ...baseResult, statusCode: 408 });
                });

                req.on('error', (e) => {
                    const end = Date.now();
                    baseResult.totalMs = end - start;
                    baseResult.responseTimeMs = baseResult.totalMs || 0;
                    baseResult.errorKind = classifyError(e, isHttps);
                    baseResult.errorMessage = e.message;
                    baseResult.httpOk = false;
                    baseResult.contentOk = false;
                    baseResult.isUp = false;

                    if (baseResult.errorKind === "TLS") baseResult.tlsOk = false;
                    if (baseResult.errorKind === "TCP") baseResult.tcpOk = false;

                    resolve({ ...baseResult });
                });

                req.end();
            }).catch((err) => {
                resolve({
                    ...baseResult,
                    dnsOk: false,
                    errorKind: "DNS",
                    errorMessage: err.message,
                    responseTimeMs: Date.now() - start,
                    totalMs: Date.now() - start,
                });
            });
        } catch (err: any) {
            resolve({
                ...baseResult,
                errorKind: "CONFIG",
                errorMessage: `Setup Error: ${err.message}`,
                responseTimeMs: Date.now() - start,
                totalMs: Date.now() - start,
            });
        }
    });
};

export async function POST(request: Request) {
    // Check internal secret if needed, or rely on internal network restrictions
    // const authHeader = request.headers.get('authorization');

    try {
        const authHeader = request.headers.get('authorization');
        const expectedToken = process.env.SYNTHETICS_TOKEN;
        if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // 1. Get Active Monitors
        const monitorsIdx = await pool.query(`
            SELECT m.*
            FROM synthetic_monitors m
            LEFT JOIN LATERAL (
                SELECT checked_at
                FROM synthetic_checks c
                WHERE c.monitor_id = m.id
                ORDER BY checked_at DESC
                LIMIT 1
            ) last_check ON true
            WHERE m.active = true
              AND (
                  last_check.checked_at IS NULL
                  OR last_check.checked_at < NOW() - (m.interval_seconds * INTERVAL '1 second')
              )
        `);
        const monitors = monitorsIdx.rows;

        if (monitors.length === 0) {
            return NextResponse.json({ message: 'No active monitors found' });
        }

        console.log(`Running checks for ${monitors.length} monitors...`);

        // 2. Run Checks in Parallel
        const results = await Promise.all(monitors.map(checkUrl));

        // 3. Save Results
        for (const res of results) {
            await pool.query(
                `INSERT INTO synthetic_checks 
                (
                    monitor_id, is_up, status_code, response_time_ms, ssl_valid, ssl_days_remaining, error_message,
                    error_kind, dns_ok, tcp_ok, tls_ok, http_ok, content_ok,
                    dns_ms, tcp_ms, tls_ms, ttfb_ms, download_ms, total_ms,
                    ip_address, region
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7,
                    $8, $9, $10, $11, $12, $13,
                    $14, $15, $16, $17, $18, $19,
                    $20, $21
                )`,
                [
                    res.monitorId,
                    res.isUp,
                    res.statusCode,
                    res.responseTimeMs,
                    res.sslValid,
                    res.sslDaysRemaining,
                    res.errorMessage,
                    res.errorKind,
                    res.dnsOk,
                    res.tcpOk,
                    res.tlsOk,
                    res.httpOk,
                    res.contentOk,
                    res.dnsMs,
                    res.tcpMs,
                    res.tlsMs,
                    res.ttfbMs,
                    res.downloadMs,
                    res.totalMs,
                    res.ipAddress,
                    res.region,
                ]
            );
        }

        return NextResponse.json({
            success: true,
            checks_run: results.length,
            results: results.map(r => ({
                id: r.monitorId,
                up: r.isUp,
                time: r.responseTimeMs,
                ssl: r.sslDaysRemaining
            }))
        });

    } catch (error) {
        console.error('Synthetic run error:', error);
        return NextResponse.json(
            { error: 'Failed to run synthetic checks', details: String(error) },
            { status: 500 }
        );
    }
}
