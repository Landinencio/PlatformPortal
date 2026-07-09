import { NextResponse } from "next/server";
import { format, subDays } from "date-fns";

import { generateUnifiedSnapshot } from "@/lib/platform-snapshot";
import { requireInternalAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

export async function POST(request: Request) {
  const auth = requireInternalAuth(request);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const dateParam = searchParams.get("date");
  const snapshotDate = dateParam || format(new Date(), "yyyy-MM-dd");
  const payload = await generateUnifiedSnapshot(snapshotDate);

  return NextResponse.json(
    payload,
    { status: payload.success ? 200 : 207 }
  );
}
