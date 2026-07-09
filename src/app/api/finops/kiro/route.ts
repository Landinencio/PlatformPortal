import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";
import { fetchKiroSummary } from "@/lib/kiro-licenses";
import { cached, cacheKey } from "@/lib/cache";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CACHE_TTL_MS = 15 * 60 * 1000;

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    const role = getSessionRole(session);
    if (!hasMinimumRole(role, "desarrolladores")) {
      return NextResponse.json({ error: "FinOps role required" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(today.getUTCDate()).padStart(2, "0");

    const startDate = searchParams.get("startDate") || `${yyyy}-${mm}-01`;
    const endDate = searchParams.get("endDate") || `${yyyy}-${mm}-${dd}`;
    const accountIdsParam = searchParams.get("accountIds") || "";
    const accountIds = accountIdsParam
      ? accountIdsParam.split(",").map((id) => id.trim()).filter((id) => /^\d{6,}$/.test(id))
      : undefined;

    const key = cacheKey("kiro-licenses", { startDate, endDate, accountIds: accountIds?.join(",") || "all" });
    const data = await cached(key, () => fetchKiroSummary(startDate, endDate, accountIds), CACHE_TTL_MS);
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("[kiro-licenses] error:", error);
    return NextResponse.json({ error: error?.message || "Failed to load Kiro usage" }, { status: 500 });
  }
}
