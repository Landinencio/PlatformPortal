import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { bedrockClient, MetricsContext } from '@/lib/bedrock';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const body = await request.json();
    const { filters, metrics } = body;

    if (!metrics) {
      return NextResponse.json(
        { error: 'Metrics data is required' },
        { status: 400 }
      );
    }

    const context: MetricsContext = {
      team: filters?.team,
      projects: filters?.projects || [],
      period: filters?.period || 'últimos 30 días',
      metrics: {
        deploymentFreq: metrics.deploymentFreq?.current || 0,
        deployFreqChange: metrics.deploymentFreq?.change || 0,
        leadTime: metrics.leadTime?.current || 0,
        leadTimeChange: metrics.leadTime?.change || 0,
        cfr: metrics.changeFailureRate?.current || 0,
        cfrChange: metrics.changeFailureRate?.change || 0,
        mttr: metrics.mttr?.current || 0,
        mttrChange: metrics.mttr?.change || 0,
      },
      developers: metrics.developers || 0,
      totalDeploys: metrics.totalDeploys || 0,
      incidents: metrics.incidents || 0,
      recentTraces: metrics.recentTraces || [],
    };

    const insights = await bedrockClient.analyzeMetrics(context);

    return NextResponse.json({
      insights,
      generatedAt: new Date().toISOString(),
      context: {
        period: context.period,
        team: context.team,
        projectCount: context.projects.length,
      },
    });
  } catch (error) {
    console.error('AI analysis error:', error);
    return NextResponse.json(
      { error: 'Failed to analyze metrics', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
