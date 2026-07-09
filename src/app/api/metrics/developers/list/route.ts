import { NextResponse } from 'next/server';
import pool from '@/lib/db';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const includeInactive = searchParams.get('includeInactive') === 'true';
        const inactiveDays = parseInt(searchParams.get('inactiveDays') || '30');
        const teams = searchParams.get('teams')?.split(',').filter(Boolean) || [];
        const projectIds = searchParams.get('projectIds')?.split(',').map(p => parseInt(p)).filter(n => !isNaN(n)) || [];

        // Build dynamic WHERE conditions
        const conditions: string[] = ["snapshot_date >= NOW() - INTERVAL '90 days'"];
        const params: any[] = [];
        let paramIndex = 1;

        if (teams.length > 0) {
            conditions.push(`team = ANY($${paramIndex})`);
            params.push(teams);
            paramIndex++;
        }

        if (projectIds.length > 0) {
            conditions.push(`project_id = ANY($${paramIndex})`);
            params.push(projectIds);
            paramIndex++;
        }

        // Query to get unique developers (normalized by email username part)
        const query = `
            SELECT 
                LOWER(SPLIT_PART(developer_email, '@', 1)) as email_user,
                MIN(developer_email) as email,
                (ARRAY_AGG(developer_name ORDER BY
                  CASE WHEN developer_name LIKE '%.%' THEN 1 ELSE 0 END,
                  LENGTH(developer_name) DESC
                ))[1] as name,
                MAX(snapshot_date) as last_activity
            FROM developer_activity_daily
            WHERE ${conditions.join(' AND ')}
            GROUP BY LOWER(SPLIT_PART(developer_email, '@', 1))
            ${!includeInactive ? `HAVING MAX(snapshot_date) >= NOW() - INTERVAL '${inactiveDays} days'` : ''}
            ORDER BY name
        `;

        const result = await pool.query(query, params);

        return NextResponse.json({
            developers: result.rows.map((r: any) => ({
                email: r.email,
                name: r.name,
                lastActivity: r.last_activity,
            })),
            meta: {
                total: result.rows.length,
                includeInactive,
                inactiveDays,
                filters: { teams, projectIds },
            },
        });
    } catch (error) {
        console.error('Error fetching developers list:', error);
        return NextResponse.json({ error: 'Failed to fetch developers' }, { status: 500 });
    }
}
