import { NextRequest } from "next/server";
import { guard, parseFilters, key, cachedJson, errorResponse } from "../../_shared";
import { getPromptsTrend } from "@/lib/kiro-analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const g = await guard();
  if (!g.ok) return g.response;
  try {
    const { users } = parseFilters(request);
    return cachedJson(key("classified/trend", { users }), () => getPromptsTrend(users));
  } catch (err) {
    return errorResponse(err);
  }
}
