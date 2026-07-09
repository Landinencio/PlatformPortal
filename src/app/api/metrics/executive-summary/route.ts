import { NextResponse } from "next/server";
import { getExecutiveSummary, parseDashboardFilters } from "@/lib/metrics-dashboard";
import { requireUserAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  try {
    const { searchParams } = new URL(request.url);
    const filters = parseDashboardFilters(searchParams);
    const data = await getExecutiveSummary(filters);
    return NextResponse.json(data);
  } catch (error) {
    console.error("Executive summary error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch executive summary",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
