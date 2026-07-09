import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import type { CyberReportType } from "@/lib/cybersecurity";
import { getCybersecurityReport } from "@/lib/cybersecurity";
import { ENABLE_CYBERSECURITY } from "@/lib/feature-flags";
import { hasSessionMinimumRole } from "@/lib/session-role";

export const dynamic = "force-dynamic";

function isCyberReportType(value: string | null): value is CyberReportType {
  return value === "vpn_groups" || value === "inactive_users_90d" || value === "users_without_mfa_group";
}

export async function GET(request: Request) {
  if (!ENABLE_CYBERSECURITY) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasSessionMinimumRole(session, "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const reportType = searchParams.get("reportType");
  const runIdParam = searchParams.get("runId");

  if (!isCyberReportType(reportType)) {
    return NextResponse.json({ error: "Invalid reportType" }, { status: 400 });
  }

  const runId = runIdParam && runIdParam !== "latest" ? Number(runIdParam) : undefined;

  try {
    const report = await getCybersecurityReport(reportType, runId);
    if (!report) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }
    return NextResponse.json(report);
  } catch (error) {
    console.error("Cybersecurity report error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.includes("schema is not ready") ? 503 : 500;

    return NextResponse.json(
      {
        error: "Failed to load cybersecurity report",
        details: message,
      },
      { status }
    );
  }
}
