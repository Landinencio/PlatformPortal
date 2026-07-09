import { NextResponse } from 'next/server';
import { z } from 'zod';
import pool from '@/lib/db';

export const dynamic = 'force-dynamic';

const monitorSchema = z.object({
    name: z.string().min(1).optional(),
    url: z.string().url().optional(),
    active: z.boolean().optional(),
    interval_seconds: z.coerce.number().int().min(15).max(3600).optional(),
    method: z.enum(['GET', 'HEAD']).optional(),
    timeout_ms: z.coerce.number().int().min(1000).max(60000).optional(),
    expected_status_min: z.coerce.number().int().min(100).max(599).optional(),
    expected_status_max: z.coerce.number().int().min(100).max(599).optional(),
    expected_keyword: z.string().optional().nullable(),
    expected_content_regex: z.string().optional().nullable(),
    allow_insecure: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    custom_headers: z.record(z.string()).optional(),
});

const idSchema = z.coerce.number().int().positive();

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
    try {
        const id = idSchema.parse(params.id);
        const body = await request.json();
        const parsed = monitorSchema.parse(body);

        if (parsed.expected_status_min && parsed.expected_status_max && parsed.expected_status_min > parsed.expected_status_max) {
            return NextResponse.json(
                { error: 'expected_status_min cannot exceed expected_status_max' },
                { status: 400 }
            );
        }

        const fields: string[] = [];
        const values: any[] = [];
        let idx = 1;

        Object.entries(parsed).forEach(([key, value]) => {
            if (value === undefined) return;
            fields.push(`${key} = $${idx}`);
            if (key === 'expected_keyword' || key === 'expected_content_regex') {
                values.push(value ? String(value).trim() : null);
            } else if (key === 'custom_headers') {
                values.push(JSON.stringify(value));
            } else {
                values.push(value);
            }
            idx += 1;
        });

        if (fields.length === 0) {
            return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
        }

        values.push(id);
        const query = `UPDATE synthetic_monitors SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idx}`;
        await pool.query(query, values);

        return NextResponse.json({ success: true });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: error.errors[0]?.message || 'Invalid input' }, { status: 400 });
        }
        console.error('Failed to update monitor:', error);
        return NextResponse.json({ error: 'Failed to update monitor' }, { status: 500 });
    }
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
    try {
        const id = idSchema.parse(params.id);
        await pool.query('DELETE FROM synthetic_monitors WHERE id = $1', [id]);
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Failed to delete monitor:', error);
        return NextResponse.json({ error: 'Failed to delete monitor' }, { status: 500 });
    }
}
