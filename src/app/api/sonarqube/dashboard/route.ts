import { NextResponse } from "next/server";
import { getSonarDashboard, parseDashboardFilters } from "@/lib/metrics-dashboard";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filters = parseDashboardFilters(searchParams);
    const data = await getSonarDashboard(filters);
    return NextResponse.json(data);
  } catch (error) {
    console.error("Sonar dashboard error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch Sonar dashboard",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
