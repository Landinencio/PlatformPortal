/**
 * POST /api/access-management/execute/[id]
 *
 * Internal-only endpoint that executes an approved access request.
 * Protected by x-internal-secret header.
 *
 * Handles all platforms:
 * - AWS/ArgoCD/SonarQube: Azure AD Graph API (add user to group)
 * - GitLab grant: GitLab API (add member/invite) + onboarding email (disabled)
 * - GitLab revoke: GitLab API (find user, block)
 *
 * On success: sends Teams notification, updates DB status.
 * On failure: marks execute_failed, notifies requestor.
 */

import { NextResponse } from "next/server";
import { requireInternalAuth } from "@/lib/api-auth";
import pool from "@/lib/db";
import { graphClient } from "@/lib/graph-client";
import { gitlabClient } from "@/lib/gitlab";
import { createNotification } from "@/lib/notifications";
import { sendEmail } from "@/lib/email";
import { buildGitLabOnboardingEmail } from "@/lib/access-management/gitlab-onboarding-email";
import { jiraCreateIssue, jiraTransitionToDone, jiraSetReporterByEmail } from "@/lib/jira";
import { type AccessRequestRow } from "@/lib/access-management/execute-helpers";

const TEAMS_WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL || "";

/* ------------------------------------------------------------------ */
/*  Helper: mark request as failed and notify requestor                */
/* ------------------------------------------------------------------ */

async function markFailed(requestId: number, requestorEmail: string, errorMsg: string): Promise<void> {
  await pool.query(
    `UPDATE access_requests SET status = 'execute_failed', updated_at = NOW() WHERE id = $1`,
    [requestId]
  );

  await createNotification({
    userEmail: requestorEmail,
    type: "info",
    title: "Error en solicitud de acceso",
    message: `La ejecución de tu solicitud de acceso falló: ${errorMsg}`,
    link: "/access-management",
  }).catch((err) => console.error("[execute] notification error:", err));
}

/* ------------------------------------------------------------------ */
/*  Helper: send Teams adaptive card                                   */
/* ------------------------------------------------------------------ */

async function sendTeamsNotification(card: Record<string, unknown>): Promise<void> {
  if (!TEAMS_WEBHOOK_URL) {
    console.warn("[execute] TEAMS_WEBHOOK_URL not configured — skipping Teams notification");
    return;
  }

  try {
    const res = await fetch(TEAMS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
    });
    if (!res.ok) {
      console.error(`[execute] Teams webhook failed (${res.status}):`, await res.text().catch(() => ""));
    }
  } catch (err) {
    console.error("[execute] Teams webhook error:", err);
  }
}

/* ------------------------------------------------------------------ */
/*  Helper: build descriptive Teams message for access actions         */
/* ------------------------------------------------------------------ */

function buildAccessTeamsMessage(request: AccessRequestRow): Record<string, unknown> {
  const platform = request.platform.toUpperCase();
  const requestType = request.request_type || "grant";
  const groupOrRole = request.group_name || request.role || "N/A";
  const approver = request.reviewer_name || request.reviewer_email || request.approver_email;

  let actionText: string;
  let emoji: string;

  if (requestType === "onboard") {
    actionText = `Ha dado de alta en GitLab`;
    emoji = "🟢";
  } else if (requestType === "offboard") {
    actionText = `Ha dado de baja de GitLab`;
    emoji = "🔴";
  } else if (requestType === "revoke") {
    actionText = `Ha revocado la licencia de GitLab`;
    emoji = "🔒";
  } else if (request.platform === "gitlab") {
    actionText = `Ha añadido permisos en GitLab (${request.role || "developer"})`;
    emoji = "🦊";
  } else {
    actionText = `Ha añadido al grupo de ${platform}`;
    emoji = "🔐";
  }

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          msteams: { width: "Full" },
          body: [
            {
              type: "Container",
              items: [
                {
                  type: "TextBlock",
                  text: `${emoji} Gestión de Accesos`,
                  weight: "Bolder",
                  size: "Medium",
                  color: "Accent",
                },
                {
                  type: "TextBlock",
                  text: platform,
                  weight: "Bolder",
                  size: "ExtraLarge",
                  spacing: "None",
                },
                {
                  type: "FactSet",
                  facts: [
                    { title: "Acción:", value: actionText },
                    { title: "Usuario:", value: request.target_user_email },
                    { title: "Grupo/Proyecto:", value: groupOrRole },
                    { title: "Aprobado por:", value: approver },
                    { title: "Solicitado por:", value: request.requestor_email },
                    { title: "Estado:", value: "✅ Ejecutado" },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  Azure AD platforms (AWS, ArgoCD, SonarQube)                        */
/* ------------------------------------------------------------------ */

async function executeAzureAD(request: AccessRequestRow): Promise<void> {
  // 1. Resolve user in Azure AD
  const user = await graphClient.findUserByEmail(request.target_user_email);

  // 2. Add user to group
  if (!request.group_id) {
    throw new Error("group_id is required for Azure AD platform execution");
  }
  await graphClient.addUserToGroup(request.group_id, user.id);
}

/* ------------------------------------------------------------------ */
/*  GitLab grant                                                       */
/* ------------------------------------------------------------------ */

async function executeGitLabGrant(request: AccessRequestRow): Promise<void> {
  if (!request.group_id) {
    throw new Error("group_id is required for GitLab grant execution");
  }

  // Map role name to GitLab access level
  const accessLevelMap: Record<string, number> = {
    guest: 10,
    reporter: 20,
    developer: 30,
    maintainer: 40,
  };
  const accessLevel = accessLevelMap[(request.role || "developer").toLowerCase()] || 30;

  // 1. Check if user already exists in GitLab (to determine if onboarding email is needed)
  const existingUser = await gitlabClient.findUserByEmail(request.target_user_email);
  const isNewUser = !existingUser;

  // 2. Add member to group (if user doesn't exist, this invites them and provisions a license)
  await gitlabClient.addGroupMember(
    parseInt(request.group_id, 10),
    request.target_user_email,
    accessLevel
  );

  // 3. Send onboarding email ONLY if user is new to GitLab
  if (isNewUser) {
    try {
      const emailContent = buildGitLabOnboardingEmail({
        targetEmail: request.target_user_email,
        groupName: request.group_name || request.group_id,
        roleName: request.role || "Developer",
      });

      await sendEmail({
        to: [request.target_user_email],
        subject: emailContent.subject,
        bodyHtml: emailContent.bodyHtml,
        bodyText: emailContent.bodyText,
      });
      console.log(`[execute] Onboarding email sent to new user: ${request.target_user_email}`);
    } catch (err) {
      console.error("[execute] Onboarding email error:", err);
    }
  } else {
    console.log(`[execute] User ${request.target_user_email} already exists in GitLab, skipping onboarding email`);
  }
}

/* ------------------------------------------------------------------ */
/*  GitLab revoke                                                      */
/* ------------------------------------------------------------------ */

async function executeGitLabRevoke(request: AccessRequestRow): Promise<void> {
  // 1. Find user by email
  const user = await gitlabClient.findUserByEmail(request.target_user_email);
  if (!user) {
    throw new Error(`GitLab user not found for email: ${request.target_user_email}`);
  }

  // 2. Block user and remove license
  await gitlabClient.blockUser(user.id);
}

/* ------------------------------------------------------------------ */
/*  GitLab onboard (Alta)                                              */
/* ------------------------------------------------------------------ */

const GITLAB_ONBOARD_GROUP_ID = "a1826db7-71d5-498e-b21a-812ea6618c31";

async function executeGitLabOnboard(request: AccessRequestRow): Promise<void> {
  // 1. Find user in Azure AD
  const user = await graphClient.findUserByEmail(request.target_user_email);

  // 2. Add user to the GitLab onboarding Azure AD group
  await graphClient.addUserToGroup(GITLAB_ONBOARD_GROUP_ID, user.id);

  // 3. Send onboarding email with instructions (directly from portal, no webhook)
  try {
    const emailContent = buildGitLabOnboardingEmail({
      targetEmail: request.target_user_email,
      groupName: "GitLab (Alta)",
      roleName: "Developer",
    });

    await sendEmail({
      to: [request.target_user_email],
      subject: emailContent.subject,
      bodyHtml: emailContent.bodyHtml,
      bodyText: emailContent.bodyText,
    });
    console.log(`[execute] Onboarding email sent to: ${request.target_user_email}`);
  } catch (err) {
    console.error("[execute] Onboarding email error (non-blocking):", err);
  }
}

/* ------------------------------------------------------------------ */
/*  GitLab offboard (Baja)                                             */
/* ------------------------------------------------------------------ */

async function executeGitLabOffboard(request: AccessRequestRow): Promise<void> {
  // 1. Find user in Azure AD
  const user = await graphClient.findUserByEmail(request.target_user_email);

  // 2. Remove user from the GitLab onboarding Azure AD group
  await graphClient.removeUserFromGroup(GITLAB_ONBOARD_GROUP_ID, user.id);
}

/* ------------------------------------------------------------------ */
/*  POST handler                                                       */
/* ------------------------------------------------------------------ */

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  // 1. Require internal auth
  const auth = requireInternalAuth(request);
  if (auth.error) return auth.error;

  const requestId = parseInt(params.id, 10);
  if (isNaN(requestId)) {
    return NextResponse.json({ error: "Invalid request ID" }, { status: 400 });
  }

  // 2. Load access_request row
  const { rows } = await pool.query(
    `SELECT id, requestor_email, target_user_email, platform, request_type,
            group_id, group_name, role, approver_email, status,
            reviewer_email, reviewer_name, executed_at, business_team
     FROM access_requests WHERE id = $1`,
    [requestId]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }

  const accessRequest: AccessRequestRow = rows[0];

  // 3. Atomically claim the request: flip approved → executing so a concurrent
  //    duplicate call (e.g. double approve trigger) can't execute twice.
  const claim = await pool.query(
    `UPDATE access_requests SET status = 'executing', updated_at = NOW() WHERE id = $1 AND status = 'approved'`,
    [requestId]
  );
  if (claim.rowCount === 0) {
    return NextResponse.json(
      { error: `Request is not in approved status (current: ${accessRequest.status})` },
      { status: 409 }
    );
  }

  // 4. Execute based on platform and request type
  try {
    const platform = accessRequest.platform.toLowerCase();
    const requestType = accessRequest.request_type || "grant";

    if (platform === "aws" || platform === "argocd" || platform === "sonarqube") {
      await executeAzureAD(accessRequest);
    } else if (platform === "kiro" && requestType === "kiro-license") {
      // Kiro licenses are assigned manually — no automated execution needed
      console.log(`[execute/${requestId}] Kiro license request — manual assignment, skipping automated execution`);
    } else if (platform === "gitlab" && requestType === "onboard") {
      await executeGitLabOnboard(accessRequest);
    } else if (platform === "gitlab" && requestType === "offboard") {
      await executeGitLabOffboard(accessRequest);
    } else if (platform === "gitlab" && requestType === "grant") {
      await executeGitLabGrant(accessRequest);
    } else if (platform === "gitlab" && requestType === "revoke") {
      await executeGitLabRevoke(accessRequest);
    } else {
      throw new Error(`Unsupported platform/request_type: ${platform}/${requestType}`);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[execute] Execution failed for request ${requestId}:`, errorMsg);
    await markFailed(requestId, accessRequest.requestor_email, errorMsg);
    return NextResponse.json({ error: "Execution failed", details: errorMsg }, { status: 500 });
  }

  // 5. Create Jira ticket (post-approval, non-blocking)
  try {
    const requestType = accessRequest.request_type || "grant";
    const isOnboardOffboard = requestType === "onboard" || requestType === "offboard";
    const isKiroLicense = requestType === "kiro-license";
    const businessTeam = accessRequest.business_team || "";

    let jiraSummary: string;
    let jiraDescription: string;
    let jiraLabels: string[];

    if (isKiroLicense) {
      jiraSummary = `[Licencias] Kiro IDE — ${accessRequest.target_user_email} — ${businessTeam}`;
      jiraDescription = [
        `h2. Licencia Kiro IDE`,
        ``,
        `||Campo||Valor||`,
        `|Usuarios|${accessRequest.target_user_email}|`,
        `|Equipo|${businessTeam}|`,
        `|Aprobado por|${accessRequest.reviewer_email || accessRequest.approver_email}|`,
        `|Solicitado por|${accessRequest.requestor_email}|`,
        `|Estado|Aprobada y ejecutada|`,
        ``,
        `_Creado automáticamente desde el Portal de Plataforma._`,
      ].join("\n");
      jiraLabels = ["SRE", "portal", "kiro-license", businessTeam];
    } else if (isOnboardOffboard) {
      jiraSummary = `[Accesos] GitLab ${requestType === "onboard" ? "Alta" : "Baja"} — ${accessRequest.target_user_email} — ${businessTeam}`;
      jiraDescription = [
        `h2. ${requestType === "onboard" ? "Alta" : "Baja"} GitLab`,
        ``,
        `||Campo||Valor||`,
        `|Acción|${requestType === "onboard" ? "Alta (onboarding)" : "Baja (offboarding)"}|`,
        `|Usuario|${accessRequest.target_user_email}|`,
        `|Equipo|${businessTeam}|`,
        `|Aprobado por|${accessRequest.reviewer_email || accessRequest.approver_email}|`,
        `|Solicitado por|${accessRequest.requestor_email}|`,
        `|Estado|Aprobada y ejecutada|`,
        ``,
        `_Creado automáticamente desde el Portal de Plataforma._`,
      ].join("\n");
      jiraLabels = ["SRE", "portal", businessTeam];
    } else {
      jiraSummary = `[Accesos] ${accessRequest.platform.toUpperCase()} — ${accessRequest.group_name || "N/A"} — ${businessTeam}`;
      jiraDescription = [
        `h2. Acceso a ${accessRequest.platform.toUpperCase()}`,
        ``,
        `||Campo||Valor||`,
        `|Plataforma|${accessRequest.platform.toUpperCase()}|`,
        `|Usuario|${accessRequest.target_user_email}|`,
        `|Grupo|${accessRequest.group_name || "N/A"}|`,
        `|Rol|${accessRequest.role || "N/A"}|`,
        `|Equipo|${businessTeam}|`,
        `|Aprobado por|${accessRequest.reviewer_email || accessRequest.approver_email}|`,
        `|Solicitado por|${accessRequest.requestor_email}|`,
        `|Estado|Aprobada y ejecutada|`,
        ``,
        `_Creado automáticamente desde el Portal de Plataforma._`,
      ].join("\n");
      jiraLabels = ["SRE", "portal", businessTeam];
    }

    const jiraResult = await jiraCreateIssue({
      projectKey: "SRE",
      issueTypeId: "10048",
      summary: jiraSummary,
      description: jiraDescription,
      labels: jiraLabels.filter(Boolean),
      reporterEmail: accessRequest.requestor_email,
    });

    // Fallback: ensure reporter is set via PUT (awaited)
    await jiraSetReporterByEmail(jiraResult.key, accessRequest.requestor_email);

    // Transition ticket to Done immediately (access already executed)
    // Exception: Kiro license tickets stay open (manual assignment needed)
    if (!isKiroLicense) {
      try {
        await jiraTransitionToDone(jiraResult.key);
      } catch (transErr) {
        console.error(`[execute/${requestId}] Jira transition to Done failed:`, transErr);
      }
    }
  } catch (jiraErr) {
    console.error(`[execute/${requestId}] Jira ticket creation failed (non-blocking):`, jiraErr);
  }

  // 6. Send Teams notification (non-blocking) — descriptive message about what was done
  try {
    const teamsMessage = buildAccessTeamsMessage(accessRequest);
    await sendTeamsNotification(teamsMessage);
  } catch (err) {
    console.error("[execute] Teams notification error:", err);
  }

  // 7. Update status to "executed"
  await pool.query(
    `UPDATE access_requests SET status = 'executed', executed_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [requestId]
  );

  // 8. Notify requestor of success
  const isAwsPlatform = accessRequest.platform.toLowerCase() === "aws";
  const awsDelayNote = isAwsPlatform
    ? " ⏱️ El acceso puede tardar hasta 30 minutos en estar disponible debido a la sincronización entre Azure AD y AWS."
    : "";

  await createNotification({
    userEmail: accessRequest.requestor_email,
    type: "info",
    title: "Acceso concedido",
    message: `Se ha concedido acceso a ${accessRequest.platform.toUpperCase()} para ${accessRequest.target_user_email}.${awsDelayNote}`,
    link: "/access-management",
  }).catch((err) => console.error("[execute] success notification error:", err));

  return NextResponse.json({
    success: true,
    status: "executed",
  });
}
