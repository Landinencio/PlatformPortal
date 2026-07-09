import { NextResponse } from "next/server";
import { format, subDays } from "date-fns";

import { generateDoraSnapshot } from "@/lib/dora-snapshot";
import { requireInternalAuth } from "@/lib/api-auth";

const DEFAULT_SNAPSHOT_OFFSET_DAYS = 1;

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function POST(request: Request) {
  const auth = requireInternalAuth(request);
  if (auth.error) return auth.error;

  try {
    const { searchParams } = new URL(request.url);
    const customDate = searchParams.get("date");
    const snapshotDate = customDate || format(subDays(new Date(), DEFAULT_SNAPSHOT_OFFSET_DAYS), "yyyy-MM-dd");

    const result = await generateDoraSnapshot(snapshotDate);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to generate snapshot", details: String(error) },
      { status: 500 }
    );
  }
}
