import { NextResponse } from "next/server";
import { format, subDays } from "date-fns";

import { generateServiceComplianceSnapshot } from "@/lib/service-compliance";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const dateParam = searchParams.get("date");
    const snapshotDate = dateParam || format(subDays(new Date(), 1), "yyyy-MM-dd");
    const forceHistorical = searchParams.get("forceHistorical") === "true";

    const result = await generateServiceComplianceSnapshot(snapshotDate, {
      skipHistoricalLiveCapture: !forceHistorical,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 207 });
  } catch (error) {
    console.error("Compliance snapshot error:", error);
    return NextResponse.json(
      {
        error: "Failed to generate service compliance snapshot",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
