import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";
import { normalizeFinOpsAdvisorInput, runFinOpsAdvisorAnalysis } from "@/lib/finops-advisor-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const role = getSessionRole(session);
    if (!hasMinimumRole(role, "desarrolladores")) {
      return NextResponse.json({ error: "Editor access required for FinOps advisor" }, { status: 403 });
    }

    const body = await request.json();
    const input = await normalizeFinOpsAdvisorInput(body);
    const result = await runFinOpsAdvisorAnalysis(input);
    return NextResponse.json(result);
  } catch (error) {
    console.error("FinOps Advisor error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate analysis" },
      { status: 500 },
    );
  }
}
