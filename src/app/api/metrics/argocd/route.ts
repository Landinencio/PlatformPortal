import { NextResponse } from "next/server";
import { getArgocdRuntimeOverview } from "@/lib/argocd-runtime";
import { parseDashboardFilters } from "@/lib/metrics-dashboard";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filters = parseDashboardFilters(searchParams);
    const data = await getArgocdRuntimeOverview({
      days: filters.days,
      teams: filters.teams,
      projectIds: filters.projectIds,
    });
    return NextResponse.json(data);
  } catch (error) {
    console.error("ArgoCD runtime dashboard error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch ArgoCD runtime dashboard",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
