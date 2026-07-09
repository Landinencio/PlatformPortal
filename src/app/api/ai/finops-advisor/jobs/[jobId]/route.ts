import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";
import { getFinOpsAdvisorJob, isMissingFinOpsAdvisorJobsTableError } from "@/lib/finops-advisor-jobs";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: {
    jobId: string;
  };
};

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const role = getSessionRole(session);
    if (!hasMinimumRole(role, "desarrolladores")) {
      return NextResponse.json({ error: "Editor access required for FinOps advisor" }, { status: 403 });
    }

    const job = await getFinOpsAdvisorJob(context.params.jobId);
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const requesterEmail = String(session.user.email || "").toLowerCase();
    const ownerEmail = String(job.requestedByEmail || "").toLowerCase();
    if (role !== "admin" && requesterEmail !== ownerEmail) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json(job);
  } catch (error) {
    console.error("FinOps advisor get job error:", error);
    if (isMissingFinOpsAdvisorJobsTableError(error)) {
      return NextResponse.json(
        { error: "Missing finops_advisor_jobs table. Apply migration: 2026-03-05_finops_advisor_jobs.sql" },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch advisor job" },
      { status: 500 },
    );
  }
}
