import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";
import { createNotification } from "@/lib/notifications";
import { isApprover } from "@/lib/infra-approvers";
import { teamsApprovedBy, isSoleApprover, type BusinessTeam } from "@/lib/team-approvers";
import { emailsMatch } from "@/lib/access-management/domain-normalizer";

// POST /api/access-management/[id]/review — approve or reject
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  console.log(`[access-review] ▶ Request received for id=${params.id}`);
  const auth = await requireUserAuth(request);
  if (auth.error) {
    console.log(`[access-review] ✗ Auth failed`);
    return auth.error;
  }

  const reviewerEmail = auth.session.user?.email?.toLowerCase() || "";
  const reviewerName = auth.session.user?.name || "";
  console.log(`[access-review] Reviewer=${reviewerEmail}`);

  if (!isApprover(reviewerEmail)) {
    // Not a global approver. Allow if EITHER:
    //  (a) reviewer is a team approver for the request's business_team, OR
    //  (b) reviewer is the explicitly designated approver_email of this request.
    const { rows: reqRows } = await pool.query(
      `SELECT approver_email, business_team FROM access_requests WHERE id = $1`,
      [Number(params.id)]
    );
    const designatedApprover = reqRows[0]?.approver_email?.toLowerCase() || "";
    const requestTeam = (reqRows[0]?.business_team || "").toLowerCase();

    const reviewerTeams = teamsApprovedBy(reviewerEmail).map((tm) => tm.toLowerCase());
    const coversTeam = requestTeam && reviewerTeams.includes(requestTeam);
    const isDesignated = designatedApprover && emailsMatch(reviewerEmail, designatedApprover);

    if (!coversTeam && !isDesignated) {
      console.log(`[access-review] ✗ ${reviewerEmail} not authorized (team=${requestTeam}, designated=${designatedApprover})`);
      return NextResponse.json(
        { error: "Not authorized to review requests" },
        { status: 403 }
      );
    }
    console.log(`[access-review] ✓ ${reviewerEmail} authorized (coversTeam=${coversTeam}, isDesignated=${!!isDesignated})`);
  }

  const body = await request.json();
  const { action, comment } = body as {
    action: "approve" | "reject";
    comment?: string;
  };

  if (action !== "approve" && action !== "reject") {
    return NextResponse.json(
      { error: "action must be approve or reject" },
      { status: 400 }
    );
  }

  const requestId = Number(params.id);

  // Get the access request
  const { rows } = await pool.query(
    `SELECT * FROM access_requests WHERE id = $1`,
    [requestId]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }

  const accessRequest = rows[0];

  if (accessRequest.status !== "pending") {
    return NextResponse.json(
      { error: `Request already ${accessRequest.status}` },
      { status: 409 }
    );
  }

  // Self-approval prevention using domain normalizer.
  // EXCEPTION: a one-person team's sole approver may approve their own request — there
  // is no one else to do it (e.g. MarTech / alberto.salomon). Scoped strictly to the
  // case where the reviewer is the ONLY configured approver of the request's team.
  if (emailsMatch(accessRequest.requestor_email, reviewerEmail)) {
    const requestTeam = (accessRequest.business_team || "") as BusinessTeam;
    const soleApprover = requestTeam && isSoleApprover(requestTeam, reviewerEmail);
    if (!soleApprover) {
      console.log(
        `[access-review/${requestId}] ✗ Self-approval blocked: ${reviewerEmail}`
      );
      return NextResponse.json(
        { error: "You cannot approve your own request" },
        { status: 403 }
      );
    }
    console.log(
      `[access-review/${requestId}] ✓ Self-approval allowed: ${reviewerEmail} is the sole approver of team '${requestTeam}'`
    );
  }

  const newStatus = action === "approve" ? "approved" : "rejected";

  // Atomic status transition — guards against concurrent approve/reject/cancel
  // (TOCTOU): only one writer can move the row away from 'pending'.
  console.log(
    `[access-review/${requestId}] Updating status to ${newStatus}, reviewer=${reviewerEmail}`
  );
  const { rowCount } = await pool.query(
    `UPDATE access_requests SET status = $1, reviewer_email = $2, reviewer_name = $3, review_comment = $4, reviewed_at = NOW(), updated_at = NOW() WHERE id = $5 AND status = 'pending'`,
    [newStatus, reviewerEmail, reviewerName, comment || null, requestId]
  );
  if (rowCount === 0) {
    return NextResponse.json(
      { error: "Request is no longer pending" },
      { status: 409 }
    );
  }
  console.log(`[access-review/${requestId}] ✓ Status updated to ${newStatus}`);

  // If approved, trigger the execute endpoint internally (fire-and-forget)
  if (action === "approve") {
    const executeUrl = `http://localhost:3000/api/access-management/execute/${requestId}`;
    const secret = process.env.INTERNAL_API_SECRET || "";
    console.log(
      `[access-review/${requestId}] ✓ Triggering execute at ${executeUrl} (secret length: ${secret.length})`
    );
    fetch(executeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": secret,
      },
      body: JSON.stringify({
        approvedByEmail: reviewerEmail,
        approvedByName: reviewerName,
      }),
    })
      .then(async (res) => {
        const responseBody = await res.text().catch(() => "");
        console.log(
          `[access-review/${requestId}] Execute response: ${res.status} ${responseBody.slice(0, 200)}`
        );
      })
      .catch((err) =>
        console.error(
          `[access-review/${requestId}] ✗ Execute trigger FAILED:`,
          err
        )
      );
  } else {
    console.log(
      `[access-review/${requestId}] Action is ${action}, not triggering execute`
    );
  }

  // Notify the requestor (in-app)
  const resourceName =
    accessRequest.group_name || accessRequest.platform || "recurso";
  await createNotification({
    userEmail: accessRequest.requestor_email,
    type: "approval_result",
    title:
      action === "approve"
        ? `Solicitud de acceso aprobada: ${resourceName}`
        : `Solicitud de acceso rechazada: ${resourceName}`,
    message:
      action === "approve"
        ? `${reviewerName || reviewerEmail} ha aprobado tu solicitud de acceso a ${accessRequest.platform}. El acceso se está configurando.`
        : `${reviewerName || reviewerEmail} ha rechazado tu solicitud de acceso a ${accessRequest.platform}.${comment ? ` Motivo: ${comment}` : ""}`,
    link: `/access-management`,
    metadata: { requestId, action, reviewer: reviewerEmail },
  });

  return NextResponse.json({ id: requestId, status: newStatus });
}
