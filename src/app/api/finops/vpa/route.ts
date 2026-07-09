/**
 * GET /api/finops/vpa
 *
 * Returns the VPA recommendations summary built from the standalone
 * kube-state-metrics CRS deployment in each cluster (see
 * ops/k8s/ksm-vpa-standalone.yaml). Combined with kube_pod_container_resource_*
 * for actual requests/limits and node_*_hourly_cost for savings calc.
 *
 * Query params:
 *   - cluster=dp-dev,dp-uat,dp-prod    (CSV, optional, defaults to all)
 *   - status=SOBRE,sobre,ok,infra,INFRA (CSV, optional)
 *   - includeSidecars=true|false (default false)
 *
 * Cache: 5 minutes per (cluster set, status set, includeSidecars).
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";
import { cached } from "@/lib/cache";
import { fetchVpaSummary, type VpaStatus } from "@/lib/k8s-vpa";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CACHE_TTL_MS = 5 * 60 * 1000;
const VALID_STATUSES: VpaStatus[] = ["SOBRE", "sobre", "ok", "infra", "INFRA"];

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
    const clustersParam = url.searchParams.get("cluster") || url.searchParams.get("clusters");
    const statusParam = url.searchParams.get("status");
    const includeSidecars = url.searchParams.get("includeSidecars") === "true";

    const clusters = clustersParam
      ? clustersParam.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const statuses = statusParam
      ? statusParam
          .split(",")
          .map((s) => s.trim())
          .filter((s): s is VpaStatus => (VALID_STATUSES as string[]).includes(s))
      : [];

    const cacheKey = [
      "finops-vpa",
      clusters.length > 0 ? clusters.slice().sort().join(",") : "*",
      statuses.length > 0 ? statuses.slice().sort().join(",") : "*",
      includeSidecars ? "sidecars=1" : "sidecars=0",
    ].join("::");

    const summary = await cached(
      cacheKey,
      () => fetchVpaSummary({ clusters, statuses, includeSidecars }),
      CACHE_TTL_MS,
    );

    return NextResponse.json(summary);
  } catch (error: any) {
    console.error("[finops-vpa] error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to fetch VPA recommendations" },
      { status: 500 },
    );
  }
}
