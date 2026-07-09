import { NextRequest } from "next/server";
import { guard, parseFilters, key, cachedJson, errorResponse } from "../../_shared";
import { getActivityTrend } from "@/lib/kiro-analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const g = await guard();
  if (!g.ok) return g.response;
  try {
    const { users, startDate, endDate } = parseFilters(request);
    return cachedJson(key("user-activity/trend", { users, startDate, endDate }), () => getActivityTrend(users, startDate, endDate));
  } catch (err) {
    return errorResponse(err);
  }
}
