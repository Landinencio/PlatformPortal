import { NextRequest } from "next/server";
import { guard, parseFilters, key, cachedJson, errorResponse } from "../../_shared";
import { getClassifiedPrompts } from "@/lib/kiro-analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const g = await guard();
  if (!g.ok) return g.response;
  try {
    const { users } = parseFilters(request);
    const { searchParams } = new URL(request.url);
    const limit = Number(searchParams.get("limit") || "50");
    const offset = Number(searchParams.get("offset") || "0");
    return cachedJson(key("classified/prompts", { users, limit, offset }), () =>
      getClassifiedPrompts(users, limit, offset),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
