import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";
import { createNotificationBatch } from "@/lib/notifications";
import { getNotifyList } from "@/lib/infra-approvers";
import { sendEmail, buildApprovalRequestEmail } from "@/lib/email";

// POST /api/infra-assistant/submit — persist AI-generated infra request for approval
export async function POST(request: Request) {
  console.log(`[submit] ▶ Request received`)
  const auth = await requireUserAuth(request);
  if (auth.error) { console.log(`[submit] ✗ Auth failed`); return auth.error; }

  try {
    const email = auth.session.user?.email || "";
    const name = auth.session.user?.name || "";
    const body = await request.json();

    const { conversationId, conversation, terraformPreview, team, approver } = body;
    console.log(`[submit] User=${email}, Team=${team}, Type=${terraformPreview?.resourceType}, Approver=${approver}`)

    if (!conversationId || !conversation || !terraformPreview || !team || !approver) {
      return NextResponse.json(
        { error: "conversationId, conversation, terraformPreview, team, and approver are required" },
        { status: 400 }
      );
    }

    const { resourceType, resourceName, targetEnvironments } = terraformPreview;

    const { rows } = await pool.query(
      `INSERT INTO infra_requests
         (requestor_email, team, resource_type, payload,
          status, ai_conversation, terraform_preview)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)
       RETURNING id`,
      [
        email,
        team,
        resourceType,
        JSON.stringify({
          identifier: resourceName,
          target_environments: targetEnvironments,
          approver: (approver || "").toLowerCase(),
          source: 'ai-assistant-v2',
        }),
        JSON.stringify(conversation),
        JSON.stringify({ ...terraformPreview, generatedAt: new Date().toISOString() }),
      ]
    );
    const requestId = rows[0].id;
    console.log(`[submit] ✓ Request #${requestId} created (status=pending, team=${team}, type=${terraformPreview?.resourceType})`)

    // Notify approvers (selected + always-notified)
    const notifyEmails = getNotifyList(approver);
    const resourceLabel = resourceType.toUpperCase();

    try {
      await createNotificationBatch(
        notifyEmails.map((approverEmail) => ({
          userEmail: approverEmail,
          type: "approval_request" as const,
          title: `Nueva solicitud de ${resourceLabel} (AI Assistant)`,
          message: `${name || email} solicita crear ${resourceLabel} "${resourceName}" para el equipo ${team}.`,
          link: `/infra-requests`,
          metadata: { requestId, resource_type: resourceType, team, resourceName, requestor: email },
        }))
      );
      console.log(`[submit] ✓ Approver notifications sent to: ${notifyEmails.join(', ')}`)
    } catch (notifErr) {
      console.error(`[submit] ✗ Failed to create approver notifications:`, notifErr);
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
      resourceType,
      resourceName,
      team,
      requestorName: name || email,
      requestorEmail: email,
      portalUrl,
      environments: targetEnvironments,
    });
    sendEmail({ to: notifyEmails, ...emailContent }).catch((e) =>
      console.error("SES error:", e)
    );

    console.log(`[submit] ✓ Complete. Request #${requestId} pending approval`)
    return NextResponse.json({ id: requestId, status: "pending" });
  } catch (err) {
    console.error("[submit] ✗ POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
