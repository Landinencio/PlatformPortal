import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";
import { squadCatalog } from "@/lib/squad-infra/squad-catalog";
import { gitlabClient } from "@/lib/gitlab";
import { InfraAgent } from "@/lib/infra-agent";
import { verifyModifyScope } from "@/lib/resource-scope-verifier";
import { createNotificationBatch } from "@/lib/notifications";
import { getNotifyList } from "@/lib/infra-approvers";
import { sendEmail } from "@/lib/email";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type SquadModType = "sqs" | "dynamodb" | "sns" | "eventbridge" | "secret";

interface SquadModifications {
  // SQS
  maxReceiveCount?: number;
  createDlq?: boolean;
  principals?: string[];
  delaySeconds?: number;
  visibilityTimeoutSeconds?: number;
  // EventBridge
  detailTypes?: string[];
  sources?: string[];
  targetSqsModuleId?: string;
  // DynamoDB
  ttlAttribute?: string | null;
  addGsi?: { name: string; hashKey: string; rangeKey?: string; projectionType: string };
  // generic
  freeText?: string;
}

function buildModDescriptions(resourceType: SquadModType, m: SquadModifications): string[] {
  const d: string[] = [];
  if (resourceType === "sqs") {
    if (m.maxReceiveCount !== undefined) d.push(`Cambiar redrive_policy.maxReceiveCount a ${m.maxReceiveCount}.`);
    if (m.createDlq !== undefined) d.push(m.createDlq ? "Asegurar que create_dlq = true con su redrive_policy." : "Poner create_dlq = false y eliminar redrive_policy.");
    if (m.principals && m.principals.length > 0) {
      d.push(`Sustituir los principals del queue_policy_statements.publish por exactamente estos servicios: ${m.principals.join(", ")}. Mantén el resto del statement igual (sid, actions).`);
    }
    if (m.delaySeconds !== undefined) d.push(`Establecer delay_seconds = ${m.delaySeconds}.`);
    if (m.visibilityTimeoutSeconds !== undefined) d.push(`Establecer visibility_timeout_seconds = ${m.visibilityTimeoutSeconds}.`);
  } else if (resourceType === "eventbridge") {
    if (m.detailTypes && m.detailTypes.length > 0) {
      d.push(`Actualizar el event_pattern para que "detail-type" sea exactamente: ${JSON.stringify(m.detailTypes)}. Mantén el resto del patrón.`);
    }
    if (m.sources && m.sources.length > 0) {
      d.push(`Añadir/actualizar "source" en el event_pattern a: ${JSON.stringify(m.sources)}.`);
    }
    if (m.targetSqsModuleId) {
      d.push(`Cambiar el target ARN para que apunte a module.${m.targetSqsModuleId}.queue_arn (y dead_letter_arn a module.${m.targetSqsModuleId}.dead_letter_queue_arn).`);
    }
  } else if (resourceType === "dynamodb") {
    if (m.ttlAttribute !== undefined) {
      if (m.ttlAttribute) d.push(`Habilitar TTL: ttl_attribute_name = "${m.ttlAttribute}" y ttl_enabled = true.`);
      else d.push("Deshabilitar TTL (ttl_enabled = false).");
    }
    if (m.addGsi) {
      d.push(`Añadir un global_secondary_index: name="${m.addGsi.name}", hash_key="${m.addGsi.hashKey}"${m.addGsi.rangeKey ? `, range_key="${m.addGsi.rangeKey}"` : ""}, projection_type="${m.addGsi.projectionType}". Si el atributo de la GSI no existe en attributes, añádelo con type "S".`);
    }
  }
  if (m.freeText && m.freeText.trim()) {
    d.push(`Cambio adicional solicitado: ${m.freeText.trim()}`);
  }
  return d;
}

export async function POST(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const email = auth.session.user?.email || "";
  const name = auth.session.user?.name || "";

  const { squad, resourceType, resourceName, tfLabel, filePath, modifications, approver } = await request.json() as {
    squad: string;
    resourceType: SquadModType;
    resourceName: string;
    tfLabel: string;
    filePath: string;
    modifications: SquadModifications;
    approver: string;
  };

  if (!squad || !resourceType || !resourceName || !filePath || !modifications || !approver) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const squadEntry = await squadCatalog.getBySquad(squad);
  if (!squadEntry) {
    return NextResponse.json({ error: `Squad "${squad}" not found` }, { status: 422 });
  }

  const modDescriptions = buildModDescriptions(resourceType, modifications);
  if (modDescriptions.length === 0) {
    return NextResponse.json({ error: "No se especificó ningún cambio" }, { status: 400 });
  }

  const projectId = squadEntry.gitlabProjectId;
  const defaultBranch = squadEntry.defaultBranch;

  const currentContent = await gitlabClient.getRepositoryFileRaw(projectId, filePath, defaultBranch);
  if (!currentContent) {
    return NextResponse.json({ error: `File "${filePath}" not found` }, { status: 404 });
  }

  const prompt = `Necesito MODIFICAR un recurso existente en el archivo "${filePath}" del repositorio de infraestructura del squad ${squadEntry.displayName}.

El recurso a modificar es: ${resourceName} (bloque Terraform: ${tfLabel}, tipo ${resourceType}).

CONTENIDO ACTUAL DEL ARCHIVO:
\`\`\`hcl
${currentContent}
\`\`\`

MODIFICACIONES REQUERIDAS:
${modDescriptions.map((d, i) => `${i + 1}. ${d}`).join("\n")}

INSTRUCCIONES:
1. Devuelve el archivo COMPLETO con las modificaciones aplicadas.
2. SOLO modifica el recurso/módulo "${tfLabel}" (y sus bloques directamente relacionados). NO toques ningún otro recurso del archivo.
3. Mantén EXACTAMENTE el mismo formato, comentarios, versiones de módulo y estructura del original.
4. NO cambies las versiones de los módulos. NO inventes variables nuevas.
5. Devuelve el resultado dentro de <terraform_preview>...</terraform_preview> seguido de un bloque <json> con {"file_path":"${filePath}","resource_type":"squad-${resourceType}","resource_name":"${resourceName}","target_environments":${JSON.stringify(squadEntry.environments)}}.`;

  const agent = new InfraAgent({ projectId, defaultBranch, temperature: 0.1, maxTokens: 8000 });

  try {
    const result = await agent.run({
      message: prompt,
      history: [],
      team: squad,
      projectId,
      defaultBranch,
      requestorEmail: email,
    });

    if (!result.terraformPreview) {
      return NextResponse.json({ error: "La IA no pudo generar la modificación. Inténtalo de nuevo." }, { status: 422 });
    }

    // Scope check against the TF block label.
    const scope = verifyModifyScope(currentContent, result.terraformPreview.content, tfLabel.replace(/^module\./, ""));
    if (!scope.valid) {
      return NextResponse.json({
        error: "La modificación afectó a recursos fuera del objetivo",
        unexpectedChanges: scope.unexpectedChanges,
      }, { status: 422 });
    }

    // Persist as a unified infra_request (squad modify).
    const payload = {
      source: "squad-infra-v1",
      squad: squadEntry.squad,
      squadDisplayName: squadEntry.displayName,
      gitlabProjectId: projectId,
      defaultBranch,
      squadResourceType: resourceType,
      resourceName,
      environments: squadEntry.environments,
      config: { name: resourceName },
      filePath,
      isModification: true,
      approver: (approver || "").toLowerCase(),
      identifier: resourceName,
      target_environments: squadEntry.environments,
      variablesHcl: null,
      ciVarKeys: [],
      awsAccounts: {
        dev: squadEntry.awsAccountDev,
        uat: squadEntry.awsAccountUat,
        pro: squadEntry.awsAccountPro,
      },
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
          filePath,
          content: result.terraformPreview.content,
          resourceType: `squad-${resourceType}`,
          resourceName,
          targetEnvironments: squadEntry.environments,
          estimatedCostMonthly: null,
          isSquadInfra: true,
          isModification: true,
          generatedAt: new Date().toISOString(),
        }),
      ]
    );
    const requestId = rows[0].id;

    const notifyEmails = getNotifyList(approver);
    try {
      await createNotificationBatch(
        notifyEmails.map((approverEmail) => ({
          userEmail: approverEmail,
          type: "approval_request" as const,
          title: `Modificación de infra (${squadEntry.displayName})`,
          message: `${name || email} solicita modificar ${resourceType.toUpperCase()} "${resourceName}" en ${squadEntry.displayName}.`,
          link: `/infra-requests`,
          metadata: { requestId, resourceType: `squad-${resourceType}`, squad: squadEntry.squad },
        }))
      );
    } catch { /* non-blocking */ }

    const portalUrl = process.env.NEXTAUTH_URL || "https://portal.today.tooling.dp.iskaypet.com";
    sendEmail({
      to: notifyEmails,
      subject: `[Portal] Modificación de ${resourceType.toUpperCase()} — ${squadEntry.displayName} / ${resourceName}`,
      bodyText: `Hola,\n\n${name || email} ha solicitado modificar ${resourceType.toUpperCase()} "${resourceName}" en el repo de ${squadEntry.displayName}.\n\nCambios:\n${modDescriptions.map(d => `- ${d}`).join("\n")}\n\nRevisa y aprueba:\n${portalUrl}/infra-requests\n\nSaludos,\nPortal de Plataforma`,
    }).catch((e) => console.error("[squad-infra/modify] email error:", e));

    return NextResponse.json({
      id: requestId,
      status: "pending",
      preview: result.terraformPreview.content,
      filePath,
    });
  } catch (err) {
    console.error("[squad-infra/modify] error:", err);
    return NextResponse.json({ error: "Error generando la modificación" }, { status: 500 });
  }
}
