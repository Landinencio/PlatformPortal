import { NextResponse } from 'next/server';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const accountIds = searchParams.get('accountIds') || 'all';
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');
        const includeTrends = searchParams.get('includeTrends') !== 'false';

        console.log(`[FinOps Athena API] Request received. Accounts: ${accountIds}, Start: ${startDate}, End: ${endDate}, Trends: ${includeTrends}`);

        // Validate required parameters
        if (!startDate || !endDate) {
            return NextResponse.json(
                { error: 'startDate and endDate are required' },
                { status: 400 }
            );
        }

        const webhookUrl = process.env.N8N_FINOPS_ATHENA_WEBHOOK;

        if (!webhookUrl) {
            console.error('[FinOps Athena API] Critical: N8N_FINOPS_ATHENA_WEBHOOK env var is missing');
            return NextResponse.json(
                { error: 'Server configuration error: Athena webhook URL missing' },
                { status: 500 }
            );
        }

        const n8nUrl = new URL(webhookUrl);
        n8nUrl.searchParams.append('accountIds', accountIds);
        n8nUrl.searchParams.append('startDate', startDate);
        n8nUrl.searchParams.append('endDate', endDate);
        n8nUrl.searchParams.append('includeTrends', String(includeTrends));

        console.log(`[FinOps Athena API] Proxying to n8n: ${n8nUrl.toString()}`);

        const res = await fetch(n8nUrl.toString(), {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
            cache: 'no-store'
        });

        if (!res.ok) {
            const text = await res.text();
            console.error(`[FinOps Athena API] n8n Fetch Failed. Status: ${res.status} ${res.statusText}. Body: ${text}`);
            return NextResponse.json(
                { error: `Downstream Error: ${res.statusText}`, details: text },
                { status: res.status }
            );
        }

        const data = await res.json();
        return NextResponse.json(data);

    } catch (error) {
        console.error('[FinOps Athena API] Unhandled Exception:', error);
        return NextResponse.json(
            { error: 'Internal Server Error', details: String(error) },
            { status: 500 }
        );
    }
}
