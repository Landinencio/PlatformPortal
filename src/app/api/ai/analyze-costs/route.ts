import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    {
      error: "Endpoint retired",
      message: "Use /api/ai/finops-advisor/jobs for asynchronous FinOps AI analysis.",
      deprecatedAt: "2026-03-05",
    },
    { status: 410 },
  );
}
