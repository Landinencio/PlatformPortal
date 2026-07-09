import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";
import {
  completeFinOpsAdvisorJob,
  createFinOpsAdvisorJob,
  failFinOpsAdvisorJob,
  isMissingFinOpsAdvisorJobsTableError,
  listFinOpsAdvisorJobs,
  markFinOpsAdvisorJobRunning,
  updateFinOpsAdvisorJobProgress,
  type FinOpsAdvisorJobStatus,
} from "@/lib/finops-advisor-jobs";
import {
  normalizeFinOpsAdvisorInput,
  runFinOpsAdvisorAnalysis,
  type FinOpsAdvisorRunInput,
} from "@/lib/finops-advisor-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function processFinOpsAdvisorJob(jobId: string, input: FinOpsAdvisorRunInput) {
  try {
    await markFinOpsAdvisorJobRunning(jobId);

    const result = await runFinOpsAdvisorAnalysis(input, async (progress) => {
      await updateFinOpsAdvisorJobProgress(
        jobId,
        progress.stage,
        progress.progressPct,
        progress.message,
      );
    });

    await completeFinOpsAdvisorJob(jobId, result);
  } catch (error) {
    console.error(`FinOps advisor job ${jobId} failed:`, error);
    await failFinOpsAdvisorJob(
      jobId,
      error instanceof Error ? error.message : "Unexpected job failure",
    );
  }
}

function parseStatus(value: string | null): FinOpsAdvisorJobStatus | undefined {
  if (!value) return undefined;
  if (value === "queued" || value === "running" || value === "completed" || value === "failed") {
    return value;
  }
  return undefined;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const role = getSessionRole(session);
    if (!hasMinimumRole(role, "desarrolladores")) {
      return NextResponse.json({ error: "Editor access required for FinOps advisor" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const rawLimit = Number(searchParams.get("limit") || "20");
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.round(rawLimit))) : 20;
    const statusRaw = searchParams.get("status");
    const status = parseStatus(statusRaw);
    if (statusRaw && !status) {
      return NextResponse.json({ error: "Invalid status filter" }, { status: 400 });
    }

    const scope = searchParams.get("scope") || "mine";
    const isAdmin = role === "admin";
    const includeAll = isAdmin && scope === "all";
    const requesterEmail = String(session.user.email || "unknown@local");

    const jobs = await listFinOpsAdvisorJobs({
      requesterEmail,
      isAdmin: includeAll,
      limit,
      status,
    });

    return NextResponse.json({ jobs, count: jobs.length, scope: includeAll ? "all" : "mine" });
  } catch (error) {
    console.error("FinOps advisor list jobs error:", error);
    if (isMissingFinOpsAdvisorJobsTableError(error)) {
      return NextResponse.json(
        { error: "Missing finops_advisor_jobs table. Apply migration: 2026-03-05_finops_advisor_jobs.sql" },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list advisor jobs" },
      { status: 500 },
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
    if (!hasMinimumRole(role, "desarrolladores")) {
      return NextResponse.json({ error: "Editor access required for FinOps advisor" }, { status: 403 });
    }

    const body = await request.json();
    const input = await normalizeFinOpsAdvisorInput(body);
    const job = await createFinOpsAdvisorJob({
      requestedByEmail: String(session.user.email || "unknown@local"),
      requestedByName: session.user.name || null,
      requestPayload: input,
    });

    void processFinOpsAdvisorJob(job.jobId, input);

    return NextResponse.json(
      {
        jobId: job.jobId,
        status: job.status,
        stage: job.stage,
        progressPct: job.progressPct,
      },
      { status: 202 },
    );
  } catch (error) {
    console.error("FinOps advisor async create job error:", error);
    if (isMissingFinOpsAdvisorJobsTableError(error)) {
      return NextResponse.json(
        { error: "Missing finops_advisor_jobs table. Apply migration: 2026-03-05_finops_advisor_jobs.sql" },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start advisor job" },
      { status: 500 },
    );
  }
}
