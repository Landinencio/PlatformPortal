/**
 * Execution of an approved squad infra request.
 *
 * Mirrors the SRE-critical execute but for deterministic squad resources:
 *   1. create branch feat/SRE-<id>
 *   2. create or append the resource .tf file
 *   3. for secrets: append variable declarations to variables.tf
 *   4. open MR
 *   5. create Jira ticket and transition it to Done (access-management style)
 *   6. trigger the dev pipeline
 *
 * CI/CD variables for secret values are already set at request time (never in DB).
 */

import pool from "@/lib/db";
import { gitlabClient } from "@/lib/gitlab";
import { jiraCreateIssue, jiraTransitionToDone, jiraSetReporterByEmail } from "@/lib/jira";
import { createNotification } from "@/lib/notifications";
import { validateHclSyntax } from "@/lib/terraform-validator";

const TEAMS_WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL || "";

const TYPE_LABELS: Record<string, string> = {
  "squad-sqs": "SQS Queue",
  "squad-secret": "Secret",
  "squad-dynamodb": "DynamoDB Table",
  "squad-eventbridge": "EventBridge Rule",
  "squad-sns": "SNS Topic",
};

interface SquadPayload {
  squad: string;
  squadDisplayName: string;
  gitlabProjectId: number;
  defaultBranch: string;
  squadResourceType: string;
  resourceName: string;
  environments: string[];
  config: any;
  filePath: string;
  variablesHcl: string | null;
  ciVarKeys: string[];
  isModification?: boolean;
}

export interface SquadExecuteResult {
  ok: boolean;
  status: "executed" | "execute_failed";
  mrUrl?: string | null;
  branch?: string;
  error?: string;
}

async function notify(email: string, title: string, message: string) {
  await createNotification({
    userEmail: email,
    type: "approval_result",
    title,
    message,
    link: "/infra-requests",
  }).catch(() => {});
}

async function deleteBranch(projectId: number, branchName: string): Promise<void> {
  const url = `https://gitlab.com/api/v4/projects/${projectId}/repository/branches/${encodeURIComponent(branchName)}`;
  const res = await fetch(url, { method: "DELETE", headers: { "PRIVATE-TOKEN": process.env.GITLAB_TOKEN || "" } });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE branch returned ${res.status}`);
}

async function sendTeams(card: Record<string, unknown>): Promise<void> {
  if (!TEAMS_WEBHOOK_URL) return;
  try {
    await fetch(TEAMS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
    });
  } catch (err) {
    console.error("[squad-execute] Teams error:", err);
  }
}

export async function executeSquadInfra(
  id: number,
  resourceType: string,
  requestorEmail: string,
  reviewerEmail: string | null,
  payload: SquadPayload
): Promise<SquadExecuteResult> {
  // ── Secret value update: no .tf change, just re-trigger pipeline so the new
  //    CI/CD variable value (already set at request time) takes effect ──
  if (resourceType === "squad-secret-update") {
    const projectId = payload.gitlabProjectId;
    const defaultBranch = payload.defaultBranch || "main";
    try {
      const pipeline = await gitlabClient.triggerPipeline(projectId, defaultBranch);
      let jiraKey: string | null = null;
      try {
        const jiraResult = await jiraCreateIssue({
          projectKey: "SRE",
          issueTypeId: "10048",
          summary: `[Infra Squad] Actualización de secret — ${payload.resourceName} — ${payload.squadDisplayName}`,
          description: [
            `h2. Actualización de valor de secret #${id}`,
            ``,
            `||Campo||Valor||`,
            `|Squad|${payload.squadDisplayName}|`,
            `|Secret|${payload.resourceName}|`,
            `|Variable CI/CD|${(payload as any).ciVarKey}|`,
            `|Solicitante|${requestorEmail}|`,
            `|Aprobado por|${reviewerEmail || "N/A"}|`,
            `|Estado|Aprobada y pipeline relanzada|`,
            ``,
            `_El valor se actualizó como variable CI/CD en GitLab (nunca almacenado en el portal)._`,
          ].join("\n"),
          labels: ["SRE", "portal", "squad-infra", "secret-update", payload.squad],
          reporterEmail: requestorEmail,
        });
        jiraKey = jiraResult.key;
        await jiraSetReporterByEmail(jiraResult.key, requestorEmail);
        try { await jiraTransitionToDone(jiraResult.key); } catch { /* non-blocking */ }
      } catch (err) {
        console.error(`[squad-execute/${id}] Jira creation failed:`, err);
      }
      await pool.query(
        `UPDATE infra_requests SET status = 'executed', jira_key = $1, executed_at = NOW(), updated_at = NOW() WHERE id = $2`,
        [jiraKey, id]
      );
      await sendTeams({
        type: "message",
        attachments: [{
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            type: "AdaptiveCard", version: "1.4",
            body: [
              { type: "TextBlock", text: `🔑 Secret actualizado — ${payload.squadDisplayName}`, weight: "Bolder", size: "Medium" },
              { type: "FactSet", facts: [
                { title: "Secret", value: payload.resourceName },
                { title: "Variable", value: (payload as any).ciVarKey || "N/A" },
                { title: "Request", value: String(id) },
                { title: "Pipeline", value: pipeline ? "relanzada" : "lanzar manualmente" },
              ]},
            ],
          },
        }],
      });
      await notify(requestorEmail, "Secret actualizado", `El valor del secret "${payload.resourceName}" se ha actualizado y la pipeline se ha relanzado.`);
      return { ok: true, status: "executed" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await pool.query(`UPDATE infra_requests SET status = 'execute_failed', updated_at = NOW() WHERE id = $1`, [id]);
      await notify(requestorEmail, "Error actualizando secret", `La actualización falló: ${msg}`);
      return { ok: false, status: "execute_failed", error: msg };
    }
  }

  const label = TYPE_LABELS[resourceType] || resourceType;
  const projectId = payload.gitlabProjectId;
  const defaultBranch = payload.defaultBranch || "main";
  const branchName = `feat/SRE-${id}`;
  const filePath = payload.filePath;
  const resourceName = payload.resourceName;

  // Re-fetch the rendered HCL from terraform_preview (single source of truth).
  const { rows } = await pool.query(`SELECT terraform_preview FROM infra_requests WHERE id = $1`, [id]);
  const preview = typeof rows[0]?.terraform_preview === "string"
    ? JSON.parse(rows[0].terraform_preview)
    : (rows[0]?.terraform_preview || {});
  const hcl: string = preview?.content || "";

  // Validate HCL syntax before any write.
  const validation = validateHclSyntax(hcl);
  if (!validation.valid) {
    const summary = validation.errors.map((e) => e.message).join("; ");
    await pool.query(`UPDATE infra_requests SET status = 'execute_failed', updated_at = NOW() WHERE id = $1`, [id]);
    await notify(requestorEmail, "Error en solicitud de infraestructura", `El Terraform generado tiene errores: ${summary}`);
    return { ok: false, status: "execute_failed", error: summary };
  }

  let branchCreated = false;
  let reachedExecuted = false;

  try {
    // 1. Create branch
    await gitlabClient.createBranch(projectId, branchName, defaultBranch);
    branchCreated = true;

    const commitMessage = `[SRE-${id}] feat: ${resourceName} (${label})`;

    // 2. Write the resource file. For a MODIFICATION the preview already holds
    //    the full updated file → overwrite. For a CREATE, create the file, or
    //    append if the file already exists (shared files like s3.tf style).
    const existing = await gitlabClient.getRepositoryFileWithMeta(projectId, filePath, branchName).catch(() => null);
    if (payload.isModification) {
      if (!existing) {
        throw new Error(`Cannot modify: file "${filePath}" not found on branch`);
      }
      await gitlabClient.updateFile(projectId, filePath, branchName, hcl, commitMessage, existing.lastCommitId);
    } else if (existing && existing.content) {
      const merged = existing.content.replace(/\s*$/, "") + "\n\n" + hcl;
      await gitlabClient.updateFile(projectId, filePath, branchName, merged, commitMessage, existing.lastCommitId);
    } else {
      await gitlabClient.createFile(projectId, filePath, branchName, hcl, commitMessage);
    }

    // 3. For secrets: append variable declarations to variables.tf (idempotent-ish:
    //    only append if the variable name isn't already declared).
    if (payload.variablesHcl) {
      const varsPath = `${payload.filePath.split("/").slice(0, -1).join("/")}/variables.tf`;
      const varsFile = await gitlabClient.getRepositoryFileWithMeta(projectId, varsPath, branchName).catch(() => null);
      if (varsFile && varsFile.content) {
        // Append only declarations not already present.
        const toAppend = payload.variablesHcl
          .split(/\n\n/)
          .filter((block) => {
            const m = block.match(/variable\s+"([^"]+)"/);
            return m ? !new RegExp(`variable\\s+"${m[1]}"`).test(varsFile.content!) : true;
          })
          .join("\n\n");
        if (toAppend.trim()) {
          const merged = varsFile.content.replace(/\s*$/, "") + "\n\n" + toAppend + "\n";
          await gitlabClient.updateFile(projectId, varsPath, branchName, merged, `[SRE-${id}] chore: declare secret variables`, varsFile.lastCommitId);
        }
      } else {
        await gitlabClient.createFile(projectId, varsPath, branchName, payload.variablesHcl, `[SRE-${id}] chore: declare secret variables`);
      }
    }

    // 4. Open MR
    let mrUrl: string | null = null;
    try {
      const mr = await gitlabClient.createMR(
        projectId, branchName, defaultBranch,
        commitMessage,
        `## Squad Infra Request #${id}\n\nSquad: ${payload.squadDisplayName}\nResource: ${label} — ${resourceName}\nEnvironments: ${payload.environments.join(", ")}\n\nGenerado automáticamente por el Portal de Plataforma.`
      );
      mrUrl = mr.web_url;
    } catch (err) {
      console.error(`[squad-execute/${id}] createMR failed (non-fatal):`, err);
    }

    // 5. Jira ticket → transition to Done (access-management style)
    let jiraKey: string | null = null;
    try {
      const jiraResult = await jiraCreateIssue({
        projectKey: "SRE",
        issueTypeId: "10048",
        summary: `[Infra Squad] ${label} — ${resourceName} — ${payload.squadDisplayName}`,
        description: [
          `h2. Solicitud de infraestructura de squad #${id}`,
          ``,
          `||Campo||Valor||`,
          `|Squad|${payload.squadDisplayName}|`,
          `|Recurso|${label}|`,
          `|Nombre|${resourceName}|`,
          `|Entornos|${payload.environments.join(", ")}|`,
          `|Fichero|${filePath}|`,
          `|Rama|${branchName}|`,
          `|Solicitante|${requestorEmail}|`,
          `|Aprobado por|${reviewerEmail || "N/A"}|`,
          `|Estado|Aprobada y ejecutada|`,
          ``,
          `_Creado automáticamente desde el Portal de Plataforma._`,
        ].join("\n"),
        labels: ["SRE", "portal", "squad-infra", payload.squad],
        reporterEmail: requestorEmail,
      });
      jiraKey = jiraResult.key;
      await jiraSetReporterByEmail(jiraResult.key, requestorEmail);
      try { await jiraTransitionToDone(jiraResult.key); } catch (e) { console.error(`[squad-execute/${id}] Jira Done transition failed:`, e); }
    } catch (err) {
      console.error(`[squad-execute/${id}] Jira creation failed (non-blocking):`, err);
    }

    // 6. Trigger pipeline on the new branch
    const pipeline = await gitlabClient.triggerPipeline(projectId, branchName);

    // 7. Update DB
    await pool.query(
      `UPDATE infra_requests SET status = 'executed', gitlab_mr_url = $1, gitlab_branch = $2, jira_key = $3, executed_at = NOW(), updated_at = NOW() WHERE id = $4`,
      [mrUrl, branchName, jiraKey, id]
    );
    reachedExecuted = true;

    // 8. Teams notification
    await sendTeams({
      type: "message",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard", version: "1.4",
          body: [
            { type: "TextBlock", text: `🧩 Infra de Squad creada — ${payload.squadDisplayName}`, weight: "Bolder", size: "Medium" },
            { type: "FactSet", facts: [
              { title: "Recurso", value: `${label} — ${resourceName}` },
              { title: "Entornos", value: payload.environments.join(", ") },
              { title: "Request", value: String(id) },
              { title: "Jira", value: jiraKey || "N/A" },
              { title: "MR", value: mrUrl || "Crear manualmente" },
            ]},
          ],
          ...(mrUrl ? { actions: [{ type: "Action.OpenUrl", title: "Ver Merge Request", url: mrUrl }] } : {}),
        },
      }],
    });

    // 9. Notify requestor
    await notify(
      requestorEmail,
      `Infraestructura creada: ${label}`,
      `Tu ${label} "${resourceName}" se ha creado en el repo de ${payload.squadDisplayName}. ${mrUrl ? `MR: ${mrUrl}` : "Revisa el repositorio."}${pipeline ? " Pipeline lanzada." : ""}`
    );

    return { ok: true, status: "executed", mrUrl, branch: branchName };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[squad-execute/${id}] failed:`, msg);
    await pool.query(`UPDATE infra_requests SET status = 'execute_failed', updated_at = NOW() WHERE id = $1`, [id]);
    await notify(requestorEmail, "Error en solicitud de infraestructura", `La ejecución falló: ${msg}`);
    // Roll back the branch if we created it but didn't finish.
    if (branchCreated && !reachedExecuted) {
      try { await deleteBranch(projectId, branchName); } catch (e) { console.error(`[squad-execute/${id}] rollback failed:`, e); }
    }
    return { ok: false, status: "execute_failed", error: msg };
  }
}
