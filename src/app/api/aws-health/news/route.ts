/**
 * GET /api/aws-health/news — AWS news feed for the admin-only home sidebar.
 *
 * Auth: user with the `admin` role. The role is validated server-side (not just hidden
 * in the client), so any non-admin gets a 403 regardless of query params (req 4.1, 4.7;
 * Design Property 7).
 *
 * Query:
 *   - includeClosed=true — include closed events (default: false, only actionable ones).
 *
 * Returns AwsNewsItem[] served from the `aws_health_events` cache (no SQS latency),
 * ordered by relevance (open/upcoming first, then last_updated desc).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import { getAwsNews } from "@/lib/aws-health";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const auth = await requireUserAuth(request, "admin");
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const includeClosed = searchParams.get("includeClosed") === "true";

  try {
    const news = await getAwsNews({ includeClosed });
    return NextResponse.json(news);
  } catch (err) {
    console.error("[aws-health-news] Error:", err);
    return NextResponse.json(
      { error: "Failed to load AWS news", details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
