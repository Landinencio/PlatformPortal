import { NextResponse } from 'next/server';
import { generateUnifiedSnapshot } from '@/lib/platform-snapshot';
import { requireInternalAuth } from '@/lib/api-auth';

// Force dynamic rendering to access runtime environment variables
export const dynamic = 'force-dynamic';

/**
 * Backfill historical platform snapshots for a date range or past N days.
 * This uses the unified snapshot flow so DORA, MR analytics, SonarQube,
 * K8s runtime and correlation stay aligned for the same day.
 */
export async function POST(request: Request) {
    const auth = requireInternalAuth(request);
    if (auth.error) return auth.error;

    try {
        const { searchParams } = new URL(request.url);
        const daysParam = searchParams.get('days');
        const startParam = searchParams.get('start');
        const endParam = searchParams.get('end');
        const delayMs = parseInt(searchParams.get('delayMs') || '2000');
        const defaultDays = 365;

        const results: any[] = [];

        const parseDate = (value: string) => {
            const parsed = new Date(`${value}T00:00:00.000Z`);
            return Number.isNaN(parsed.getTime()) ? null : parsed;
        };

        let startDate: Date | null = null;
        let endDate: Date | null = null;

        if (startParam) startDate = parseDate(startParam);
        if (endParam) endDate = parseDate(endParam);

        if ((startParam && !startDate) || (endParam && !endDate)) {
            return NextResponse.json(
                { error: 'Invalid start or end date. Use YYYY-MM-DD format.' },
                { status: 400 }
            );
        }

        if (!endDate) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            endDate = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate()));
        }

        if (!startDate) {
            const days = daysParam ? parseInt(daysParam) : defaultDays;
            const start = new Date(endDate);
            start.setDate(endDate.getDate() - (days - 1));
            startDate = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
        }

        if (startDate > endDate) {
            return NextResponse.json(
                { error: 'Start date must be before or equal to end date.' },
                { status: 400 }
            );
        }

        // Generate snapshots for each day going backwards
        const totalDays = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
        for (let i = 0; i < totalDays; i++) {
            const targetDate = new Date(startDate);
            targetDate.setDate(startDate.getDate() + i);
            const dateStr = targetDate.toISOString().split('T')[0];

            console.log(`Generating snapshot for ${dateStr}...`);

            try {
                // Call logic directly instead of fetch
                const result = await generateUnifiedSnapshot(dateStr);

                results.push({
                    date: dateStr,
                    ...result,
                });
            } catch (error) {
                console.error(`Failed to generate snapshot for ${dateStr}:`, error);
                results.push({
                    date: dateStr,
                    success: false,
                    error: String(error)
                });
            }

            // Add a small delay between requests to avoid overwhelming GitLab API
            if (delayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        const allSuccess = results.every((item) => item.success);

        return NextResponse.json({
            success: allSuccess,
            message: `Backfilled ${totalDays} days of historical data`,
            results,
        }, { status: allSuccess ? 200 : 207 });
    } catch (error) {
        console.error('Backfill error:', error);
        return NextResponse.json(
            { error: 'Failed to backfill data', details: String(error) },
            { status: 500 }
        );
    }
}
