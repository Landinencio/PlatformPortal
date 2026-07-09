/**
 * GET /api/finops/k8s-nodes
 *
 * Returns the EKS node-level analysis (cost + utilization + recommendation),
 * grouped by nodegroup. Source: Grafana Cloud Prometheus (OpenCost + KSM).
 *
 * Query params:
 *   - cluster=dp-dev|dp-uat|dp-prod|dp-tooling|all   (default: all)
 *
 * Cache: 5 minutes per cluster.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";
import { cached } from "@/lib/cache";
import { fetchNodesSummary } from "@/lib/k8s-nodes";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CACHE_TTL_MS = 5 * 60 * 1000;

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    const role = getSessionRole(session);
    if (!hasMinimumRole(role, "desarrolladores")) {
      return NextResponse.json({ error: "Editor access required" }, { status: 403 });
    }

    const url = new URL(request.url);
    const cluster = url.searchParams.get("cluster") || "all";

    const cacheKey = `finops-k8s-nodes::${cluster}`;
    const summary = await cached(
      cacheKey,
      () => fetchNodesSummary({ cluster: cluster === "all" ? undefined : cluster }),
      CACHE_TTL_MS,
    );
    return NextResponse.json(summary);
  } catch (error: any) {
    console.error("[k8s-nodes] error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to fetch node analysis" },
      { status: 500 },
    );
  }
}
