import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";
import { createNotification } from "@/lib/notifications";
import { isApprover } from "@/lib/infra-approvers";
import { teamsApprovedBy } from "@/lib/team-approvers";
import { emailsMatch } from "@/lib/access-management/domain-normalizer";
import { sendEmail, buildApprovalResultEmail } from "@/lib/email";

// POST /api/infra-requests/[id]/review — approve or reject
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  console.log(`[review] ▶ Request received for id=${params.id}`)
  const auth = await requireUserAuth(request);
  if (auth.error) { console.log(`[review] ✗ Auth failed`); return auth.error; }

  const reviewerEmail = auth.session.user?.email?.toLowerCase() || "";
  const reviewerName = auth.session.user?.name || "";
  console.log(`[review] Reviewer=${reviewerEmail}`)

  const requestId = Number(params.id);

  if (!isApprover(reviewerEmail)) {
    // Not a global approver. Allow if reviewer is a team approver for THIS
    // request's team, or the designated approver stored in the payload.
    const { rows: reqRows } = await pool.query(
      `SELECT team, payload FROM infra_requests WHERE id = $1`,
      [requestId]
    );
    if (reqRows.length === 0) {
      return NextResponse.json({ error: "Request not found" }, { status: 404 });
    }
    const requestTeam = (reqRows[0]?.team || "").toLowerCase();
    const payloadObj = typeof reqRows[0]?.payload === "string"
      ? JSON.parse(reqRows[0].payload)
      : (reqRows[0]?.payload || {});
    const designatedApprover = (payloadObj?.approver || "").toLowerCase();

    const reviewerTeams = teamsApprovedBy(reviewerEmail).map((tm) => tm.toLowerCase());
    const coversTeam = requestTeam && reviewerTeams.includes(requestTeam);
    const isDesignated = designatedApprover && emailsMatch(reviewerEmail, designatedApprover);

    if (!coversTeam && !isDesignated) {
      console.log(`[review] ✗ ${reviewerEmail} not authorized (team=${requestTeam}, designated=${designatedApprover})`);
      return NextResponse.json({ error: "Not authorized to review requests" }, { status: 403 });
    }
    console.log(`[review] ✓ ${reviewerEmail} authorized (coversTeam=${coversTeam}, isDesignated=${!!isDesignated})`);
  }

  const body = await request.json();
  const { action, comment } = body as { action: "approve" | "reject"; comment?: string };

  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "action must be approve or reject" }, { status: 400 });
  }

  // Get the request
  const { rows } = await pool.query(
    `SELECT * FROM infra_requests WHERE id = $1`,
    [requestId]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }

  const infra = rows[0];

  if (infra.status !== "pending") {
    return NextResponse.json({ error: `Request already ${infra.status}` }, { status: 409 });
  }

  // Cannot approve your own request (normalize domain for iskaypet ↔ emefinpetcare migration)
  const normalizeEmail = (e: string) => e.toLowerCase().replace("@emefinpetcare.com", "@iskaypet.com");
  if (normalizeEmail(infra.requestor_email) === normalizeEmail(reviewerEmail)) {
    console.log(`[review/${requestId}] ✗ Self-approval blocked: ${reviewerEmail}`)
    return NextResponse.json({ error: "You cannot approve your own request" }, { status: 403 });
  }

  const newStatus = action === "approve" ? "approved" : "rejected";

  // Atomic status transition — guards against a concurrent approve/reject/cancel
  // (TOCTOU): only one reviewer can flip the row away from 'pending'.
  console.log(`[review/${requestId}] Updating status to ${newStatus}, reviewer=${reviewerEmail}`)
  const { rowCount } = await pool.query(
    `UPDATE infra_requests SET status = $1, reviewer_email = $2, reviewer_name = $3, review_comment = $4, reviewed_at = NOW() WHERE id = $5 AND status = 'pending'`,
    [newStatus, reviewerEmail, reviewerName, comment || null, requestId]
  );
  if (rowCount === 0) {
    return NextResponse.json({ error: "Request is no longer pending" }, { status: 409 });
  }
  console.log(`[review/${requestId}] ✓ Status updated to ${newStatus}`)

  const payload = typeof infra.payload === "string" ? JSON.parse(infra.payload) : infra.payload;
  const resourceName = payload.bucket_name || payload.identifier || payload.function_name || payload.role_name || "recurso";

  // If approved, trigger the execute endpoint internally (fire-and-forget)
  if (action === "approve") {
    const executeUrl = `http://localhost:3000/api/infra-assistant/execute/${requestId}`
    const secret = process.env.INTERNAL_API_SECRET || ""
    console.log(`[review/${requestId}] ✓ Triggering execute at ${executeUrl} (secret length: ${secret.length})`)
    fetch(executeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": secret,
      },
      body: JSON.stringify({ approvedByEmail: reviewerEmail, approvedByName: reviewerName }),
    })
      .then(async (res) => {
        const body = await res.text().catch(() => "")
        console.log(`[review/${requestId}] Execute response: ${res.status} ${body.slice(0, 200)}`)
      })
      .catch((err) => console.error(`[review/${requestId}] ✗ Execute trigger FAILED:`, err))
  } else {
    console.log(`[review/${requestId}] Action is ${action}, not triggering execute`)
  }

  // Notify the requestor (in-app)
  await createNotification({
    userEmail: infra.requestor_email,
    type: "approval_result",
    title: action === "approve"
      ? `Solicitud aprobada: ${resourceName}`
      : `Solicitud rechazada: ${resourceName}`,
    message: action === "approve"
      ? `${reviewerName || reviewerEmail} ha aprobado tu solicitud de ${infra.resource_type}. El recurso se está creando.`
      : `${reviewerName || reviewerEmail} ha rechazado tu solicitud de ${infra.resource_type}.${comment ? ` Motivo: ${comment}` : ""}`,
    link: `/infra-requests`,
    metadata: { requestId, action, reviewer: reviewerEmail },
  });

  // Send email to the requestor
  const portalUrl = process.env.NEXTAUTH_URL || "https://portal.today.tooling.dp.iskaypet.com";
  const emailContent = buildApprovalResultEmail({
    approved: action === "approve",
    resourceType: infra.resource_type,
    resourceName,
    reviewerName: reviewerName || reviewerEmail,
    comment: comment || undefined,
    portalUrl,
  });
  sendEmail({ to: [infra.requestor_email], ...emailContent }).catch(() => {});

  return NextResponse.json({ id: requestId, status: newStatus });
}
