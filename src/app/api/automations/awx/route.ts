import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";

export const dynamic = "force-dynamic";

const AWX_API = process.env.AWX_API || "https://awx-ansible.tooling.dp.iskaypet.com/api/v2";
const AWX_TOKEN = process.env.AWX_TOKEN || "";

async function awxFetch(endpoint: string, options?: RequestInit) {
  const res = await fetch(`${AWX_API}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${AWX_TOKEN}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AWX ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    const role = getSessionRole(session);
    if (!hasMinimumRole(role, "staff")) {
      return NextResponse.json({ error: "Editor access required" }, { status: 403 });
    }

    const data = await awxFetch("/job_templates/?page_size=200");
    const templates = (data.results || []).map((t: any) => ({
      id: t.id,
      name: t.name,
      description: t.description || "",
      project: t.summary_fields?.project?.name || "Unknown",
      inventory: t.summary_fields?.inventory?.name || "",
      status: t.status,
      lastRun: t.last_job_run,
      surveyEnabled: t.survey_enabled,
      askVariables: t.ask_variables_on_launch,
      askLimit: t.ask_limit_on_launch,
    }));

    return NextResponse.json({ templates, count: templates.length });
  } catch (error) {
    console.error("AWX API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch AWX templates" },
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
    const { templateId, extraVars, limit } = body;

    if (!templateId) {
      return NextResponse.json({ error: "templateId is required" }, { status: 400 });
    }

    const launchPayload: any = {};
    if (extraVars) launchPayload.extra_vars = extraVars;
    if (limit) launchPayload.limit = limit;

    const result = await awxFetch(`/job_templates/${templateId}/launch/`, {
      method: "POST",
      body: JSON.stringify(launchPayload),
    });

    return NextResponse.json({
      jobId: result.id,
      status: result.status,
      url: `${AWX_API.replace("/api/v2", "")}/#/jobs/playbook/${result.id}`,
      launchedBy: session.user.email || session.user.name,
    });
  } catch (error) {
    console.error("AWX launch error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to launch AWX job" },
      { status: 500 }
    );
  }
}
