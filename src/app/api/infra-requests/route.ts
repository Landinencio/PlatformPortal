import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";
import { createNotificationBatch } from "@/lib/notifications";
import { getNotifyList, ALL_APPROVER_EMAILS } from "@/lib/infra-approvers";
import { teamsApprovedBy, BUSINESS_TEAMS, type BusinessTeam } from "@/lib/team-approvers";
import { sendEmail, buildApprovalRequestEmail } from "@/lib/email";

const RESOURCE_LABELS: Record<string, string> = {
  s3: "S3 Bucket",
  rds: "RDS Database",
  lambda: "Lambda Function",
  iam_role: "IAM Role",
};

// GET /api/infra-requests — list requests (approvers see pending, users see their own)
export async function GET(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const email = auth.session.user?.email?.toLowerCase() || "";
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");

  // Domain migration: normalize email for approver check
  const normalizedEmail = email.replace("@emefinpetcare.com", "@iskaypet.com");
  const isApproverUser = ALL_APPROVER_EMAILS.includes(normalizedEmail);

  // Team approvers (e.g. francisca.suarez for data, alberto.salomon for marktech).
  // They aren't in the global ALL_APPROVER_EMAILS list, so we treat them as
  // approvers scoped to the teams they cover.
  const approverTeams: BusinessTeam[] = isApproverUser
    ? ([...BUSINESS_TEAMS] as BusinessTeam[])
    : teamsApprovedBy(email);
  const isTeamApproverUser = !isApproverUser && approverTeams.length > 0;
  const isAnyApprover = isApproverUser || isTeamApproverUser;

  // For regular users, search both domains
  const altEmail = email.includes("@emefinpetcare.com")
    ? email.replace("@emefinpetcare.com", "@iskaypet.com")
    : email.includes("@iskaypet.com")
    ? email.replace("@iskaypet.com", "@emefinpetcare.com")
    : null;
  const userEmails = altEmail ? [email, altEmail] : [email];

  let infraQuery: string;
  let infraParams: any[];
  let accessQuery: string;
  let accessParams: any[];

  // For access requests: also show pending ones where current user is the approver
  const localPart = email.split("@")[0];

  if (isApproverUser) {
    if (status) {
      infraQuery = `SELECT * FROM infra_requests WHERE status = $1 ORDER BY created_at DESC LIMIT 100`;
      infraParams = [status];
      accessQuery = `SELECT * FROM access_requests WHERE status = $1 ORDER BY created_at DESC LIMIT 100`;
      accessParams = [status];
    } else {
      infraQuery = `SELECT * FROM infra_requests ORDER BY created_at DESC LIMIT 100`;
      infraParams = [];
      accessQuery = `SELECT * FROM access_requests ORDER BY created_at DESC LIMIT 100`;
      accessParams = [];
    }
  } else if (isTeamApproverUser) {
    // Team approver: see requests scoped to their team(s) PLUS their own
    if (status) {
      infraQuery = `SELECT * FROM infra_requests WHERE (team = ANY($2) OR requestor_email = ANY($1)) AND status = $3 ORDER BY created_at DESC LIMIT 100`;
      infraParams = [userEmails, approverTeams, status];
      accessQuery = `SELECT * FROM access_requests WHERE (business_team = ANY($2) OR requestor_email = ANY($1) OR LOWER(SPLIT_PART(approver_email, '@', 1)) = $4) AND status = $3 ORDER BY created_at DESC LIMIT 100`;
      accessParams = [userEmails, approverTeams, status, localPart];
    } else {
      infraQuery = `SELECT * FROM infra_requests WHERE team = ANY($2) OR requestor_email = ANY($1) ORDER BY created_at DESC LIMIT 100`;
      infraParams = [userEmails, approverTeams];
      accessQuery = `SELECT * FROM access_requests WHERE business_team = ANY($2) OR requestor_email = ANY($1) OR LOWER(SPLIT_PART(approver_email, '@', 1)) = $3 ORDER BY created_at DESC LIMIT 100`;
      accessParams = [userEmails, approverTeams, localPart];
    }
  } else {
    if (status) {
      infraQuery = `SELECT * FROM infra_requests WHERE requestor_email = ANY($1) AND status = $2 ORDER BY created_at DESC LIMIT 50`;
      infraParams = [userEmails, status];
      accessQuery = `SELECT * FROM access_requests WHERE (requestor_email = ANY($1) OR LOWER(SPLIT_PART(approver_email, '@', 1)) = $3) AND status = $2 ORDER BY created_at DESC LIMIT 50`;
      accessParams = [userEmails, status, localPart];
    } else {
      infraQuery = `SELECT * FROM infra_requests WHERE requestor_email = ANY($1) ORDER BY created_at DESC LIMIT 50`;
      infraParams = [userEmails];
      accessQuery = `SELECT * FROM access_requests WHERE (requestor_email = ANY($1) OR LOWER(SPLIT_PART(approver_email, '@', 1)) = $2) ORDER BY created_at DESC LIMIT 50`;
      accessParams = [userEmails, localPart];
    }
  }

  const [infraResult, accessResult] = await Promise.all([
    pool.query(infraQuery, infraParams),
    pool.query(accessQuery, accessParams),
  ]);

  // Normalize access requests to a compatible shape
  const accessRows = accessResult.rows.map((row: any) => ({
    ...row,
    _type: "access",
    resource_type: row.platform || "access",
    team: row.business_team || "",
    requestor_name: null,
    payload: JSON.stringify({
      platform: row.platform,
      targetUserEmail: row.target_user_email,
      requestType: row.request_type,
      groupName: row.group_name,
      role: row.role,
    }),
    ai_conversation: null,
    terraform_preview: null,
    gitlab_mr_url: null,
    gitlab_branch: null,
    jira_key: null,
    executed_at: row.reviewed_at,
  }));

  const infraRows = infraResult.rows.map((row: any) => ({ ...row, _type: "infra" }));

  // Merge and sort by created_at DESC
  const allRequests = [...infraRows, ...accessRows].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return NextResponse.json({ requests: allRequests, isApprover: isAnyApprover });
}

// POST /api/infra-requests — create a new infra request (pending approval)
export async function POST(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  try {
    const email = auth.session.user?.email || "";
    const name = auth.session.user?.name || "";
    const body = await request.json();

    const { resource_type, team, approver } = body;
    if (!resource_type || !team) {
      return NextResponse.json({ error: "resource_type and team are required" }, { status: 400 });
    }

    const resourceName = body.bucket_name || body.identifier || body.function_name || body.role_name || "unknown";
    const resourceLabel = RESOURCE_LABELS[resource_type] || resource_type;
    const costInfo = body.estimated_cost_monthly > 0
      ? ` | Coste estimado: ~$${body.estimated_cost_monthly}/mes`
      : "";

    // Insert the request
    const { rows } = await pool.query(
      `INSERT INTO infra_requests (resource_type, team, requestor_email, requestor_name, payload)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [resource_type, team, email, name, JSON.stringify(body)]
    );
    const requestId = rows[0].id;

    // Notify: selected approver + always-notified (architect + director)
    const notifyEmails = getNotifyList(approver || "");
    const costSummary = [
      body.cost_specs,
      body.cost_breakdown,
      body.estimated_cost_monthly > 0 ? `~$${body.estimated_cost_monthly}/mes` : null,
      body.cost_billing_warning,
      body.cost_recommendation ? `💡 ${body.cost_recommendation}` : null,
    ].filter(Boolean).join("\n");

    try {
      await createNotificationBatch(
        notifyEmails.map((approverEmail) => ({
          userEmail: approverEmail,
          type: "approval_request" as const,
          title: `Nueva solicitud de ${resourceLabel}${costInfo}`,
          message: `${name || email} solicita crear ${resourceLabel} "${resourceName}" para el equipo ${team}.\n${costSummary}`,
          link: `/infra-requests`,
          metadata: { requestId, resource_type, team, resourceName, requestor: email, estimatedCost: body.estimated_cost_monthly, specs: body.cost_specs, environments: body.target_environments },
        }))
      );
    } catch (notifErr) {
      console.error("Failed to create approver notifications:", notifErr);
    }

    // Notify the requestor
    try {
      await createNotificationBatch([{
        userEmail: email,
        type: "info" as const,
        title: `Solicitud enviada: ${resourceLabel}`,
        message: `Tu solicitud de ${resourceLabel} "${resourceName}" está pendiente de aprobación.`,
        link: `/infra-requests`,
        metadata: { requestId },
      }]);
    } catch (notifErr) {
      console.error("Failed to create requestor notification:", notifErr);
    }

    // Send email to approvers (fire-and-forget)
    const portalUrl = process.env.NEXTAUTH_URL || "https://portal.today.tooling.dp.iskaypet.com";
    const emailContent = buildApprovalRequestEmail({
      resourceType: resource_type,
      resourceName,
      team,
      requestorName: name || email,
      requestorEmail: email,
      portalUrl,
      estimatedCost: body.estimated_cost_monthly,
      costBreakdown: body.cost_breakdown,
      costSpecs: body.cost_specs,
      costDetails: body.cost_details,
      costBillingWarning: body.cost_billing_warning,
      costRecommendation: body.cost_recommendation,
      environments: body.target_environments,
    });
    sendEmail({ to: notifyEmails, ...emailContent }).catch((e) => console.error("SES error:", e));

    return NextResponse.json({ id: requestId, status: "pending" });
  } catch (err) {
    console.error("infra-requests POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
