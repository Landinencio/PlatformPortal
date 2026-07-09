import { NextResponse } from "next/server";
import { getManagerDashboard, parseDashboardFilters } from "@/lib/metrics-dashboard";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filters = parseDashboardFilters(searchParams);
    const data = await getManagerDashboard(filters);
    return NextResponse.json(data);
  } catch (error) {
    console.error("Manager dashboard error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch manager dashboard",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
