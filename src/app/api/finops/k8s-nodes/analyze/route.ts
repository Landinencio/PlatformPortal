/**
 * POST /api/finops/k8s-nodes/analyze
 *
 * Body: { cluster: string, nodegroup: string }
 *
 * Returns an AI-generated nodegroup recommendation (Bedrock Sonnet 4) that
 * augments the deterministic recommendation with reasoning, migration plan
 * and risks. The model can only recommend instance types that already passed
 * the deterministic fit validation, so the output is always operationally
 * sound.
 *
 * RBAC: admin or directores (same gate as Iskay).
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";
import { analyzeNodegroupWithAI } from "@/lib/k8s-nodes-ai";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    const role = getSessionRole(session);
    // Same gate as Iskay — heavyweight LLM call for management-level analysis.
    if (!hasMinimumRole(role, "directores")) {
      return NextResponse.json({ error: "Manager+ access required for AI analysis" }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const cluster = String(body.cluster || "").trim();
    const nodegroup = String(body.nodegroup || "").trim();
    if (!cluster || !nodegroup) {
      return NextResponse.json({ error: "Missing cluster or nodegroup" }, { status: 400 });
    }

    const result = await analyzeNodegroupWithAI(cluster, nodegroup);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error("[k8s-nodes/analyze] error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to analyze nodegroup with AI" },
      { status: 500 },
    );
  }
}
