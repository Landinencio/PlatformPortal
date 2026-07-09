import { NextResponse } from "next/server";
import { requireInternalAuth } from "@/lib/api-auth";
import { runInfraLiveCheck } from "@/lib/infra-live-detector";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/infra-requests/live-check  (internal, cronjob-triggered)
// Polls AWS to detect which executed infra requests are now live in ALL their
// requested environments, and notifies the requestor (RDS includes the master
// credentials secret ARN).
export async function POST(request: Request) {
  const auth = requireInternalAuth(request);
  if (auth.error) return auth.error;

  try {
    const result = await runInfraLiveCheck();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[infra-live-check] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    );
  }
}
