import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";
import { squadCatalog } from "@/lib/squad-infra/squad-catalog";
import { validateConfig, validateEnvironments } from "@/lib/squad-infra/validators";
import { renderResource } from "@/lib/squad-infra/render";
import type { SquadResourceType } from "@/lib/squad-infra/templates";
import { gitlabClient } from "@/lib/gitlab";
import { createNotificationBatch } from "@/lib/notifications";
import { getNotifyList } from "@/lib/infra-approvers";
import { sendEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

const VALID_TYPES: SquadResourceType[] = ["sqs", "secret", "dynamodb", "eventbridge", "sns"];

const TYPE_LABELS: Record<SquadResourceType, string> = {
  sqs: "SQS Queue",
  secret: "Secret",
  dynamodb: "DynamoDB Table",
  eventbridge: "EventBridge Rule",
  sns: "SNS Topic",
};

/**
 * POST /api/squad-infra/request
 *
 * Creates a squad infra request in the unified `infra_requests` table
 * (resource_type = "squad-<type>") with status pending, reusing the same
 * approval flow as SRE-critical infra. For secrets, the sensitive values are
 * written directly to GitLab CI/CD variables here (never stored in the DB).
 */
export async function POST(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const email = auth.session.user?.email || "";
  const name = auth.session.user?.name || "";

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { squad, resourceType, environments, config, approver, secretValues } = body as {
    squad: string;
    resourceType: SquadResourceType;
    environments: string[];
    config: any;
    approver: string;
    /** For secrets only: { TF_VAR_NAME: "value" }. Never persisted. */
    secretValues?: Record<string, string>;
  };

  if (!VALID_TYPES.includes(resourceType)) {
    return NextResponse.json({ error: `resourceType must be one of: ${VALID_TYPES.join(", ")}` }, { status: 400 });
  }
  if (!approver) {
    return NextResponse.json({ error: "approver is required" }, { status: 400 });
  }
  const envError = validateEnvironments(environments);
  if (envError) return NextResponse.json({ error: envError }, { status: 400 });
  const cfgError = validateConfig(resourceType, config);
  if (cfgError) return NextResponse.json({ error: cfgError }, { status: 400 });

  const squadEntry = await squadCatalog.getBySquad(squad);
  if (!squadEntry) {
    return NextResponse.json({ error: `Squad "${squad}" not found` }, { status: 422 });
  }

  let rendered;
  try {
    rendered = renderResource(resourceType, config, squadEntry);
  } catch (err) {
    console.error("[squad-infra/request] render error:", err);
    return NextResponse.json({ error: "Failed to render template" }, { status: 500 });
  }

  // For secrets: push the sensitive values to GitLab CI/CD variables NOW, so we
  // never store them in our DB. The .tf only references var.<NAME>.
  if (resourceType === "secret" && rendered.ciVars && rendered.ciVars.length > 0) {
    if (!secretValues || typeof secretValues !== "object") {
      return NextResponse.json({ error: "secretValues are required for secret requests" }, { status: 400 });
    }
    for (const v of rendered.ciVars) {
      const value = secretValues[v.key];
      if (value === undefined || value === "") {
        return NextResponse.json({ error: `Missing value for ${v.key}` }, { status: 400 });
      }
    }
    try {
      for (const v of rendered.ciVars) {
        await gitlabClient.upsertCiVariable(squadEntry.gitlabProjectId, v.key, secretValues[v.key], {
          masked: v.masked,
          protected: v.protected,
          raw: true,
        });
      }
    } catch (err) {
      console.error("[squad-infra/request] CI var error:", err);
      return NextResponse.json(
        { error: `Failed to set GitLab CI/CD variables: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 }
      );
    }
  }

  // Persist into the unified infra_requests table. The squad-specific context
  // lives in payload; resource_type is prefixed "squad-" to route execution.
  const resourceName = config.name || rendered.filePath;
  const payload = {
    source: "squad-infra-v1",
    squad: squadEntry.squad,
    squadDisplayName: squadEntry.displayName,
    gitlabProjectId: squadEntry.gitlabProjectId,
    defaultBranch: squadEntry.defaultBranch,
    squadResourceType: resourceType,
    resourceName,
    environments,
    config,
    approver: (approver || "").toLowerCase(),
    filePath: rendered.filePath,
    variablesHcl: rendered.variablesHcl ?? null,
    ciVarKeys: (rendered.ciVars ?? []).map((v) => v.key),
    awsAccounts: {
      dev: squadEntry.awsAccountDev,
      uat: squadEntry.awsAccountUat,
      pro: squadEntry.awsAccountPro,
    },
    identifier: resourceName,
    target_environments: environments,
  };

  const { rows } = await pool.query(
    `INSERT INTO infra_requests (resource_type, team, requestor_email, requestor_name, payload, terraform_preview, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     RETURNING id`,
    [
      `squad-${resourceType}`,
      squadEntry.businessTeam,
      email,
      name,
      JSON.stringify(payload),
      JSON.stringify({
        filePath: rendered.filePath,
        content: rendered.hcl,
        resourceType: `squad-${resourceType}`,
        resourceName,
        targetEnvironments: environments,
        estimatedCostMonthly: null,
        isSquadInfra: true,
        generatedAt: new Date().toISOString(),
      }),
    ]
  );
  const requestId = rows[0].id;

  const label = TYPE_LABELS[resourceType];
  const notifyEmails = getNotifyList(approver);

  try {
    await createNotificationBatch(
      notifyEmails.map((approverEmail) => ({
        userEmail: approverEmail,
        type: "approval_request" as const,
        title: `Nueva solicitud de ${label} (${squadEntry.displayName})`,
        message: `${name || email} solicita crear ${label} "${resourceName}" en el repo de ${squadEntry.displayName} (${environments.join(", ")}).`,
        link: `/infra-requests`,
        metadata: { requestId, resourceType: `squad-${resourceType}`, squad: squadEntry.squad, resourceName, requestor: email },
      }))
    );
  } catch (notifErr) {
    console.error("[squad-infra/request] notification error:", notifErr);
  }

  // Notify requestor
  try {
    await createNotificationBatch([{
      userEmail: email,
      type: "info" as const,
      title: `Solicitud enviada: ${label}`,
      message: `Tu solicitud de ${label} "${resourceName}" está pendiente de aprobación.`,
      link: `/infra-requests`,
      metadata: { requestId },
    }]);
  } catch { /* non-blocking */ }

  // Email approvers (fire-and-forget)
  const portalUrl = process.env.NEXTAUTH_URL || "https://portal.today.tooling.dp.iskaypet.com";
  const ciVarNote = (rendered.ciVars ?? []).length > 0
    ? `\n\nNota: los valores sensibles ya se han configurado como variables CI/CD en GitLab (${(rendered.ciVars ?? []).map(v => v.key).join(", ")}).`
    : "";
  sendEmail({
    to: notifyEmails,
    subject: `[Portal] Solicitud de ${label} — ${squadEntry.displayName} / ${resourceName}`,
    bodyText: `Hola,\n\n${name || email} ha solicitado crear ${label} "${resourceName}" en el repositorio de infraestructura de ${squadEntry.displayName}.\n\nEntornos: ${environments.join(", ")}\nFichero: ${rendered.filePath}${ciVarNote}\n\nRevisa y aprueba en el portal:\n${portalUrl}/infra-requests\n\nSaludos,\nPortal de Plataforma`,
  }).catch((e) => console.error("[squad-infra/request] email error:", e));

  return NextResponse.json({ id: requestId, status: "pending" });
}
