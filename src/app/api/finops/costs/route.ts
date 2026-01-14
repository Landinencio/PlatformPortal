
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const accountId = searchParams.get('accountId');
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');

        // Explicitly log received params for debugging
        console.log(`[FinOps API] Request received. Account: ${accountId}, Start: ${startDate}, End: ${endDate}`);

        const webhookUrl = process.env.N8N_FINOPS_WEBHOOK;

        if (!webhookUrl) {
            console.error('[FinOps API] Critical: N8N_FINOPS_WEBHOOK env var is missing');
            return NextResponse.json(
                { error: 'Server configuration error: Webhook URL missing' },
                { status: 500 }
            );
        }

        const n8nUrl = new URL(webhookUrl);
        if (accountId) n8nUrl.searchParams.append('accountId', accountId);
        if (startDate) n8nUrl.searchParams.append('startDate', startDate);
        if (endDate) n8nUrl.searchParams.append('endDate', endDate);

        console.log(`[FinOps API] Proxying to n8n: ${n8nUrl.toString()}`);

        const res = await fetch(n8nUrl.toString(), {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
            cache: 'no-store'
        });

        if (!res.ok) {
            const text = await res.text();
            console.error(`[FinOps API] n8n Fetch Failed. Status: ${res.status} ${res.statusText}. Body: ${text}`);
            return NextResponse.json(
                { error: `Downstream Error: ${res.statusText}`, details: text },
                { status: res.status }
            );
        }

        const data = await res.json();
        return NextResponse.json(data);

    } catch (error) {
        console.error('[FinOps API] Unhandled Exception:', error);
        return NextResponse.json(
            { error: 'Internal Server Error', details: String(error) },
            { status: 500 }
        );
    }
}
