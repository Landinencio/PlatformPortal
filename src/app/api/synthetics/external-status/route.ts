import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const SERVICES = [
    // Payment providers
    {
        id: 'klarna',
        name: 'Klarna',
        type: 'statuspage_io',
        url: 'https://status.klarna.com/api/v2/summary.json',
        homeUrl: 'https://status.klarna.com',
        category: 'Pagos',
    },
    {
        id: 'paypal',
        name: 'PayPal',
        type: 'http_check',
        url: 'https://www.paypal.com',
        homeUrl: 'https://www.paypal-status.com',
        category: 'Pagos',
    },
    {
        id: 'stripe',
        name: 'Stripe',
        type: 'statuspage_io',
        url: 'https://status.stripe.com/api/v2/status.json',
        homeUrl: 'https://status.stripe.com',
        category: 'Pagos',
    },
    // Infrastructure
    {
        id: 'cloudflare',
        name: 'Cloudflare',
        type: 'statuspage_io',
        url: 'https://www.cloudflarestatus.com/api/v2/summary.json',
        homeUrl: 'https://www.cloudflarestatus.com',
        category: 'Infraestructura',
    },
    {
        id: 'aws',
        name: 'AWS',
        type: 'http_check',
        url: 'https://health.aws.amazon.com',
        homeUrl: 'https://health.aws.amazon.com/health/status',
        category: 'Infraestructura',
    },
    // DevOps
    {
        id: 'gitlab',
        name: 'GitLab',
        type: 'statuspage_io',
        url: 'https://status.gitlab.com/api/v2/status.json',
        homeUrl: 'https://status.gitlab.com',
        category: 'DevOps',
    },
    {
        id: 'grafana',
        name: 'Grafana Cloud',
        type: 'statuspage_io',
        url: 'https://status.grafana.com/api/v2/summary.json',
        homeUrl: 'https://status.grafana.com',
        category: 'DevOps',
    },
    // Ecommerce
    {
        id: 'salesforce',
        name: 'Salesforce',
        type: 'http_check',
        url: 'https://status.salesforce.com',
        homeUrl: 'https://status.salesforce.com',
        category: 'Ecommerce',
    },
    {
        id: 'google-apis',
        name: 'Google Cloud',
        type: 'http_check',
        url: 'https://status.cloud.google.com',
        homeUrl: 'https://status.cloud.google.com',
        category: 'Servicios',
    },
];

export async function GET() {
    try {
        const results = await Promise.all(SERVICES.map(async (service) => {
            try {
                if (service.type === 'statuspage_io') {
                    const res = await fetch(service.url, {
                        next: { revalidate: 60 },
                        signal: AbortSignal.timeout(8000),
                        headers: { 'User-Agent': 'IskayPet-Portal-StatusCheck/1.0' },
                    });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const data = await res.json();

                    // Parse Atlassian Statuspage response
                    // data.status.indicator: "none", "minor", "major", "critical"
                    // "none" means All Systems Operational
                    const indicator = data.status?.indicator || 'unknown';
                    const description = data.status?.description || indicator;

                    return {
                        id: service.id,
                        name: service.name,
                        status: indicator === 'none' ? 'UP' : (indicator === 'minor' ? 'DEGRADED' : 'DOWN'),
                        description: description,
                        url: service.homeUrl,
                        category: service.category,
                    };
                } else {
                    // Simple HTTP Check
                    const start = Date.now();
                    const res = await fetch(service.url, {
                        method: 'GET',
                        next: { revalidate: 60 },
                        signal: AbortSignal.timeout(8000),
                        headers: { 'User-Agent': 'IskayPet-Portal-StatusCheck/1.0' },
                    });
                    const duration = Date.now() - start;

                    return {
                        id: service.id,
                        name: service.name,
                        status: res.ok ? 'UP' : 'DOWN',
                        description: res.ok ? `Responsive (${duration}ms)` : `Unreachable (${res.status})`,
                        url: service.homeUrl,
                        category: service.category,
                    };
                }
            } catch (error) {
                console.error(`Check failed for ${service.name}:`, error);
                return {
                    id: service.id,
                    name: service.name,
                    status: 'UNKNOWN',
                    description: 'Check failed',
                    url: service.homeUrl,
                    category: service.category,
                };
            }
        }));

        return NextResponse.json(results);
    } catch (error) {
        console.error('External status check failed:', error);
        return NextResponse.json({ error: 'Failed to check external services' }, { status: 500 });
    }
}
