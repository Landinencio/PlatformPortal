import { NextResponse } from 'next/server';
import { sonarQubeClient } from '@/lib/sonarqube';
import pool from '@/lib/db';

export const dynamic = 'force-dynamic';

// GET: List all SonarQube projects with metrics
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const search = searchParams.get('search') || '';
        const page = parseInt(searchParams.get('page') || '1');
        const limit = parseInt(searchParams.get('limit') || '50');

        // Get projects from SonarQube API
        const projects = await sonarQubeClient.searchProjects(search, page, limit);

        return NextResponse.json({
            projects,
            pagination: { page, limit },
        });
    } catch (error) {
        console.error('Error fetching SonarQube projects:', error);
        return NextResponse.json(
            { error: 'Failed to fetch SonarQube projects' },
            { status: 500 }
        );
    }
}
