import { NextResponse } from "next/server";
import { format, subDays } from "date-fns";

import { generateMrAnalyticsSnapshot } from "@/lib/mr-snapshot";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const dateParam = searchParams.get("date");
    const snapshotDate = dateParam || format(subDays(new Date(), 1), "yyyy-MM-dd");

    const payload = await generateMrAnalyticsSnapshot(snapshotDate);
    return NextResponse.json(payload);
  } catch (error) {
    console.error("MR snapshot error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to generate MR analytics snapshot",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
