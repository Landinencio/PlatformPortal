/**
 * POST /api/finops/daily-digest — Internal endpoint to generate and publish the daily
 * FinOps digest to Teams.
 *
 * Auth: internal only (x-internal-secret), called by the finops-daily-digest CronJob
 * (10:20 Europe/Madrid, just before the daily).
 *
 * Runs runDailyFinOpsDigest() (reuses the FinOps advisor + last-24h AWS news) and
 * publishes one or two Adaptive Cards to FINOPS_TEAMS_WEBHOOK_URL. The digest never
 * throws on a partial failure (design Property 9); partial failures are accumulated in
 * DigestResult.errors and returned in the response.
 *
 * On unexpected error returns 500 so the CronJob retries (restartPolicy: OnFailure).
 */

import { NextResponse } from "next/server";
import { requireInternalAuth } from "@/lib/api-auth";
import { runDailyFinOpsDigest } from "@/lib/finops-daily-digest";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min

export async function POST(request: Request) {
  const auth = requireInternalAuth(request);
  if (auth.error) return auth.error;

  try {
    console.log("[finops-daily-digest] Generating and publishing daily FinOps digest");
    const result = await runDailyFinOpsDigest();
    console.log(
      `[finops-daily-digest] Done: finopsSent=${result.finopsSent} newsSent=${result.newsSent} ` +
        `mode=${result.mode} errors=${result.errors.length}`,
    );
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    // 500 so the cronjob retries; the digest itself never throws on partial failures.
    console.error("[finops-daily-digest] Error:", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
