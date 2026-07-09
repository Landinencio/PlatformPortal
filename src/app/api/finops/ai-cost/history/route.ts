/**
 * GET /api/finops/ai-cost/history — AI cost trend for the FinOps Costs tab.
 *
 * Auth: user with at least the FinOps role (`desarrolladores`). `externos` cannot
 * access FinOps (req 2.6).
 *
 * Reads the daily AI-cost series straight from the CUR (same model as the rest of
 * the Costs tab) — there is no snapshot table. Respects the dashboard's global date
 * range and account selection.
 *
 * Query:
 *   - startDate, endDate (YYYY-MM-DD) — default: last 90 days (UTC).
 *   - accountIds=csv — optional subset filter (the dashboard's CUR selection).
 *
 * An empty result (no AI cost in the range) is a valid 200 with days: [] — the UI
 * renders an informative empty state (req 2.4).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import { getAiCostHistory } from "@/lib/ai-cost-history";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A date N days before today, in UTC, as YYYY-MM-DD. */
function daysAgoUtc(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split("T")[0];
}

/** Today in UTC as YYYY-MM-DD. */
function todayUtc(): string {
  return new Date().toISOString().split("T")[0];
}

export async function GET(request: NextRequest) {
  const auth = await requireUserAuth(request, "desarrolladores");
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get("startDate") || daysAgoUtc(90);
  const endDate = searchParams.get("endDate") || todayUtc();

  const accountIdsParam = searchParams.get("accountIds") || "";
  const accountIds = accountIdsParam
    ? accountIdsParam.split(",").map((id) => id.trim()).filter(Boolean)
    : undefined;

  try {
    const history = await getAiCostHistory(startDate, endDate, accountIds);
    return NextResponse.json(history);
  } catch (err) {
    console.error("[ai-cost-history] Error:", err);
    return NextResponse.json(
      { error: "Failed to load AI cost history", details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
