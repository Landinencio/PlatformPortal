import { NextRequest, NextResponse } from 'next/server';
import { fetchMRMetrics, calculateContributorStats } from '@/lib/gitlab-mr-metrics';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');
    const days = parseInt(searchParams.get('days') || '30');
    
    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    }
    
    const { summary, weekly, mrs } = await fetchMRMetrics(parseInt(projectId), days);
    const contributors = calculateContributorStats(mrs);
    
    return NextResponse.json({
      summary,
      weekly,
      contributors,
      mrs: mrs.slice(0, 100), // Limit to 100 most recent
    });
    
  } catch (error) {
    console.error('MR Metrics error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch MR metrics' },
      { status: 500 }
    );
  }
}
