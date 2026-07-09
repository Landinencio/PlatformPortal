import { NextRequest } from "next/server";
import { guard, key, cachedJson, errorResponse } from "../../_shared";
import { getTopByPrompts } from "@/lib/kiro-analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(_request: NextRequest) {
  const g = await guard();
  if (!g.ok) return g.response;
  try {
    return cachedJson(key("classified/top-by-prompts", {}), () => getTopByPrompts());
  } catch (err) {
    return errorResponse(err);
  }
}
