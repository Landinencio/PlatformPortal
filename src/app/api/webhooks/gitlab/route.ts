import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { gitlabClient } from "@/lib/gitlab";
import { notifyProdDeploy } from "@/lib/deploy-notify";

export const dynamic = "force-dynamic";

const WEBHOOK_SECRET = process.env.GITLAB_WEBHOOK_SECRET || "";

// Simple in-memory rate limiter (100 req/min per IP)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 100;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function POST(request: Request) {
  const ip = getClientIp(request);

  // Rate limiting
  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }

  // Validate Content-Type
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 400 });
  }

  // Validate webhook secret token
  const token = request.headers.get("x-gitlab-token");
  if (!WEBHOOK_SECRET) {
    console.warn("[webhook] GITLAB_WEBHOOK_SECRET not configured — accepting all events (dev mode)");
  } else if (token !== WEBHOOK_SECRET) {
    console.warn("[webhook] Invalid token from IP:", ip);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse payload
  let payload: any;
  try {
    payload = await request.json();
  } catch {
    console.warn("[webhook] Malformed JSON from IP:", ip);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Extract metadata from payload
  const eventType = payload.object_kind || request.headers.get("x-gitlab-event")?.replace(" Hook", "").toLowerCase() || "unknown";
  const projectId = payload.project?.id || null;
  const projectPath = payload.project?.path_with_namespace || null;
  const groupId = payload.project?.namespace_id || null;
  const groupName = extractGroupName(projectPath);

  // Store raw event
  try {
    const result = await pool.query(
      `INSERT INTO webhook_events_raw 
        (gitlab_event_type, gitlab_project_id, gitlab_group_id, project_path, group_name, payload, processing_status, source_ip)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       RETURNING id`,
      [eventType, projectId, groupId, projectPath, groupName, JSON.stringify(payload), ip]
    );

    const eventId = result.rows[0]?.id;
    console.log(`[webhook] Stored event #${eventId}: ${eventType} from ${projectPath || "unknown"} (${ip})`);

    // Fire-and-forget async processing (don't await — respond to GitLab fast)
    processEventAsync(eventId, eventType, payload).catch((err) => {
      console.error(`[webhook] Async processing failed for event #${eventId}:`, err);
    });

    return NextResponse.json({ ok: true, eventId });
  } catch (err) {
    console.error("[webhook] Failed to store event:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Cache for developer_name_map (loaded once, refreshed on miss)
let nameMapCache: Map<string, string> | null = null;
let nameMapLoadedAt = 0;
const NAME_MAP_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getNameMap(): Promise<Map<string, string>> {
  const now = Date.now();
  if (nameMapCache && now - nameMapLoadedAt < NAME_MAP_TTL_MS) return nameMapCache;
  try {
    const result = await pool.query<{ gitlab_username: string; canonical_name: string }>(
      `SELECT gitlab_username, canonical_name FROM developer_name_map`
    );
    nameMapCache = new Map(result.rows.map((r) => [r.gitlab_username, r.canonical_name]));
    nameMapLoadedAt = now;
  } catch {
    if (!nameMapCache) nameMapCache = new Map();
  }
  return nameMapCache;
}

/** Resolve canonical name: try name map by email local part, then by username */
async function resolveCanonicalName(name: string, email: string | null, username: string | null): Promise<string> {
  const map = await getNameMap();
  if (username && map.has(username)) return map.get(username)!;
  const local = (email || "").split("@")[0];
  if (local && map.has(local)) return map.get(local)!;
  return name;
}

function extractGroupName(projectPath: string | null): string | null {
  if (!projectPath) return null;
  const parts = projectPath.split("/");
  return parts.length >= 2 ? parts[1] : parts[0];
}

function extractTeam(projectPath: string | null): string {
  if (!projectPath) return "unknown";
  const parts = projectPath.split("/");
  // iskaypetcom/digital/team/project → "team"
  // iskaypetcom/retail/team/project → "team"
  return parts.length >= 3 ? parts[2] : parts.length >= 2 ? parts[1] : parts[0];
}

function extractProjectName(projectPath: string | null): string {
  if (!projectPath) return "unknown";
  const parts = projectPath.split("/");
  return parts[parts.length - 1] || "unknown";
}

function todayDate(): string {
  return new Date().toISOString().split("T")[0];
}

const PROD_ENV_PATTERNS = ["production", "prod", "prd", "live"];
const NON_PROD_ENV_PATTERNS = ["dev", "uat", "staging", "stg", "test", "qa", "sandbox"];

function isProductionEnvironment(env: string | null): boolean {
  if (!env) return false;
  const lower = env.toLowerCase();
  // Exclude non-production environments first (e.g. "product-dev" contains "prod" but is dev)
  if (NON_PROD_ENV_PATTERNS.some((p) => lower.includes(p))) return false;
  // Match production patterns including "-pro" suffix (e.g. "customers-pro", "data-pro")
  return PROD_ENV_PATTERNS.some((p) => lower.includes(p)) || lower.endsWith("-pro");
}

// ─── Async Event Processor ──────────────────────────────────────────────────

async function processEventAsync(eventId: number, eventType: string, payload: any) {
  const startedAt = new Date();

  try {
    await pool.query(
      `UPDATE webhook_events_raw SET processing_status = 'processing' WHERE id = $1`,
      [eventId]
    );

    switch (eventType) {
      case "deployment":
        await processDeployment(eventId, payload);
        break;
      case "merge_request":
        await processMergeRequest(eventId, payload);
        break;
      case "pipeline":
        await processPipeline(eventId, payload);
        break;
      case "push":
        await processPush(eventId, payload);
        break;
      case "note":
        await processNote(eventId, payload);
        break;
      default:
        // Unknown event type — store but skip processing
        await pool.query(
          `UPDATE webhook_events_raw SET processing_status = 'skipped', processed_at = NOW() WHERE id = $1`,
          [eventId]
        );
        await logProcessing(eventId, 1, startedAt, "success", null, null);
        return;
    }

    // Mark as processed
    await pool.query(
      `UPDATE webhook_events_raw SET processing_status = 'processed', processed_at = NOW() WHERE id = $1`,
      [eventId]
    );
    await logProcessing(eventId, 1, startedAt, "success", null, null);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[webhook] Processing error for event #${eventId}:`, errMsg);

    await pool.query(
      `UPDATE webhook_events_raw SET processing_status = 'failed', error_message = $2, retry_count = retry_count + 1 WHERE id = $1`,
      [eventId, errMsg]
    ).catch(() => {});

    await logProcessing(eventId, 1, startedAt, "error", errMsg, null).catch(() => {});
  }
}

async function logProcessing(
  eventId: number,
  attempt: number,
  startedAt: Date,
  status: string,
  errorMessage: string | null,
  metricsAffected: any
) {
  await pool.query(
    `INSERT INTO webhook_processing_log (event_id, attempt_number, started_at, completed_at, status, error_message, metrics_affected)
     VALUES ($1, $2, $3, NOW(), $4, $5, $6)`,
    [eventId, attempt, startedAt, status, errorMessage, metricsAffected ? JSON.stringify(metricsAffected) : null]
  );
}

// ─── Event Processors — Phase 2: Incremental UPSERTs ────────────────────────

async function processDeployment(eventId: number, payload: any) {
  const status = payload.status || payload.deployable_status || "";
  const env = payload.environment || "";
  const projectPath = payload.project?.path_with_namespace || "";

  console.log(`[webhook:deployment] #${eventId} | ${projectPath} | env=${env} | status=${status} | (log-only, DORA handled by snapshot)`);

  // Deployment events are logged in webhook_events_raw for auditing.
  // DORA metrics (deployment_count, lead_time, CFR, MTTR) are computed
  // exclusively by the daily snapshot via deploy-job detection, which is
  // more reliable than environment-based detection from webhooks.
}

async function processMergeRequest(eventId: number, payload: any) {
  const action = payload.object_attributes?.action || "unknown";
  const state = payload.object_attributes?.state || "unknown";
  // Use the MR author's email from object_attributes, NOT from last_commit
  // last_commit.author.email is the committer, not necessarily the MR author
  const authorUsername = payload.user?.username || null;
  const authorName = payload.user?.name || authorUsername || "unknown";
  // CRITICAL: Only use payload.user.email if available. If not, construct from username.
  // Never use last_commit.author.email as it belongs to a different person (the committer).
  const authorEmail = payload.user?.email || null;
  const projectId = payload.project?.id;
  const projectPath = payload.project?.path_with_namespace || "";
  const projectName = extractProjectName(projectPath);
  const team = extractTeam(projectPath);
  const mrIid = payload.object_attributes?.iid || null;
  const snapshotDate = todayDate();

  console.log(`[webhook:merge_request] #${eventId} | ${projectPath} | !${mrIid} | action=${action} | state=${state} | author=${authorUsername}`);

  if (!projectId) return;

  // Use real email if available, otherwise construct a safe identifier from username
  // This prevents attributing MR activity to the wrong person
  const devEmail = authorEmail
    ? authorEmail.toLowerCase()
    : authorUsername
      ? `${authorUsername}@unknown.local`
      : "unknown@unknown.local";
  const resolvedName = await resolveCanonicalName(authorName, devEmail, authorUsername);

  // UPSERT developer_activity_daily — track MR activity
  if (action === "merge" || state === "merged") {
    await pool.query(`
      INSERT INTO developer_activity_daily (
        snapshot_date, developer_email, developer_name, team,
        project_id, project_name, project_path,
        mrs_merged, data_source, calculated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'webhook', NOW())
      ON CONFLICT (snapshot_date, developer_email, project_id) DO UPDATE SET
        mrs_merged = developer_activity_daily.mrs_merged + 1,
        data_source = 'webhook',
        calculated_at = NOW()
    `, [snapshotDate, devEmail, resolvedName, team, projectId, projectName, projectPath]);
  } else if (action === "open" || action === "reopen") {
    await pool.query(`
      INSERT INTO developer_activity_daily (
        snapshot_date, developer_email, developer_name, team,
        project_id, project_name, project_path,
        mrs_opened, data_source, calculated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'webhook', NOW())
      ON CONFLICT (snapshot_date, developer_email, project_id) DO UPDATE SET
        mrs_opened = developer_activity_daily.mrs_opened + 1,
        data_source = 'webhook',
        calculated_at = NOW()
    `, [snapshotDate, devEmail, resolvedName, team, projectId, projectName, projectPath]);
  }
}

async function processPipeline(eventId: number, payload: any) {
  const status = payload.object_attributes?.status || "unknown";
  const ref = payload.object_attributes?.ref || "";
  const projectPath = payload.project?.path_with_namespace || "";
  const pipelineId = payload.object_attributes?.id || null;

  const builds = payload.builds || [];
  const DEPLOY_PATTERNS = ["deploy_prod", "deploy-production", "deploy_artifact", "deploy-artifact", "deploy_prd", "deploy-prd"];
  const deployJobs = builds.filter((b: any) =>
    DEPLOY_PATTERNS.some((p) => (b.stage || "").includes(p) || (b.name || "").includes(p))
  );
  const successfulDeployJobs = deployJobs.filter((b: any) => b.status === "success");
  const failedDeployJobs = deployJobs.filter((b: any) => b.status === "failed");

  console.log(`[webhook:pipeline] #${eventId} | ${projectPath} | pipeline=${pipelineId} | status=${status} | ref=${ref} | deploy_jobs=${deployJobs.length} (ok=${successfulDeployJobs.length}, fail=${failedDeployJobs.length}) | (log-only, DORA handled by snapshot)`);

  // Pipeline events are logged in webhook_events_raw for auditing.
  // Deployment failures and MTTR are computed by the daily snapshot
  // which has full pipeline history context for accurate recovery tracking.
  //
  // NOTE: infra-request "live in AWS" notification is intentionally NOT done
  // here. Pipeline state is not a reliable source of truth (an apply can time
  // out on the runner yet the resource is created in AWS; multi-env applies run
  // as separate stages; and branch names like feat/SRE-<n> collide with real
  // SRE Jira tickets). Instead, src/lib/infra-live-detector.ts polls AWS
  // directly per environment account and is run by the infra-live-check cronjob.

  // Prod-deploy → Teams notification (best-effort, fire-and-forget). Gated by
  // DEPLOY_NOTIFY_ENABLED (prod-only) + deduplicated in DB. Never blocks the
  // webhook response and does NOT affect DORA (computed by the snapshot).
  notifyProdDeploy(payload).catch((err) =>
    console.error(`[webhook:pipeline] #${eventId} notifyProdDeploy failed:`, err)
  );
}

async function processPush(eventId: number, payload: any) {
  const ref = payload.ref || "";
  const projectId = payload.project?.id;
  const projectPath = payload.project?.path_with_namespace || "";
  const projectName = extractProjectName(projectPath);
  const team = extractTeam(projectPath);
  const commits = payload.commits || [];
  const snapshotDate = todayDate();

  console.log(`[webhook:push] #${eventId} | ${projectPath} | ref=${ref} | commits=${commits.length}`);

  if (!projectId || commits.length === 0) return;

  // Aggregate commits by author
  const authorMap = new Map<string, { name: string; count: number; added: number; removed: number }>();
  for (const commit of commits) {
    // CRITICAL: Only use the commit's own author email. Never fall back to the pusher's email.
    // If a commit has no author email, it's better to attribute to unknown than to the wrong person.
    const rawEmail = commit.author?.email;
    if (!rawEmail) {
      // Skip commits without author email — they cannot be reliably attributed
      continue;
    }
    const email = rawEmail.toLowerCase();
    const rawName = commit.author?.name || email.split("@")[0];
    const name = await resolveCanonicalName(rawName, email, null);
    const existing = authorMap.get(email) || { name, count: 0, added: 0, removed: 0 };
    existing.count += 1;
    // Keep the best name (longest, most likely to be a real name)
    if (name.length > existing.name.length) existing.name = name;
    authorMap.set(email, existing);
  }

  // Enrich with line stats from GitLab API (fire-and-forget, best effort)
  // Push webhooks don't include line counts — only the commits API has stats
  try {
    for (const commit of commits) {
      const rawEmail = commit.author?.email;
      if (!rawEmail) continue; // Skip commits without author email
      const email = rawEmail.toLowerCase();
      const info = await gitlabClient.getCommitInfo(projectId, commit.id);
      if (info?.stats) {
        const entry = authorMap.get(email);
        if (entry) {
          entry.added += info.stats.additions || 0;
          entry.removed += info.stats.deletions || 0;
        }
      }
    }
  } catch (err) {
    console.warn(`[webhook:push] #${eventId} | Failed to enrich line stats:`, err);
  }

  // UPSERT developer_activity_daily per author
  for (const [email, data] of authorMap) {
    await pool.query(`
      INSERT INTO developer_activity_daily (
        snapshot_date, developer_email, developer_name, team,
        project_id, project_name, project_path,
        commits_count, lines_added, lines_removed, data_source, calculated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'webhook', NOW())
      ON CONFLICT (snapshot_date, developer_email, project_id) DO UPDATE SET
        commits_count = developer_activity_daily.commits_count + $8,
        lines_added = developer_activity_daily.lines_added + $9,
        lines_removed = developer_activity_daily.lines_removed + $10,
        developer_name = CASE
          WHEN developer_activity_daily.developer_name IS NULL OR developer_activity_daily.developer_name = '' OR developer_activity_daily.developer_name LIKE '%@%'
          THEN EXCLUDED.developer_name
          ELSE developer_activity_daily.developer_name
        END,
        data_source = 'webhook',
        calculated_at = NOW()
    `, [snapshotDate, email, data.name, team, projectId, projectName, projectPath, data.count, data.added, data.removed]);
  }

  // UPSERT dora_metrics_daily — total commits for the project
  await pool.query(`
    INSERT INTO dora_metrics_daily (
      snapshot_date, project_id, team, project_name, project_path,
      total_commits, data_source, calculated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, 'webhook', NOW())
    ON CONFLICT (snapshot_date, project_id) DO UPDATE SET
      total_commits = dora_metrics_daily.total_commits + $6,
      data_source = 'webhook',
      calculated_at = NOW()
  `, [snapshotDate, projectId, team, projectName, projectPath, commits.length]);

  // Also update active_developers count
  await pool.query(`
    UPDATE dora_metrics_daily
    SET active_developers = (
      SELECT COUNT(DISTINCT developer_email)
      FROM developer_activity_daily
      WHERE snapshot_date = $1 AND project_id = $2
    )
    WHERE snapshot_date = $1 AND project_id = $2
  `, [snapshotDate, projectId]);
}

async function processNote(eventId: number, payload: any) {
  const noteableType = payload.object_attributes?.noteable_type || "";
  const authorUsername = payload.user?.username || null;
  const authorName = payload.user?.name || authorUsername || "unknown";
  // CRITICAL: Only use real email from payload. If not available, use username@unknown.local
  // This prevents attributing review activity to the wrong person
  const authorEmail = payload.user?.email
    ? payload.user.email.toLowerCase()
    : authorUsername
      ? `${authorUsername}@unknown.local`
      : "unknown@unknown.local";
  const projectId = payload.project?.id;
  const projectPath = payload.project?.path_with_namespace || "";
  const projectName = extractProjectName(projectPath);
  const team = extractTeam(projectPath);
  const snapshotDate = todayDate();
  const resolvedName = await resolveCanonicalName(authorName, authorEmail, authorUsername);

  console.log(`[webhook:note] #${eventId} | ${projectPath} | type=${noteableType} | author=${authorUsername}`);

  // Only count MR comments as reviews
  if (noteableType !== "MergeRequest" || !projectId) return;

  await pool.query(`
    INSERT INTO developer_activity_daily (
      snapshot_date, developer_email, developer_name, team,
      project_id, project_name, project_path,
      reviews_given, data_source, calculated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'webhook', NOW())
    ON CONFLICT (snapshot_date, developer_email, project_id) DO UPDATE SET
      reviews_given = developer_activity_daily.reviews_given + 1,
      data_source = 'webhook',
      calculated_at = NOW()
  `, [snapshotDate, authorEmail, resolvedName, team, projectId, projectName, projectPath]);
}
