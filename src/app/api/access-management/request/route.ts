import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";
import { trackUserActivity } from "@/lib/user-activity";
import { getSessionRole } from "@/lib/session-role";
import { validateAccessRequestPayload, AccessRequestPayload } from "@/lib/access-management/request-validation";
import { createNotification } from "@/lib/notifications";
import { sendEmail } from "@/lib/email";

/**
 * POST /api/access-management/request
 *
 * Creates an access request with status "pending" and notifies the approver.
 * The access is NOT executed until the approver approves it.
 *
 * Flow: validate → insert DB (status=pending) → Jira ticket → Teams webhook → portal notification
 */
export async function POST(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  try {
    const email = auth.session.user?.email || "";
    const name = auth.session.user?.name || "";
    const body = await request.json();

    // Validate payload
    const validationError = validateAccessRequestPayload(body);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const { platform, targetUserEmail, requestType, groupId, groupName, role } =
      body as AccessRequestPayload;

    const businessTeam: string = body.businessTeam || "";
    const approverEmail: string = body.approverEmail || "";

    if (!businessTeam) {
      return NextResponse.json({ error: "businessTeam is required" }, { status: 400 });
    }
    if (!approverEmail) {
      return NextResponse.json({ error: "approverEmail is required" }, { status: 400 });
    }

    // Insert into access_requests table with status "pending"
    const { rows } = await pool.query(
      `INSERT INTO access_requests (
        requestor_email, target_user_email, platform, request_type,
        group_id, group_name, role, approver_email, status, business_team
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
      RETURNING id`,
      [
        email.toLowerCase(),
        targetUserEmail.toLowerCase(),
        platform,
        requestType,
        groupId || null,
        groupName || null,
        role || null,
        approverEmail.toLowerCase(),
        businessTeam,
      ]
    );
    const requestId = rows[0].id;

    // 1. Notify approver via Teams (lightweight — just "pending request" notification, no ticket yet)
    const teamsWebhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (teamsWebhookUrl) {
      const isOnboardOffboard = requestType === "onboard" || requestType === "offboard";
      const isKiroLicense = requestType === "kiro-license";

      let teamsTitle: string;
      let teamsFacts: Array<{ title: string; value: string }>;

      if (isKiroLicense) {
        teamsTitle = "🎫 Solicitud pendiente: Licencias Kiro IDE";
        teamsFacts = [
          { title: "Solicitante", value: email },
          { title: "Usuarios", value: targetUserEmail },
          { title: "Cantidad", value: String(body.licenseCount || 1) },
          { title: "Equipo", value: businessTeam },
          { title: "Aprobador", value: approverEmail },
        ];
      } else if (isOnboardOffboard) {
        teamsTitle = `⏳ Solicitud pendiente: GitLab ${requestType === "onboard" ? "Alta" : "Baja"}`;
        teamsFacts = [
          { title: "Solicitante", value: email },
          { title: "Usuario", value: targetUserEmail },
          { title: "Plataforma", value: "GitLab" },
          { title: "Tipo", value: requestType === "onboard" ? "Alta" : "Baja" },
          { title: "Equipo", value: businessTeam },
          { title: "Aprobador", value: approverEmail },
        ];
      } else {
        teamsTitle = "⏳ Solicitud pendiente: Acceso a plataforma";
        teamsFacts = [
          { title: "Solicitante", value: email },
          { title: "Usuario", value: targetUserEmail },
          { title: "Plataforma", value: platform },
          { title: "Grupo", value: groupName || "" },
          { title: "Equipo", value: businessTeam },
          { title: "Aprobador", value: approverEmail },
        ];
      }

      fetch(teamsWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "message",
          attachments: [{
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
              type: "AdaptiveCard",
              version: "1.4",
              body: [
                { type: "TextBlock", text: teamsTitle, weight: "Bolder", size: "Medium" },
                { type: "FactSet", facts: teamsFacts },
              ],
            },
          }],
        }),
      }).catch((err) => console.error("Teams webhook failed:", err));
    }

    // 2. Create portal notification for the approver
    try {
      const isOnboardOffboard = requestType === "onboard" || requestType === "offboard";
      const isKiroLicense = requestType === "kiro-license";

      let notifMessage: string;
      if (isKiroLicense) {
        notifMessage = `${name || email} solicita ${body.licenseCount || 1} licencia(s) Kiro IDE para su equipo (${businessTeam}).`;
      } else if (isOnboardOffboard) {
        notifMessage = `${name || email} solicita ${requestType === "onboard" ? "alta" : "baja"} GitLab para ${targetUserEmail}. Equipo: ${businessTeam}.`;
      } else {
        notifMessage = `${name || email} solicita acceso ${platform}/${groupName} para ${targetUserEmail}. Equipo: ${businessTeam}.`;
      }

      await createNotification({
        userEmail: approverEmail,
        type: "approval_request",
        title: "Nueva solicitud pendiente de aprobación",
        message: notifMessage,
        link: "/infra-requests",
        metadata: { requestId, platform, groupName: groupName || null, businessTeam, requestType },
      });
    } catch (notifErr) {
      console.error(`[access-request/${requestId}] Notification creation failed:`, notifErr);
    }

    // 3. Send email to approver (fire-and-forget)
    try {
      const isOnboardOffboard = requestType === "onboard" || requestType === "offboard";
      const isKiroLicense = requestType === "kiro-license";

      let emailSubject: string;
      let emailBody: string;

      if (isKiroLicense) {
        emailSubject = `[Portal] Solicitud de licencias Kiro IDE — ${businessTeam}`;
        emailBody = `Hola,\n\n${name || email} ha solicitado ${body.licenseCount || 1} licencia(s) Kiro IDE para el equipo ${businessTeam}.\n\nUsuarios: ${targetUserEmail}\n\nAccede al portal para aprobar o rechazar:\nhttps://portal.today.tooling.dp.iskaypet.com/infra-requests\n\nSaludos,\nPortal de Plataforma`;
      } else if (isOnboardOffboard) {
        emailSubject = `[Portal] ${requestType === "onboard" ? "Alta" : "Baja"} GitLab — ${targetUserEmail}`;
        emailBody = `Hola,\n\n${name || email} ha solicitado ${requestType === "onboard" ? "dar de alta" : "dar de baja"} en GitLab a ${targetUserEmail}.\n\nEquipo: ${businessTeam}\n\nAccede al portal para aprobar o rechazar:\nhttps://portal.today.tooling.dp.iskaypet.com/infra-requests\n\nSaludos,\nPortal de Plataforma`;
      } else {
        emailSubject = `[Portal] Solicitud de acceso — ${platform.toUpperCase()} / ${groupName}`;
        emailBody = `Hola,\n\n${name || email} ha solicitado acceso a ${platform.toUpperCase()} para ${targetUserEmail}.\n\nGrupo: ${groupName}\nRol: ${role || "N/A"}\nEquipo: ${businessTeam}\n\nAccede al portal para aprobar o rechazar:\nhttps://portal.today.tooling.dp.iskaypet.com/infra-requests\n\nSaludos,\nPortal de Plataforma`;
      }

      sendEmail({
        to: [approverEmail],
        subject: emailSubject,
        bodyText: emailBody,
        bodyHtml: emailBody.replace(/\n/g, "<br>"),
      }).catch((err) => console.error(`[access-request/${requestId}] Email send failed:`, err));
    } catch (emailErr) {
      console.error(`[access-request/${requestId}] Email preparation failed:`, emailErr);
    }

    // Track user activity
    try {
      const userRole = getSessionRole(auth.session);
      await trackUserActivity({
        eventType: "api_action",
        userEmail: email,
        userName: name || null,
        userRole,
        path: "/api/access-management/request",
        action: "access_request_submit",
        metadata: {
          requestId,
          platform,
          requestType,
          targetUserEmail,
          groupId: groupId || null,
          groupName: groupName || null,
          businessTeam,
          approverEmail,
        },
      });
    } catch (trackError) {
      console.error("Failed to track access_request_submit activity:", trackError);
    }

    return NextResponse.json({ id: requestId, status: "pending" });
  } catch (err) {
    console.error("access-management/request POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
