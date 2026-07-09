// Production deploy → Teams notification.
//
// Sends a rich Adaptive Card to a DEDICATED Teams channel every time a GitLab
// pipeline performs a successful production deploy. Triggered from the existing
// webhook receiver (processPipeline) as a fire-and-forget best-effort call.
//
// Design (see .kiro/specs/prod-deploy-teams-notify/design.md):
//  - detectProdDeploy(payload): pure — is this pipeline event a successful prod deploy?
//  - buildDeployInfo(payload, client): best-effort enrichment (MR + commit).
//  - buildDeployCard(info): pure — the Adaptive Card.
//  - notifyProdDeploy(payload, deps?): orchestrator — gate → detect → claim (dedup)
//    → enrich → build → send. NEVER throws; returns { sent, reason }.
//
// Two anti-duplicate layers:
//  1. PROD-ONLY gate (DEPLOY_NOTIFY_ENABLED="true", only in values-prod.yaml).
//     dev and prod have separate DBs so the DB dedup does NOT cross environments.
//  2. DB dedup (deploy_notifications, atomic ON CONFLICT claim) — intra-environment
//     (2 replicas + GitLab redeliveries).

import pool from "@/lib/db";
import { gitlabClient } from "@/lib/gitlab";
import { sendTeamsCard } from "@/lib/teams-notify";

// Canonical prod-deploy job patterns, shared with dora-snapshot.ts. Substring
// match (case-insensitive) against build.name and build.stage.
const DEPLOY_JOB_NAMES = (
  process.env.DORA_DEPLOY_JOB_NAMES ||
  "deploy_prod,deploy-production,deploy_artifact,deploy-artifact,deploy_prd,deploy-prd,android_playstore_prod,ios_appstore_prod,playstore_prod,appstore_prod,distribute_prod"
)
  .split(",")
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DeployJob {
  name: string;
  stage: string;
  status: string;
  finished_at: string | null;
}

export interface ProdDeployDetection {
  isProdDeploy: boolean;
  /** The first matching prod-deploy build with status "success". */
  job: DeployJob | null;
}

export interface DeployMrInfo {
  iid: number;
  title: string;
  author: string;
  url: string;
}

export interface DeployInfo {
  projectName: string;
  projectPath: string;
  team: string;
  environment: string;
  deployedAt: string; // ISO
  jobName: string;
  ref: string;
  commitSha: string;
  commitShort: string;
  commitMessage: string;
  commitAuthor: string;
  pipelineId: number;
  pipelineUrl: string;
  projectWebUrl: string;
  mr: DeployMrInfo | null;
}

export type NotifyReason =
  | "disabled"
  | "not-prod-deploy"
  | "already-notified"
  | "claim-error"
  | "no-webhook"
  | "send-failed"
  | "sent";

export interface NotifyResult {
  sent: boolean;
  reason: NotifyReason;
}

/** Result of an atomic dedup claim. `ok` true means this caller won the claim. */
export interface ClaimResult {
  ok: boolean;
  error?: boolean;
}

export interface DeployNotifyDeps {
  /** Prod gate value (defaults to process.env.DEPLOY_NOTIFY_ENABLED). */
  enabled: string | undefined;
  detect: (payload: any) => ProdDeployDetection;
  claim: (pipelineId: number, projectId: number, projectPath: string) => Promise<ClaimResult>;
  buildInfo: (payload: any) => Promise<DeployInfo>;
  sendCard: (card: Record<string, unknown>, webhookUrl: string | undefined) => Promise<boolean>;
  webhookUrl: string | undefined;
}

// ─── Path helpers (kept local so the route stays decoupled) ──────────────────

function extractProjectName(projectPath: string): string {
  if (!projectPath) return "unknown";
  const parts = projectPath.split("/");
  return parts[parts.length - 1] || "unknown";
}

function extractTeam(projectPath: string): string {
  if (!projectPath) return "unknown";
  const parts = projectPath.split("/");
  // iskaypetcom/digital/team/project → "team"
  return parts.length >= 3 ? parts[2] : parts.length >= 2 ? parts[1] : parts[0];
}

function matchesDeployPattern(value: string | null | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return DEPLOY_JOB_NAMES.some((p) => lower.includes(p));
}

// ─── 1. Detection (pure) ─────────────────────────────────────────────────────

/**
 * Pure. Returns whether a `pipeline` webhook payload represents a SUCCESSFUL
 * production deploy: pipeline status "success" AND at least one build whose
 * name/stage matches a prod-deploy pattern with status "success". Never throws.
 */
export function detectProdDeploy(payload: any): ProdDeployDetection {
  const none: ProdDeployDetection = { isProdDeploy: false, job: null };

  const pipelineStatus = payload?.object_attributes?.status;
  if (pipelineStatus !== "success") return none;

  const builds = payload?.builds;
  if (!Array.isArray(builds) || builds.length === 0) return none;

  for (const b of builds) {
    const name: string | null = b?.name ?? null;
    const stage: string | null = b?.stage ?? null;
    const status: string = b?.status ?? "";
    if (status !== "success") continue;
    if (matchesDeployPattern(name) || matchesDeployPattern(stage)) {
      return {
        isProdDeploy: true,
        job: {
          name: name || "",
          stage: stage || "",
          status,
          finished_at: b?.finished_at ?? null,
        },
      };
    }
  }

  return none;
}

// ─── 2. Enrichment (best-effort) ─────────────────────────────────────────────

interface GitLabLike {
  getMergeRequestsForCommit: (
    projectId: number,
    commitSha: string,
  ) => Promise<Array<{ iid: number; title: string }>>;
}

/**
 * Best-effort enrichment. Builds a DeployInfo from the pipeline payload, adding
 * MR details (from payload.merge_request, or via the commit→MR lookup). Never
 * throws: on any GitLab API failure it falls back to payload data.
 */
export async function buildDeployInfo(payload: any, client: GitLabLike = gitlabClient): Promise<DeployInfo> {
  const projectPath: string = payload?.project?.path_with_namespace || "";
  const projectId: number = payload?.project?.id || 0;
  const projectWebUrl: string = payload?.project?.web_url || "";

  const detection = detectProdDeploy(payload);
  const job = detection.job;

  const oa = payload?.object_attributes || {};
  const pipelineId: number = oa.id || 0;
  const ref: string = oa.ref || "";
  const pipelineUrl: string =
    oa.url || (projectWebUrl && pipelineId ? `${projectWebUrl}/-/pipelines/${pipelineId}` : "");

  const commit = payload?.commit || {};
  const commitSha: string = commit.id || "";
  const commitShort: string = commitSha ? commitSha.slice(0, 8) : "";
  const commitMessage: string = (commit.message || commit.title || "").split("\n")[0];
  const commitAuthor: string = commit.author?.name || commit.author?.email || "unknown";

  const deployedAt: string =
    job?.finished_at || commit.timestamp || oa.finished_at || new Date().toISOString();

  // MR: prefer the payload, fall back to the commit→MR lookup.
  let mr: DeployMrInfo | null = null;
  const payloadMr = payload?.merge_request;
  if (payloadMr && payloadMr.iid) {
    mr = {
      iid: payloadMr.iid,
      title: payloadMr.title || "",
      author: payloadMr.author?.name || payloadMr.author?.username || "",
      url: payloadMr.url || (projectWebUrl ? `${projectWebUrl}/-/merge_requests/${payloadMr.iid}` : ""),
    };
  } else if (projectId && commitSha) {
    try {
      const mrs = await client.getMergeRequestsForCommit(projectId, commitSha);
      if (Array.isArray(mrs) && mrs.length > 0) {
        const first = mrs[0];
        mr = {
          iid: first.iid,
          title: first.title || "",
          author: "",
          url: projectWebUrl ? `${projectWebUrl}/-/merge_requests/${first.iid}` : "",
        };
      }
    } catch (err) {
      console.warn(`[deploy-notify] MR enrichment failed for ${projectPath}@${commitShort}:`, err);
    }
  }

  return {
    projectName: extractProjectName(projectPath),
    projectPath,
    team: extractTeam(projectPath),
    environment: "production",
    deployedAt,
    jobName: job?.name || "",
    ref,
    commitSha,
    commitShort,
    commitMessage,
    commitAuthor,
    pipelineId,
    pipelineUrl,
    projectWebUrl,
    mr,
  };
}

// ─── 3. Card (pure) ──────────────────────────────────────────────────────────

function formatMadrid(iso: string): string {
  try {
    return new Intl.DateTimeFormat("es-ES", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/Madrid",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function truncate(s: string, max = 120): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Pure. Builds the Teams Adaptive Card for a prod deploy. Same envelope as
 * teams-notify.ts ({ type:"message", attachments:[{ contentType, content }] }).
 */
export function buildDeployCard(info: DeployInfo): Record<string, unknown> {
  const facts: Array<{ title: string; value: string }> = [
    { title: "Microservicio", value: info.projectName },
    { title: "Equipo", value: info.team },
    { title: "Entorno", value: info.environment },
    { title: "Cuándo", value: formatMadrid(info.deployedAt) },
    { title: "Rama/Tag", value: info.ref || "—" },
  ];

  if (info.commitShort) {
    facts.push({ title: "Commit", value: `${info.commitShort} — ${truncate(info.commitMessage)}` });
  }
  facts.push({ title: "Autor", value: info.commitAuthor });
  if (info.mr) {
    facts.push({ title: "MR", value: `!${info.mr.iid} — ${truncate(info.mr.title)}` });
  }
  if (info.pipelineId) {
    facts.push({ title: "Pipeline", value: `#${info.pipelineId}` });
  }

  const body: Array<Record<string, unknown>> = [
    {
      type: "TextBlock",
      text: `🚀 Deploy a producción — ${info.projectName}`,
      weight: "Bolder",
      size: "Medium",
      color: "Accent",
      wrap: true,
    },
    {
      type: "TextBlock",
      text: `**${info.team}** desplegó **${info.projectName}** a producción`,
      wrap: true,
    },
    {
      type: "FactSet",
      facts,
    },
  ];

  const actions: Array<Record<string, unknown>> = [];
  if (info.mr?.url) actions.push({ type: "Action.OpenUrl", title: "Ver MR", url: info.mr.url });
  if (info.pipelineUrl) actions.push({ type: "Action.OpenUrl", title: "Ver pipeline", url: info.pipelineUrl });
  if (info.projectWebUrl) actions.push({ type: "Action.OpenUrl", title: "Ver proyecto", url: info.projectWebUrl });

  const content: Record<string, unknown> = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    msteams: { width: "Full" },
    body,
  };
  if (actions.length > 0) content.actions = actions;

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content,
      },
    ],
  };
}

// ─── 4. Dedup claim (default impl) ───────────────────────────────────────────

/**
 * Atomic dedup claim. INSERT ... ON CONFLICT DO NOTHING RETURNING. The first
 * caller for a (pipeline_id, project_id) wins (rowCount === 1). A DB error is
 * surfaced as { ok:false, error:true } so the orchestrator can return
 * "claim-error" without spamming.
 */
async function claimDeployNotification(
  pipelineId: number,
  projectId: number,
  projectPath: string,
): Promise<ClaimResult> {
  try {
    const res = await pool.query(
      `INSERT INTO deploy_notifications (pipeline_id, project_id, project_path)
       VALUES ($1, $2, $3)
       ON CONFLICT (pipeline_id, project_id) DO NOTHING
       RETURNING pipeline_id`,
      [pipelineId, projectId, projectPath],
    );
    return { ok: (res.rowCount ?? 0) > 0 };
  } catch (err) {
    console.error(`[deploy-notify] dedup claim failed for pipeline ${pipelineId}/${projectId}:`, err);
    return { ok: false, error: true };
  }
}

// ─── 5. Orchestrator ─────────────────────────────────────────────────────────

function resolveDeps(deps?: Partial<DeployNotifyDeps>): DeployNotifyDeps {
  const d = deps || {};
  return {
    // Use key-presence (not `!== undefined`) so an explicit `undefined`/empty
    // override wins over the ambient env — keeps tests deterministic in CI.
    enabled: "enabled" in d ? d.enabled : process.env.DEPLOY_NOTIFY_ENABLED,
    detect: d.detect || detectProdDeploy,
    claim: d.claim || claimDeployNotification,
    buildInfo: d.buildInfo || ((payload: any) => buildDeployInfo(payload)),
    sendCard: d.sendCard || sendTeamsCard,
    webhookUrl: "webhookUrl" in d ? d.webhookUrl : process.env.DEPLOY_TEAMS_WEBHOOK_URL,
  };
}

/**
 * Orchestrator. Gate → detect → claim (dedup) → enrich → build → send. NEVER
 * throws (best-effort); returns { sent, reason } for logging/tests. Called
 * fire-and-forget from processPipeline().
 */
export async function notifyProdDeploy(
  payload: any,
  deps?: Partial<DeployNotifyDeps>,
): Promise<NotifyResult> {
  try {
    const d = resolveDeps(deps);

    // (1) Prod-only gate — first line of defense against cross-environment dupes.
    if (d.enabled !== "true") return { sent: false, reason: "disabled" };

    // (2) Detection.
    const detection = d.detect(payload);
    if (!detection.isProdDeploy) return { sent: false, reason: "not-prod-deploy" };

    const pipelineId: number = payload?.object_attributes?.id || 0;
    const projectId: number = payload?.project?.id || 0;
    const projectPath: string = payload?.project?.path_with_namespace || "";

    // (3) Atomic dedup claim BEFORE sending.
    const claim = await d.claim(pipelineId, projectId, projectPath);
    if (claim.error) return { sent: false, reason: "claim-error" };
    if (!claim.ok) return { sent: false, reason: "already-notified" };

    // (4) Webhook must exist.
    if (!d.webhookUrl) {
      console.warn("[deploy-notify] DEPLOY_TEAMS_WEBHOOK_URL not configured — skipping");
      return { sent: false, reason: "no-webhook" };
    }

    // (5) Enrich + build + send.
    const info = await d.buildInfo(payload);
    const card = buildDeployCard(info);
    const ok = await d.sendCard(card, d.webhookUrl);
    if (!ok) return { sent: false, reason: "send-failed" };

    console.log(`[deploy-notify] notified prod deploy ${info.projectName} pipeline #${pipelineId}`);
    return { sent: true, reason: "sent" };
  } catch (err) {
    console.error("[deploy-notify] unexpected error:", err);
    return { sent: false, reason: "send-failed" };
  }
}
