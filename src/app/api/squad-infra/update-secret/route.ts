import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";
import { squadCatalog } from "@/lib/squad-infra/squad-catalog";
import { gitlabClient } from "@/lib/gitlab";
import { createNotificationBatch } from "@/lib/notifications";
import { getNotifyList } from "@/lib/infra-approvers";
import { sendEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

const TF_VAR_RE = /^TF_VAR_[A-Z][A-Z0-9_]*$/;

/**
 * POST /api/squad-infra/update-secret
 *
 * Rotate/update the VALUE of an existing secret that is injected via a GitLab
 * CI/CD variable (TF_VAR_*). This is the common "the SFCC token changed" case.
 * Goes through the same approval flow; on execute it just upserts the CI var
 * and re-triggers the pipeline (no .tf change, no MR). Values never hit our DB.
 */
export async function POST(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const email = auth.session.user?.email || "";
  const name = auth.session.user?.name || "";

  const { squad, secretName, ciVarKey, newValue, approver } = await request.json() as {
    squad: string; secretName: string; ciVarKey: string; newValue: string; approver: string;
  };

  if (!squad || !secretName || !ciVarKey || !approver) {
    return NextResponse.json({ error: "squad, secretName, ciVarKey and approver are required" }, { status: 400 });
  }
  if (!TF_VAR_RE.test(ciVarKey)) {
    return NextResponse.json({ error: "ciVarKey must look like TF_VAR_MY_TOKEN" }, { status: 400 });
  }
  if (typeof newValue !== "string" || newValue === "") {
    return NextResponse.json({ error: "newValue is required" }, { status: 400 });
  }

  const squadEntry = await squadCatalog.getBySquad(squad);
  if (!squadEntry) {
    return NextResponse.json({ error: `Squad "${squad}" not found` }, { status: 422 });
  }

  // Push the new value to GitLab immediately (masked + protected). Never stored.
  try {
    await gitlabClient.upsertCiVariable(squadEntry.gitlabProjectId, ciVarKey, newValue, {
      masked: true,
      protected: true,
      raw: true,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to update GitLab CI/CD variable: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }

  const payload = {
    source: "squad-infra-v1",
    squad: squadEntry.squad,
    squadDisplayName: squadEntry.displayName,
    gitlabProjectId: squadEntry.gitlabProjectId,
    defaultBranch: squadEntry.defaultBranch,
    squadResourceType: "secret-update",
    resourceName: secretName,
    ciVarKey,
    environments: ["dev", "uat", "pro"].filter((e) => squadEntry.environments.includes(e)),
    approver: (approver || "").toLowerCase(),
    identifier: secretName,
    valueUpdatedInGitlab: true,
  };

  const { rows } = await pool.query(
    `INSERT INTO infra_requests (resource_type, team, requestor_email, requestor_name, payload, status)
     VALUES ('squad-secret-update', $1, $2, $3, $4, 'pending')
     RETURNING id`,
    [squadEntry.businessTeam, email, name, JSON.stringify(payload)]
  );
  const requestId = rows[0].id;

  const notifyEmails = getNotifyList(approver);
  try {
    await createNotificationBatch(
      notifyEmails.map((approverEmail) => ({
        userEmail: approverEmail,
        type: "approval_request" as const,
        title: `Actualización de secret (${squadEntry.displayName})`,
        message: `${name || email} solicita actualizar el valor del secret "${secretName}" (${ciVarKey}) en ${squadEntry.displayName}. El nuevo valor ya está en GitLab; al aprobar se relanza la pipeline.`,
        link: `/infra-requests`,
        metadata: { requestId, resourceType: "squad-secret-update", squad: squadEntry.squad },
      }))
    );
  } catch { /* non-blocking */ }

  const portalUrl = process.env.NEXTAUTH_URL || "https://portal.today.tooling.dp.iskaypet.com";
  sendEmail({
    to: notifyEmails,
    subject: `[Portal] Actualización de secret — ${squadEntry.displayName} / ${secretName}`,
    bodyText: `Hola,\n\n${name || email} ha solicitado actualizar el valor del secret "${secretName}" (variable ${ciVarKey}) en ${squadEntry.displayName}.\n\nEl nuevo valor ya se ha guardado como variable CI/CD en GitLab. Al aprobar la solicitud se relanzará la pipeline para que el secret tome el nuevo valor.\n\nRevisa y aprueba:\n${portalUrl}/infra-requests\n\nSaludos,\nPortal de Plataforma`,
  }).catch((e) => console.error("[squad-infra/update-secret] email error:", e));

  return NextResponse.json({ id: requestId, status: "pending" });
}
