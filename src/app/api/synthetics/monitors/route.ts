import { NextResponse } from 'next/server';
import { z } from 'zod';
import pool from '@/lib/db';

export const dynamic = 'force-dynamic';

const monitorSchema = z.object({
    name: z.string().min(1, 'Name is required'),
    url: z.string().url('Invalid URL'),
    active: z.boolean().optional().default(true),
    interval_seconds: z.coerce.number().int().min(15).max(3600).default(60),
    method: z.enum(['GET', 'HEAD']).default('GET'),
    timeout_ms: z.coerce.number().int().min(1000).max(60000).default(10000),
    expected_status_min: z.coerce.number().int().min(100).max(599).default(200),
    expected_status_max: z.coerce.number().int().min(100).max(599).default(399),
    expected_keyword: z.string().optional().nullable(),
    expected_content_regex: z.string().optional().nullable(),
    allow_insecure: z.boolean().optional().default(false),
    tags: z.array(z.string()).optional().default([]),
    custom_headers: z.record(z.string()).optional().default({}),
});

export async function GET() {
    try {
        const result = await pool.query(
            `SELECT id, name, url, active, interval_seconds, method, timeout_ms,
                    expected_status_min, expected_status_max, expected_keyword, expected_content_regex,
                    allow_insecure, tags, custom_headers, created_at, updated_at
             FROM synthetic_monitors
             ORDER BY name ASC`
        );
        return NextResponse.json(result.rows);
    } catch (error) {
        console.error('Failed to fetch monitors:', error);
        return NextResponse.json({ error: 'Failed to fetch monitors' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const parsed = monitorSchema.parse(body);

        if (parsed.expected_status_min > parsed.expected_status_max) {
            return NextResponse.json(
                { error: 'expected_status_min cannot exceed expected_status_max' },
                { status: 400 }
            );
        }

        const keyword = parsed.expected_keyword?.trim() || null;
        const contentRegex = parsed.expected_content_regex?.trim() || null;

        // Validate regex if provided
        if (contentRegex) {
            try { new RegExp(contentRegex); } catch {
                return NextResponse.json({ error: 'Invalid regex pattern' }, { status: 400 });
            }
        }

        const result = await pool.query(
            `INSERT INTO synthetic_monitors
                (name, url, active, interval_seconds, method, timeout_ms,
                 expected_status_min, expected_status_max, expected_keyword, expected_content_regex,
                 allow_insecure, tags, custom_headers)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             RETURNING id`,
            [
                parsed.name,
                parsed.url,
                parsed.active,
                parsed.interval_seconds,
                parsed.method,
                parsed.timeout_ms,
                parsed.expected_status_min,
                parsed.expected_status_max,
                keyword,
                contentRegex,
                parsed.allow_insecure,
                parsed.tags,
                JSON.stringify(parsed.custom_headers),
            ]
        );

        return NextResponse.json({ success: true, id: result.rows[0]?.id });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: error.errors[0]?.message || 'Invalid input' }, { status: 400 });
        }
        console.error('Failed to create monitor:', error);
        return NextResponse.json({ error: 'Failed to create monitor' }, { status: 500 });
    }
}
