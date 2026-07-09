/**
 * POST /api/aws-health/sync — Internal endpoint to sync AWS news (aws.health events).
 *
 * Auth: internal only (x-internal-secret), called by the aws-health-sync CronJob
 * (every 15 min).
 *
 * Drains the Health queue (SQS), upserts the events into `aws_health_events` by `arn`
 * (idempotent, preserving first_seen and merging affected_accounts), and deletes only
 * the messages that were persisted successfully. Degrades gracefully: a missing queue /
 * missing permissions returns { upserted: 0, new: 0 } without touching previous rows.
 *
 * On unexpected error returns 500 so the CronJob retries (restartPolicy: OnFailure).
 */

import { NextResponse } from "next/server";
import { requireInternalAuth } from "@/lib/api-auth";
import { syncAwsHealthEvents } from "@/lib/aws-health";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // 2 min

export async function POST(request: Request) {
  const auth = requireInternalAuth(request);
  if (auth.error) return auth.error;

  try {
    console.log("[aws-health-sync] Draining Health queue and upserting events");
    const result = await syncAwsHealthEvents();
    console.log(
      `[aws-health-sync] Done: ${result.upserted} upserted (${result.new} new)`,
    );
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    // 500 so the cronjob retries; previous events stay intact (upsert by arn).
    console.error("[aws-health-sync] Error:", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
