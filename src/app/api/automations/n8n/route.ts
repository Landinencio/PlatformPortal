import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";

export const dynamic = "force-dynamic";

const N8N_BASE = process.env.N8N_INTERNAL_URL || "http://n8n.n8n.svc.cluster.local";

/** Known n8n webhook workflows that can be triggered from the portal */
const N8N_WORKFLOWS: Record<string, { webhook: string; name: string }> = {
  "cyber-inactive-users": {
    webhook: "/webhook/azure-inactive-users",
    name: "Azure AD: Inactive Users (+90 days)",
  },
  "cyber-mfa-users": {
    webhook: "/webhook/azure-mfa-check",
    name: "Azure AD: Users without MFA",
  },
  "cyber-vpn-groups": {
    webhook: "/webhook/azure-vpn-groups-report",
    name: "Azure AD: VPN Groups Report",
  },
  "create-repo": {
    webhook: "/webhook/create-repo",
    name: "Create GitLab Repository",
  },
  "user-onboarding": {
    webhook: "/webhook/user-onboarding",
    name: "User Onboarding",
  },
};

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const workflows = Object.entries(N8N_WORKFLOWS).map(([id, wf]) => ({
      id,
      name: wf.name,
      type: "n8n-webhook",
    }));

    return NextResponse.json({ workflows });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list n8n workflows" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    const role = getSessionRole(session);
    if (!hasMinimumRole(role, "staff")) {
      return NextResponse.json({ error: "Editor access required" }, { status: 403 });
    }

    const body = await request.json();
    const { workflowId, payload } = body;

    const workflow = N8N_WORKFLOWS[workflowId];
    if (!workflow) {
      return NextResponse.json({ error: `Unknown workflow: ${workflowId}` }, { status: 400 });
    }

    const res = await fetch(`${N8N_BASE}${workflow.webhook}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        triggeredBy: session.user.email || session.user.name,
        triggeredAt: new Date().toISOString(),
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`n8n ${res.status}: ${text.slice(0, 200)}`);
    }

    const result = await res.json().catch(() => ({ ok: true }));

    return NextResponse.json({
      success: true,
      workflowId,
      workflowName: workflow.name,
      result,
      triggeredBy: session.user.email || session.user.name,
    });
  } catch (error) {
    console.error("n8n trigger error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to trigger n8n workflow" },
      { status: 500 }
    );
  }
}
