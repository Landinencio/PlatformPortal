import { NextResponse } from "next/server";
import { getReliabilityDashboard, parseReliabilityFilters } from "@/lib/reliability";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filters = parseReliabilityFilters(searchParams);
    const data = await getReliabilityDashboard(filters);
    return NextResponse.json(data);
  } catch (error) {
    console.error("Reliability dashboard error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch reliability dashboard",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
