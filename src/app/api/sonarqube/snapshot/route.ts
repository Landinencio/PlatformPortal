import { NextResponse } from "next/server";
import { format, subDays } from "date-fns";

import { generateSonarSnapshot } from "@/lib/sonarqube-snapshot";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const customDate = searchParams.get("date");
    const snapshotDate = customDate || format(subDays(new Date(), 1), "yyyy-MM-dd");

    const payload = await generateSonarSnapshot(snapshotDate);
    return NextResponse.json(payload);
  } catch (error) {
    console.error("SonarQube snapshot error:", error);
    return NextResponse.json(
      { error: "Failed to generate SonarQube snapshot", details: String(error) },
      { status: 500 }
    );
  }
}
