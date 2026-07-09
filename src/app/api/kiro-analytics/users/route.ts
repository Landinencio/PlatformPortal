import { NextRequest } from "next/server";
import { guard, key, cachedJson, errorResponse } from "../_shared";
import { listUsers } from "@/lib/kiro-analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const g = await guard();
  if (!g.ok) return g.response;
  try {
    const { searchParams } = new URL(request.url);
    const source = searchParams.get("source") || "all";
    return cachedJson(key("users", { source }), () => listUsers(source));
  } catch (err) {
    return errorResponse(err);
  }
}
