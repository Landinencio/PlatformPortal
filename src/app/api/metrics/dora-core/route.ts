import { NextResponse } from "next/server";
import { getDoraCoreDashboard, parseDashboardFilters } from "@/lib/metrics-dashboard";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filters = parseDashboardFilters(searchParams);
    const data = await getDoraCoreDashboard(filters);
    return NextResponse.json(data);
  } catch (error) {
    console.error("DORA core dashboard error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch DORA core dashboard",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
