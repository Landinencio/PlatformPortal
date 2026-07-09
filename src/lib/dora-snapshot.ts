import pool from "@/lib/db";
import { mergeDevelopersByIdentity } from "@/lib/developer-identity";
import {
  gitlabClient,
  type GitLabCommit,
  type GitLabMergeRequestForCommit,
  type GitLabProject,
} from "@/lib/gitlab";
import { addDays, differenceInMinutes, subDays } from "date-fns";

const SNAPSHOT_GROUP_IDS = (process.env.DORA_SNAPSHOT_GROUP_IDS || "66347331")
  .split(",").map((id) => parseInt(id.trim(), 10)).filter((id) => id > 0);

const PROD_ENVIRONMENTS = (process.env.DORA_PROD_ENVIRONMENTS || "production,prod,prd,live")
  .split(",").map((env) => env.trim().toLowerCase()).filter(Boolean);
const NON_PROD_KEYWORDS = ["dev", "uat", "staging", "stg", "test", "qa", "sandbox"];
const DEPLOY_JOB_NAMES = (process.env.DORA_DEPLOY_JOB_NAMES || "deploy_prod,deploy-production,deploy_artifact,deploy-artifact,deploy_prd,deploy-prd,android_playstore_prod,ios_appstore_prod,playstore_prod,appstore_prod,distribute_prod")
  .split(",").map((name) => name.trim()).filter(Boolean);
const HOTFIX_BRANCH_PREFIXES = (process.env.DORA_HOTFIX_BRANCH_PREFIXES || "hotfix/,hotfix-")
  .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
const HOTFIX_LABELS = (process.env.DORA_HOTFIX_LABELS || "hotfix,incident")
  .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
const ROLLBACK_BRANCH_PREFIXES = (process.env.DORA_ROLLBACK_BRANCH_PREFIXES || "rollback/,revert/")
  .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
const ROLLBACK_LABELS = (process.env.DORA_ROLLBACK_LABELS || "rollback,revert")
  .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);

const FAILURE_WINDOW_HOURS = parseInt(process.env.DORA_FAILURE_WINDOW_HOURS || "24", 10);
const MTTR_LOOKBACK_DAYS = parseInt(process.env.DORA_MTTR_LOOKBACK_DAYS || "14", 10);
const MAX_LEAD_TIME_HOURS = 90 * 24;

type DeploymentEvent = {
  id: number | string;
  created_at: string;
  commit_sha?: string | null;
  commit_created_at?: string | null;
  commit_author_email?: string | null;
  environment?: string | null;
};

type DeploymentTrace = {
  commit_sha: string;
  commit_created_at: Date | null;
  commit_author_email: string | null;
  mr_id: number | null;
  mr_iid: number | null;
  mr_created_at: Date | null;
  mr_merged_at: Date | null;
  mr_title: string | null;
  mr_labels: string[];
  mr_source_branch: string | null;
  mr_first_commit_at: Date | null;
  mr_last_commit_at: Date | null;
  mr_commit_count: number;
  deploy_id: string;
  deploy_created_at: Date;
  deploy_type: "feature" | "hotfix" | "rollback";
  deploy_type_reason: string;
  deploy_environment: string | null;
  lead_time_commit_hours: number | null;
  lead_time_mr_hours: number | null;
  lead_time_first_commit_hours: number | null;
  changes: DeploymentChange[];
};

type DeploymentChange = {
  commit_sha: string;
  commit_created_at: Date | null;
  author_email: string | null;
  mr_id: number | null;
  mr_iid: number | null;
  mr_created_at: Date | null;
  mr_first_commit_at: Date | null;
  mr_merged_at: Date | null;
};

type DeploymentHistoryEntry = {
  deploy_time: Date;
  commit_sha: string;
};

type TraceabilitySchemaRow = {
  services: string | null;
  production_deployments: string | null;
  deployment_changes: string | null;
};

type CanonicalGitLabSchemaRow = {
  gitlab_deploy_jobs: string | null;
  gitlab_deploy_attempts: string | null;
};

type GitLabDeployJob = {
  id: number | string;
  name?: string | null;
  stage?: string | null;
  status?: string | null;
  ref?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  web_url?: string | null;
  commit?: {
    id?: string | null;
    created_at?: string | null;
    author_email?: string | null;
  } | null;
  environment?: {
    name?: string | null;
  } | null;
  pipeline?: {
    id?: number | string | null;
  } | null;
  allow_failure?: boolean;
  retried?: boolean;
};

const toUtcDayStart = (dateStr: string) => new Date(`${dateStr}T00:00:00.000Z`);
const isWithinWindow = (date: Date, start: Date, end: Date) => date >= start && date < end;
const safeFetch = async <T>(label: string, action: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    console.error(`Error fetching ${label}:`, error);
    return fallback;
  }
};

const slugify = (value: string) => value
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 120);

function sortAndUniqCommits(commits: GitLabCommit[]): GitLabCommit[] {
  const byId = new Map<string, GitLabCommit>();
  for (const commit of commits) {
    if (!commit?.id || byId.has(commit.id)) continue;
    byId.set(commit.id, commit);
  }

  return [...byId.values()].sort(
    (left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
  );
}

function sortAndUniqDeploymentHistory(entries: DeploymentHistoryEntry[]): DeploymentHistoryEntry[] {
  const deduped = new Map<string, DeploymentHistoryEntry>();
  for (const entry of entries) {
    if (!entry.commit_sha) continue;
    const timestamp = entry.deploy_time?.toISOString?.() || "";
    const key = `${entry.commit_sha}:${timestamp}`;
    if (!deduped.has(key)) {
      deduped.set(key, entry);
    }
  }

  return [...deduped.values()].sort(
    (left, right) => left.deploy_time.getTime() - right.deploy_time.getTime()
  );
}

function sanitizeLeadTimeHours(hours: number | null): number | null {
  if (hours === null || !Number.isFinite(hours) || hours < 0 || hours > MAX_LEAD_TIME_HOURS) {
    return null;
  }
  return hours;
}

function resolveUsableLeadTimeReference(deployTime: Date, referenceTime: Date | null): Date | null {
  if (!referenceTime || Number.isNaN(referenceTime.getTime())) {
    return null;
  }

  const leadTimeHours = sanitizeLeadTimeHours(
    differenceInMinutes(deployTime, referenceTime) / 60
  );

  return leadTimeHours === null ? null : referenceTime;
}

async function isProductionTraceabilityReady() {
  const result = await pool.query<TraceabilitySchemaRow>(`
    SELECT
      to_regclass('public.services')::text AS services,
      to_regclass('public.production_deployments')::text AS production_deployments,
      to_regclass('public.deployment_changes')::text AS deployment_changes
  `);

  const row = result.rows[0];
  return Boolean(
    row?.services &&
    row?.production_deployments &&
    row?.deployment_changes
  );
}

async function isCanonicalGitLabDeployReady() {
  const result = await pool.query<CanonicalGitLabSchemaRow>(`
    SELECT
      to_regclass('public.gitlab_deploy_jobs')::text AS gitlab_deploy_jobs,
      to_regclass('public.gitlab_deploy_attempts')::text AS gitlab_deploy_attempts
  `);

  const row = result.rows[0];
  return Boolean(
    row?.gitlab_deploy_jobs &&
    row?.gitlab_deploy_attempts
  );
}

function toTextId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function getJobCompletedAt(job: GitLabDeployJob): Date | null {
  const value = job.finished_at || job.created_at || null;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getJobStartedAt(job: GitLabDeployJob): Date | null {
  const value = job.started_at || null;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getJobCreatedAt(job: GitLabDeployJob): Date | null {
  const value = job.created_at || null;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function upsertProjectService(project: GitLabProject, team: string) {
  const serviceKey = `gitlab-${project.id}-${slugify(project.path_with_namespace || project.name || String(project.id))}`.slice(0, 120);
  const result = await pool.query<{ id: number }>(
    `
      INSERT INTO services (
        service_key,
        service_name,
        team,
        gitlab_project_id,
        gitlab_project_path,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (service_key) DO UPDATE SET
        service_name = EXCLUDED.service_name,
        team = COALESCE(EXCLUDED.team, services.team),
        gitlab_project_id = COALESCE(EXCLUDED.gitlab_project_id, services.gitlab_project_id),
        gitlab_project_path = COALESCE(EXCLUDED.gitlab_project_path, services.gitlab_project_path),
        updated_at = NOW()
      RETURNING id
    `,
    [
      serviceKey,
      project.name,
      team,
      project.id,
      project.path_with_namespace,
    ]
  );

  return result.rows[0].id;
}

async function upsertGitLabDeployJob(
  serviceId: number | null,
  project: GitLabProject,
  team: string,
  job: GitLabDeployJob
) {
  const jobId = toTextId(job.id) || `unknown-${project.id}`;
  await pool.query(
    `
      INSERT INTO gitlab_deploy_jobs (
        service_id,
        project_id,
        project_name,
        team,
        pipeline_id,
        job_id,
        job_name,
        stage_name,
        status,
        ref,
        environment,
        commit_sha,
        commit_created_at,
        commit_author_email,
        job_created_at,
        job_started_at,
        job_finished_at,
        job_web_url,
        metadata,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
      ON CONFLICT (project_id, job_id) DO UPDATE SET
        service_id = COALESCE(EXCLUDED.service_id, gitlab_deploy_jobs.service_id),
        project_name = EXCLUDED.project_name,
        team = COALESCE(EXCLUDED.team, gitlab_deploy_jobs.team),
        pipeline_id = EXCLUDED.pipeline_id,
        job_name = EXCLUDED.job_name,
        stage_name = EXCLUDED.stage_name,
        status = EXCLUDED.status,
        ref = EXCLUDED.ref,
        environment = EXCLUDED.environment,
        commit_sha = EXCLUDED.commit_sha,
        commit_created_at = EXCLUDED.commit_created_at,
        commit_author_email = EXCLUDED.commit_author_email,
        job_created_at = EXCLUDED.job_created_at,
        job_started_at = EXCLUDED.job_started_at,
        job_finished_at = EXCLUDED.job_finished_at,
        job_web_url = EXCLUDED.job_web_url,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `,
    [
      serviceId,
      project.id,
      project.name,
      team,
      toTextId(job.pipeline?.id),
      jobId,
      job.name || null,
      job.stage || null,
      job.status || "unknown",
      job.ref || null,
      job.environment?.name?.toLowerCase?.() || null,
      job.commit?.id || null,
      job.commit?.created_at ? new Date(job.commit.created_at) : null,
      job.commit?.author_email || null,
      getJobCreatedAt(job),
      getJobStartedAt(job),
      getJobCompletedAt(job),
      job.web_url || null,
      JSON.stringify({
        allowFailure: Boolean(job.allow_failure),
        retried: Boolean(job.retried),
      }),
    ]
  );
}

async function upsertGitLabDeployAttempt(
  serviceId: number | null,
  productionDeploymentId: number | null,
  project: GitLabProject,
  team: string,
  job: GitLabDeployJob
) {
  const jobId = toTextId(job.id) || `unknown-${project.id}`;
  const externalId = `${project.id}:${jobId}`;
  await pool.query(
    `
      INSERT INTO gitlab_deploy_attempts (
        external_id,
        source,
        service_id,
        production_deployment_id,
        project_id,
        project_name,
        team,
        environment,
        status,
        ref,
        commit_sha,
        commit_created_at,
        commit_author_email,
        pipeline_id,
        job_id,
        job_name,
        stage_name,
        deploy_started_at,
        deploy_completed_at,
        metadata,
        updated_at
      )
      VALUES ($1,'gitlab_job',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
      ON CONFLICT (external_id) DO UPDATE SET
        service_id = COALESCE(EXCLUDED.service_id, gitlab_deploy_attempts.service_id),
        production_deployment_id = COALESCE(EXCLUDED.production_deployment_id, gitlab_deploy_attempts.production_deployment_id),
        project_name = EXCLUDED.project_name,
        team = COALESCE(EXCLUDED.team, gitlab_deploy_attempts.team),
        environment = EXCLUDED.environment,
        status = EXCLUDED.status,
        ref = EXCLUDED.ref,
        commit_sha = EXCLUDED.commit_sha,
        commit_created_at = EXCLUDED.commit_created_at,
        commit_author_email = EXCLUDED.commit_author_email,
        pipeline_id = EXCLUDED.pipeline_id,
        job_id = EXCLUDED.job_id,
        job_name = EXCLUDED.job_name,
        stage_name = EXCLUDED.stage_name,
        deploy_started_at = EXCLUDED.deploy_started_at,
        deploy_completed_at = EXCLUDED.deploy_completed_at,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `,
    [
      externalId,
      serviceId,
      productionDeploymentId,
      project.id,
      project.name,
      team,
      job.environment?.name?.toLowerCase?.() || "production",
      job.status || "unknown",
      job.ref || null,
      job.commit?.id || null,
      job.commit?.created_at ? new Date(job.commit.created_at) : null,
      job.commit?.author_email || null,
      toTextId(job.pipeline?.id),
      jobId,
      job.name || null,
      job.stage || null,
      getJobStartedAt(job),
      getJobCompletedAt(job),
      JSON.stringify({
        allowFailure: Boolean(job.allow_failure),
        retried: Boolean(job.retried),
        webUrl: job.web_url || null,
      }),
    ]
  );
}

async function upsertProductionDeployment(
  serviceId: number,
  project: GitLabProject,
  team: string,
  trace: DeploymentTrace,
  deployJob: GitLabDeployJob | null
) {
  const externalId = `${project.id}:${trace.deploy_id}`;
  const result = await pool.query<{ id: number }>(
    `
      INSERT INTO production_deployments (
        external_id,
        source,
        service_id,
        project_id,
        project_name,
        team,
        environment,
        status,
        commit_sha,
        deploy_type,
        deploy_type_reason,
        gitlab_pipeline_id,
        gitlab_job_id,
        gitlab_ref,
        gitlab_stage_name,
        gitlab_job_name,
        deploy_completed_at,
        metadata,
        updated_at
      )
      VALUES ($1, 'gitlab', $2, $3, $4, $5, $6, 'success', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
      ON CONFLICT (source, external_id) DO UPDATE SET
        service_id = COALESCE(EXCLUDED.service_id, production_deployments.service_id),
        project_id = EXCLUDED.project_id,
        project_name = EXCLUDED.project_name,
        team = COALESCE(EXCLUDED.team, production_deployments.team),
        environment = EXCLUDED.environment,
        status = EXCLUDED.status,
        commit_sha = EXCLUDED.commit_sha,
        deploy_type = EXCLUDED.deploy_type,
        deploy_type_reason = EXCLUDED.deploy_type_reason,
        gitlab_pipeline_id = EXCLUDED.gitlab_pipeline_id,
        gitlab_job_id = EXCLUDED.gitlab_job_id,
        gitlab_ref = EXCLUDED.gitlab_ref,
        gitlab_stage_name = EXCLUDED.gitlab_stage_name,
        gitlab_job_name = EXCLUDED.gitlab_job_name,
        deploy_completed_at = EXCLUDED.deploy_completed_at,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING id
    `,
    [
      externalId,
      serviceId,
      project.id,
      project.name,
      team,
      trace.deploy_environment || "production",
      trace.commit_sha,
      trace.deploy_type,
      trace.deploy_type_reason,
      toTextId(deployJob?.pipeline?.id),
      toTextId(deployJob?.id),
      deployJob?.ref || null,
      deployJob?.stage || null,
      deployJob?.name || null,
      trace.deploy_created_at,
      JSON.stringify({
        deployType: trace.deploy_type,
        deployTypeReason: trace.deploy_type_reason,
        changesCount: trace.changes.length,
        pipelineId: toTextId(deployJob?.pipeline?.id),
        jobId: toTextId(deployJob?.id),
        ref: deployJob?.ref || null,
      }),
    ]
  );

  return result.rows[0].id;
}

async function upsertDeploymentChanges(deploymentId: number, changes: DeploymentChange[]) {
  for (const change of changes) {
    await pool.query(
      `
        INSERT INTO deployment_changes (
          deployment_id,
          commit_sha,
          commit_created_at,
          mr_id,
          mr_iid,
          mr_created_at,
          mr_first_commit_at,
          mr_merged_at,
          author_email,
          created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
        ON CONFLICT (deployment_id, commit_sha) DO UPDATE SET
          commit_created_at = EXCLUDED.commit_created_at,
          mr_id = COALESCE(EXCLUDED.mr_id, deployment_changes.mr_id),
          mr_iid = COALESCE(EXCLUDED.mr_iid, deployment_changes.mr_iid),
          mr_created_at = COALESCE(EXCLUDED.mr_created_at, deployment_changes.mr_created_at),
          mr_first_commit_at = COALESCE(EXCLUDED.mr_first_commit_at, deployment_changes.mr_first_commit_at),
          mr_merged_at = COALESCE(EXCLUDED.mr_merged_at, deployment_changes.mr_merged_at),
          author_email = COALESCE(EXCLUDED.author_email, deployment_changes.author_email)
      `,
      [
        deploymentId,
        change.commit_sha,
        change.commit_created_at,
        change.mr_id,
        change.mr_iid,
        change.mr_created_at,
        change.mr_first_commit_at,
        change.mr_merged_at,
        change.author_email,
      ]
    );
  }
}

function classifyDeployType(
  sourceBranch: string | null,
  labels: string[],
  commitSha: string | null,
  previousCommitSha: string | null,
  deployedCommitHistory: Set<string>,
  commitMessage?: string | null
): { type: "feature" | "hotfix" | "rollback"; reason: string } {
  const normalizedBranch = sourceBranch?.toLowerCase() || "";
  const normalizedLabels = labels.map((label) => label.toLowerCase());

  // 1. Rollback detection — branch prefix
  if (ROLLBACK_BRANCH_PREFIXES.some((prefix) => normalizedBranch.startsWith(prefix))) {
    return { type: "rollback", reason: `branch:${normalizedBranch}` };
  }

  // 2. Rollback detection — labels
  const rollbackLabel = normalizedLabels.find((label) => ROLLBACK_LABELS.includes(label));
  if (rollbackLabel) {
    return { type: "rollback", reason: `label:${rollbackLabel}` };
  }

  // 3. Rollback detection — commit history (redeploy of old commit)
  if (commitSha && previousCommitSha && commitSha !== previousCommitSha && deployedCommitHistory.has(commitSha)) {
    return { type: "rollback", reason: `commit-history:${commitSha}` };
  }

  // 4. Rollback detection — commit message (revert: prefix per conventional commits)
  if (commitMessage) {
    const normalizedMsg = commitMessage.toLowerCase().trim();
    // Match conventional commit format: [TICKET] revert: ... or just revert: ...
    if (/^(\[[^\]]+\]\s*)?revert[!]?:/.test(normalizedMsg)) {
      return { type: "rollback", reason: `commit-msg:revert` };
    }
  }

  // 5. Hotfix detection — branch prefix (supports standard: hotfix/<ticket> and fix/<ticket>)
  if (HOTFIX_BRANCH_PREFIXES.some((prefix) => normalizedBranch.startsWith(prefix))) {
    return { type: "hotfix", reason: `branch:${normalizedBranch}` };
  }
  // Also detect fix/ branches from the branch naming standard
  if (normalizedBranch.startsWith("fix/")) {
    return { type: "hotfix", reason: `branch:${normalizedBranch}` };
  }

  // 6. Hotfix detection — labels
  const hotfixLabel = normalizedLabels.find((label) => HOTFIX_LABELS.includes(label));
  if (hotfixLabel) {
    return { type: "hotfix", reason: `label:${hotfixLabel}` };
  }

  // 7. Hotfix detection — commit message (fix: or hotfix: per conventional commits)
  if (commitMessage) {
    const normalizedMsg = commitMessage.toLowerCase().trim();
    // Match: [TICKET] fix: ... or [TICKET] hotfix: ... or just fix: ... or hotfix: ...
    if (/^(\[[^\]]+\]\s*)?(fix|hotfix)[!]?:/.test(normalizedMsg)) {
      return { type: "hotfix", reason: `commit-msg:fix` };
    }
  }

  return { type: "feature", reason: "default" };
}

export async function generateDoraSnapshot(date: string) {
  try {
    console.log(`Starting DORA metrics snapshot generation for ${date}...`);

    const snapshotDate = date;
    const windowStart = toUtcDayStart(snapshotDate);
    const windowEnd = addDays(windowStart, 1);
    const windowStartIso = windowStart.toISOString();
    const windowEndIso = windowEnd.toISOString();
    const traceabilityReady = await isProductionTraceabilityReady().catch((error) => {
      console.error("Error checking production traceability schema:", error);
      return false;
    });
    const canonicalGitLabReady = await isCanonicalGitLabDeployReady().catch((error) => {
      console.error("Error checking canonical GitLab deployment schema:", error);
      return false;
    });

    const allProjects: typeof projects = [];
    for (const groupId of SNAPSHOT_GROUP_IDS) {
      const groupProjects = await gitlabClient.getProjects(groupId);
      console.log(`Fetched ${groupProjects.length} projects from group ${groupId}`);
      allProjects.push(...groupProjects);
    }
    // Deduplicate by project ID (a project could appear in multiple groups)
    const projectMap = new Map(allProjects.map((p) => [p.id, p]));
    const projects = [...projectMap.values()];
    console.log(`Found ${projects.length} unique projects across ${SNAPSHOT_GROUP_IDS.length} group(s)`);

    // Load developer name map for canonical name resolution
    const nameMap = new Map<string, string>();
    try {
      const nameMapResult = await pool.query<{ gitlab_username: string; canonical_name: string }>(
        `SELECT gitlab_username, canonical_name FROM developer_name_map`
      );
      for (const row of nameMapResult.rows) {
        nameMap.set(row.gitlab_username, row.canonical_name);
      }
      console.log(`Loaded ${nameMap.size} entries from developer_name_map`);
    } catch {
      console.warn("developer_name_map not available — using raw names");
    }

    const resolveNameFromMap = (rawName: string, email: string): string => {
      // Try matching by email local part (e.g. "borja.torres" from "borja.torres@iskaypet.com")
      const local = email.split("@")[0];
      if (local && nameMap.has(local)) return nameMap.get(local)!;
      return rawName;
    };

    let processedProjects = 0;
    const errors: string[] = [];

    for (const project of projects) {
      try {
        const pathParts = project.path_with_namespace.split("/");
        const team = pathParts.length >= 3 ? pathParts[2] : pathParts[1] || pathParts[0];
        const targetEnvNames = PROD_ENVIRONMENTS.map((env) => env.toLowerCase());

        const failureWindowMs = FAILURE_WINDOW_HOURS * 60 * 60 * 1000;
        const deploymentsSince = new Date(windowStart.getTime() - failureWindowMs);
        const mttrLookbackDays = Number.isFinite(MTTR_LOOKBACK_DAYS) && MTTR_LOOKBACK_DAYS > 0 ? MTTR_LOOKBACK_DAYS : 14;
        const mttrSince = subDays(windowStart, mttrLookbackDays);
        const deployJobsSince = mttrSince < deploymentsSince ? mttrSince : deploymentsSince;

        const deployments = await safeFetch(
          `deployments for ${project.name}`,
          () => gitlabClient.getDeployments(project.id, deploymentsSince),
          []
        );

        const deploymentEventsFromApi: DeploymentEvent[] = [];
        for (const deployment of deployments) {
          const envName = deployment.environment?.name?.toLowerCase() || "";
          // Exclude non-production environments first (e.g. "product-dev" contains "prod" but is dev)
          if (NON_PROD_KEYWORDS.some((kw) => envName.includes(kw))) continue;
          if (!targetEnvNames.some((target) => envName.includes(target)) && !envName.endsWith("-pro")) continue;
          if (deployment.status && deployment.status !== "success") continue;

          deploymentEventsFromApi.push({
            id: deployment.id,
            created_at: deployment.finished_at || deployment.created_at,
            commit_sha: deployment.deployable?.commit?.id || null,
            commit_created_at: deployment.deployable?.commit?.created_at || null,
            environment: envName,
          });
        }

        const deployJobsAll = await safeFetch(
          `deploy jobs for ${project.name}`,
          () => gitlabClient.getPipelineJobs(
            project.id,
            deployJobsSince.toISOString(),
            DEPLOY_JOB_NAMES,
            ["success", "failed"],
            { includeRetried: false }
          ),
          []
        );
        const deployJobsById = new Map(
          (deployJobsAll as GitLabDeployJob[])
            .map((job) => [toTextId(job.id), job] as const)
            .filter((entry): entry is [string, GitLabDeployJob] => Boolean(entry[0]))
        );

        const deployJobsInWindow = deployJobsAll.filter((job) => {
          const jobTime = job.finished_at || job.created_at;
          return Boolean(jobTime) && isWithinWindow(new Date(jobTime), windowStart, windowEnd);
        });

        const deployJobsSuccess = deployJobsInWindow.filter((job) => job.status === "success");
        // CFR: Only count failures from jobs targeting production environments
        const deployJobsFailed = deployJobsInWindow.filter((job) => {
          if (job.status !== "failed") return false;
          const jobEnv = (job as GitLabDeployJob).environment?.name?.toLowerCase?.() || "";
          // If job has no environment info, check the ref (branch) — exclude non-prod branches
          if (!jobEnv) {
            const ref = ((job as GitLabDeployJob).ref || "").toLowerCase();
            // If ref is clearly a dev/feature branch, exclude from CFR
            if (ref && !ref.includes("main") && !ref.includes("master") && !ref.includes("prod") && !ref.includes("release")) {
              return false;
            }
            return true; // No env info and ambiguous ref — count it (conservative)
          }
          // Exclude non-production environments
          if (NON_PROD_KEYWORDS.some((kw) => jobEnv.includes(kw))) return false;
          // Must match a production environment pattern
          return PROD_ENVIRONMENTS.some((target) => jobEnv.includes(target)) || jobEnv.endsWith("-pro");
        });

        const deploymentEventsFromJobs = deployJobsSuccess
          .map<DeploymentEvent | null>((job) => {
            const jobTime = job.finished_at || job.created_at;
            if (!jobTime) return null;

            return {
              id: job.id,
              created_at: jobTime,
              commit_sha: job.commit?.id || null,
              commit_created_at: job.commit?.created_at || null,
              commit_author_email: job.commit?.author_email || null,
              environment: job.environment?.name?.toLowerCase?.() || null,
            };
          })
          .filter((event): event is DeploymentEvent => Boolean(event));

        const deploymentEvents = deploymentEventsFromJobs.length > 0
          ? deploymentEventsFromJobs
          : deploymentEventsFromApi.filter((event) => isWithinWindow(new Date(event.created_at), windowStart, windowEnd));

        const latestDeployments = await safeFetch(
          `latest deployments for ${project.name}`,
          () => gitlabClient.getLatestDeployments(project.id, 80),
          []
        );

        const deploymentHistoryFromApi: DeploymentHistoryEntry[] = latestDeployments
          .filter((deployment) => {
            const envName = deployment.environment?.name?.toLowerCase() || "";
            // Exclude non-production environments (e.g. "product-dev")
            if (NON_PROD_KEYWORDS.some((kw) => envName.includes(kw))) return false;
            return Boolean(
              deployment.deployable?.commit?.id &&
              (!deployment.status || deployment.status === "success") &&
              (targetEnvNames.some((target) => envName.includes(target)) || envName.endsWith("-pro"))
            );
          })
          .map((deployment) => ({
            deploy_time: new Date(deployment.finished_at || deployment.created_at),
            commit_sha: deployment.deployable?.commit?.id || "",
          }))
          .filter((entry) => entry.commit_sha && !Number.isNaN(entry.deploy_time.getTime()));

        const deploymentHistoryFromJobs: DeploymentHistoryEntry[] = deployJobsAll
          .filter((job) => job.status === "success" && job.commit?.id)
          .map((job) => ({
            deploy_time: new Date(job.finished_at || job.created_at),
            commit_sha: job.commit?.id || "",
          }))
          .filter((entry) => entry.commit_sha && !Number.isNaN(entry.deploy_time.getTime()));

        const successfulDeploymentHistory = sortAndUniqDeploymentHistory([
          ...deploymentHistoryFromApi,
          ...deploymentHistoryFromJobs,
        ]);

        const mrCommitCache = new Map<number, GitLabCommit[]>();
        const commitMrCache = new Map<string, GitLabMergeRequestForCommit | null>();
        const compareCache = new Map<string, GitLabCommit[]>();
        const commitInfoCache = new Map<string, GitLabCommit | null>();

        const getPrimaryMergeRequest = async (commitSha: string) => {
          if (commitMrCache.has(commitSha)) {
            return commitMrCache.get(commitSha) || null;
          }

          const mrs = await safeFetch(
            `MR for commit ${commitSha}`,
            () => gitlabClient.getMergeRequestsForCommit(project.id, commitSha),
            []
          );
          const primaryMr = mrs[0] || null;
          commitMrCache.set(commitSha, primaryMr);
          return primaryMr;
        };

        const getMergeRequestCommitsCached = async (mrIid: number) => {
          if (mrCommitCache.has(mrIid)) {
            return mrCommitCache.get(mrIid) || [];
          }

          const mrCommits = await safeFetch(
            `commits for MR ${mrIid} in ${project.name}`,
            () => gitlabClient.getMergeRequestCommits(project.id, mrIid),
            []
          );
          const orderedCommits = sortAndUniqCommits(mrCommits);
          mrCommitCache.set(mrIid, orderedCommits);
          return orderedCommits;
        };

        const getCommitInfoCached = async (commitSha: string) => {
          if (commitInfoCache.has(commitSha)) {
            return commitInfoCache.get(commitSha) || null;
          }

          const commitInfo = await safeFetch(
            `commit ${commitSha} in ${project.name}`,
            () => gitlabClient.getCommitInfo(project.id, commitSha),
            null
          );
          commitInfoCache.set(commitSha, commitInfo);
          return commitInfo;
        };

        const getChangeCommitsForDeploy = async (
          currentCommitSha: string,
          previousSuccessfulCommitSha: string | null,
          headMrInfo: GitLabMergeRequestForCommit | null
        ) => {
          if (!currentCommitSha) return [];
          if (previousSuccessfulCommitSha && previousSuccessfulCommitSha === currentCommitSha) {
            return [];
          }

          let changeCommits: GitLabCommit[] = [];

          if (previousSuccessfulCommitSha && previousSuccessfulCommitSha !== currentCommitSha) {
            const cacheKey = `${previousSuccessfulCommitSha}..${currentCommitSha}`;
            if (compareCache.has(cacheKey)) {
              changeCommits = compareCache.get(cacheKey) || [];
            } else {
              const comparedCommits = await safeFetch(
                `compare ${cacheKey} in ${project.name}`,
                () => gitlabClient.getCompareCommits(project.id, previousSuccessfulCommitSha, currentCommitSha),
                []
              );
              changeCommits = sortAndUniqCommits(comparedCommits);
              compareCache.set(cacheKey, changeCommits);
            }
          }

          if (changeCommits.length === 0 && headMrInfo?.iid) {
            changeCommits = await getMergeRequestCommitsCached(headMrInfo.iid);
          }

          if (changeCommits.length === 0) {
            const headCommit = await getCommitInfoCached(currentCommitSha);
            if (headCommit) {
              changeCommits = [headCommit];
            }
          }

          if (!changeCommits.some((commit) => commit.id === currentCommitSha)) {
            const headCommit = await getCommitInfoCached(currentCommitSha);
            if (headCommit) {
              changeCommits = [...changeCommits, headCommit];
            }
          }

          return sortAndUniqCommits(changeCommits);
        };

        const historicalDeployments = successfulDeploymentHistory.filter((deployment) => deployment.deploy_time < windowStart);
        const deployedCommitHistory = new Set(historicalDeployments.map((deployment) => deployment.commit_sha));
        let previousCommitSha = historicalDeployments.length > 0
          ? historicalDeployments[historicalDeployments.length - 1].commit_sha
          : null;

        const deploymentTraces: DeploymentTrace[] = [];
        const uniqueCommits = new Set<string>();
        let leadTimeSumHours = 0;
        let leadTimeCount = 0;
        let leadTimeFirstCommitSumHours = 0;
        let leadTimeFirstCommitCount = 0;
        let leadTimeMrSumHours = 0;
        let leadTimeMrCount = 0;
        let rollbackCount = 0;
        let hotfixCount = 0;
        let featureCount = 0;

        const orderedDeploymentEvents = [...deploymentEvents].sort(
          (left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
        );

        for (const event of orderedDeploymentEvents) {
          const commitSha = event.commit_sha || null;
          const mrInfo = commitSha ? await getPrimaryMergeRequest(commitSha) : null;

          const deployTime = new Date(event.created_at);
          const mrCreatedAt = mrInfo?.created_at ? new Date(mrInfo.created_at) : null;
          let mrFirstCommitAt: Date | null = null;
          let mrLastCommitAt: Date | null = null;
          let mrCommitCount = 0;

          if (mrInfo?.iid) {
            const mrCommits = await getMergeRequestCommitsCached(mrInfo.iid);
            if (mrCommits.length > 0) {
              mrFirstCommitAt = mrCommits[0]?.created_at ? new Date(mrCommits[0].created_at) : null;
              mrLastCommitAt = mrCommits[mrCommits.length - 1]?.created_at
                ? new Date(mrCommits[mrCommits.length - 1].created_at)
                : null;
              mrCommitCount = mrCommits.length;
            }
          }

          const changeCommits = commitSha
            ? await getChangeCommitsForDeploy(commitSha, previousCommitSha, mrInfo)
            : [];
          const deploymentChanges: DeploymentChange[] = [];
          const usableMrCreatedAt = resolveUsableLeadTimeReference(deployTime, mrCreatedAt);
          let earliestChangeCommitAt: Date | null = null;
          let latestChangeCommitAt: Date | null = null;
          let earliestMrCreatedAt: Date | null = usableMrCreatedAt;

          for (const changeCommit of changeCommits) {
            const changeCommitTime = changeCommit.created_at ? new Date(changeCommit.created_at) : null;
            const usableChangeCommitTime = resolveUsableLeadTimeReference(deployTime, changeCommitTime);
            if (usableChangeCommitTime) {
              if (!earliestChangeCommitAt || usableChangeCommitTime < earliestChangeCommitAt) {
                earliestChangeCommitAt = usableChangeCommitTime;
              }
              if (!latestChangeCommitAt || usableChangeCommitTime > latestChangeCommitAt) {
                latestChangeCommitAt = usableChangeCommitTime;
              }
            }

            uniqueCommits.add(changeCommit.id);

            const changeMrInfo = await getPrimaryMergeRequest(changeCommit.id);
            let changeMrFirstCommitAt: Date | null = null;
            if (changeMrInfo?.iid) {
              const changeMrCommits = await getMergeRequestCommitsCached(changeMrInfo.iid);
              if (changeMrCommits.length > 0) {
                changeMrFirstCommitAt = changeMrCommits[0]?.created_at
                  ? new Date(changeMrCommits[0].created_at)
                  : null;
              }
            }

            const changeMrCreatedAt = changeMrInfo?.created_at ? new Date(changeMrInfo.created_at) : null;
            const usableChangeMrCreatedAt = resolveUsableLeadTimeReference(deployTime, changeMrCreatedAt);
            if (usableChangeMrCreatedAt && (!earliestMrCreatedAt || usableChangeMrCreatedAt < earliestMrCreatedAt)) {
              earliestMrCreatedAt = usableChangeMrCreatedAt;
            }

            deploymentChanges.push({
              commit_sha: changeCommit.id,
              commit_created_at: changeCommitTime,
              author_email: changeCommit.author_email || null,
              mr_id: changeMrInfo?.id || null,
              mr_iid: changeMrInfo?.iid || null,
              mr_created_at: changeMrCreatedAt,
              mr_first_commit_at: changeMrFirstCommitAt,
              mr_merged_at: changeMrInfo?.merged_at ? new Date(changeMrInfo.merged_at) : null,
            });
          }

          const deployClassification = classifyDeployType(
            mrInfo?.source_branch || null,
            mrInfo?.labels || [],
            commitSha || null,
            previousCommitSha,
            deployedCommitHistory,
            mrInfo?.title || null
          );
          const deployType = deployClassification.type;

          if (deployType === "rollback") rollbackCount++;
          else if (deployType === "hotfix") hotfixCount++;
          else featureCount++;

          let leadTimeCommitHours: number | null = null;
          let leadTimeMrHours: number | null = null;
          let leadTimeFirstCommitHours: number | null = null;
          const isCommitRedeploy = Boolean(commitSha && previousCommitSha && commitSha === previousCommitSha);
          const fallbackCommitTime = !isCommitRedeploy && event.commit_created_at
            ? new Date(event.commit_created_at)
            : null;
          const effectiveCommitTime = latestChangeCommitAt
            || resolveUsableLeadTimeReference(deployTime, fallbackCommitTime);
          const effectiveFirstCommitAt = earliestChangeCommitAt
            || (!isCommitRedeploy ? resolveUsableLeadTimeReference(deployTime, mrFirstCommitAt) : null);
          const effectiveMrCreatedAt = earliestMrCreatedAt
            || (!isCommitRedeploy ? usableMrCreatedAt : null);

          if (effectiveCommitTime) {
            leadTimeCommitHours = sanitizeLeadTimeHours(
              differenceInMinutes(deployTime, effectiveCommitTime) / 60
            );
            if (leadTimeCommitHours !== null) {
              leadTimeSumHours += leadTimeCommitHours;
              leadTimeCount++;
            }
          }

          if (effectiveMrCreatedAt) {
            leadTimeMrHours = sanitizeLeadTimeHours(
              differenceInMinutes(deployTime, effectiveMrCreatedAt) / 60
            );
            if (leadTimeMrHours !== null) {
              leadTimeMrSumHours += leadTimeMrHours;
              leadTimeMrCount++;
            }
          }

          if (effectiveFirstCommitAt) {
            leadTimeFirstCommitHours = sanitizeLeadTimeHours(
              differenceInMinutes(deployTime, effectiveFirstCommitAt) / 60
            );
            if (leadTimeFirstCommitHours !== null) {
              leadTimeFirstCommitSumHours += leadTimeFirstCommitHours;
              leadTimeFirstCommitCount++;
            }
          }

          if (commitSha) {
            deploymentTraces.push({
              commit_sha: commitSha,
              commit_created_at: effectiveCommitTime,
              commit_author_email: event.commit_author_email || deploymentChanges[deploymentChanges.length - 1]?.author_email || null,
              mr_id: mrInfo?.id || null,
              mr_iid: mrInfo?.iid || null,
              mr_created_at: effectiveMrCreatedAt,
              mr_merged_at: mrInfo?.merged_at ? new Date(mrInfo.merged_at) : null,
              mr_title: mrInfo?.title || null,
              mr_labels: mrInfo?.labels || [],
              mr_source_branch: mrInfo?.source_branch || null,
              mr_first_commit_at: effectiveFirstCommitAt,
              mr_last_commit_at: mrLastCommitAt || latestChangeCommitAt || effectiveCommitTime,
              mr_commit_count: Math.max(mrCommitCount, deploymentChanges.length),
              deploy_id: String(event.id),
              deploy_created_at: deployTime,
              deploy_type: deployType,
              deploy_type_reason: deployClassification.reason,
              deploy_environment: event.environment || null,
              lead_time_commit_hours: leadTimeCommitHours,
              lead_time_mr_hours: leadTimeMrHours,
              lead_time_first_commit_hours: leadTimeFirstCommitHours,
              changes: deploymentChanges,
            });
          }

          if (commitSha) {
            deployedCommitHistory.add(commitSha);
            previousCommitSha = commitSha;
          }
        }

        const deploymentCount = orderedDeploymentEvents.length;
        const deploymentFailures = deployJobsFailed.length;

        const pipelines = await safeFetch(
          `pipelines for ${project.name}`,
          () => gitlabClient.getPipelines(project.id, mttrSince.toISOString(), project.default_branch),
          []
        );

        const pipelineEvents = pipelines
          .filter((pipeline: any) => pipeline.status === "success" || pipeline.status === "failed")
          .map((pipeline: any) => ({
            time: new Date(pipeline.updated_at || pipeline.created_at),
            status: pipeline.status as "success" | "failed",
            scope: "pipeline",
          }));

        const recoveryEvents = [
          ...deployJobsAll
            .filter((job) => job.status === "success" || job.status === "failed")
            .map((job) => ({
              time: new Date(job.finished_at || job.created_at),
              status: job.status as "success" | "failed",
              scope: String(job.name || job.stage || "deploy_prod").toLowerCase(),
            })),
          ...pipelineEvents,
        ]
          .filter((event) => event.time >= mttrSince && event.time < windowEnd)
          .sort((a, b) => {
            const byTime = a.time.getTime() - b.time.getTime();
            if (byTime !== 0) return byTime;
            return a.status === "failed" ? -1 : 1;
          });

        let mttrSumHours = 0;
        let mttrCount = 0;
        const lastFailureByScope = new Map<string, Date>();

        for (const event of recoveryEvents) {
          if (event.status === "failed") {
            lastFailureByScope.set(event.scope, event.time);
            continue;
          }
          const lastFailureAt = lastFailureByScope.get(event.scope) || null;
          if (!lastFailureAt) continue;

          if (isWithinWindow(event.time, windowStart, windowEnd)) {
            const recoveryHours = differenceInMinutes(event.time, lastFailureAt) / 60;
            if (recoveryHours >= 0) {
              mttrSumHours += recoveryHours;
              mttrCount++;
            }
          }
          lastFailureByScope.delete(event.scope);
        }

        const commits = await safeFetch(
          `commits for ${project.name}`,
          () => gitlabClient.getCommits(project.id, windowStartIso, windowEndIso, true),
          []
        );
        const commitMap = new Map<string, any>();
        for (const commit of commits) {
          const commitDate = new Date(commit.created_at);
          if (!isWithinWindow(commitDate, windowStart, windowEnd)) continue;
          if (!commitMap.has(commit.id)) commitMap.set(commit.id, commit);
        }

        const mergedRequests = await safeFetch(
          `merged MRs for ${project.name}`,
          () => gitlabClient.getMergeRequestsMerged(project.id, windowStartIso, windowEndIso),
          []
        );
        const openedRequests = await safeFetch(
          `opened MRs for ${project.name}`,
          () => gitlabClient.getMergeRequestsCreated(project.id, windowStartIso, windowEndIso),
          []
        );

        const mergedInWindow = mergedRequests.filter((mr) => {
          if (!mr.merged_at) return false;
          return isWithinWindow(new Date(mr.merged_at), windowStart, windowEnd);
        });
        const openedInWindow = openedRequests.filter((mr) => isWithinWindow(new Date(mr.created_at), windowStart, windowEnd));

        const devActivity = new Map<string, {
          email: string;
          name: string;
          commits: number;
          linesAdded: number;
          linesRemoved: number;
          mrsOpened: number;
          mrsMerged: number;
          reviewsGiven: number;
          firstCommit?: Date;
          lastCommit?: Date;
        }>();

        for (const commit of commitMap.values()) {
          const email = commit.author_email || "unknown@example.com";
          const commitAuthorName = commit.author_name || email.split("@")[0];
          if (!devActivity.has(email)) {
            devActivity.set(email, {
              email,
              name: commitAuthorName,
              commits: 0,
              linesAdded: 0,
              linesRemoved: 0,
              mrsOpened: 0,
              mrsMerged: 0,
              reviewsGiven: 0,
            });
          }
          const dev = devActivity.get(email)!;
          dev.commits += 1;
          if (commit.stats) {
            dev.linesAdded += commit.stats.additions;
            dev.linesRemoved += commit.stats.deletions;
          }
          const commitDate = new Date(commit.created_at);
          if (!dev.firstCommit || commitDate < dev.firstCommit) dev.firstCommit = commitDate;
          if (!dev.lastCommit || commitDate > dev.lastCommit) dev.lastCommit = commitDate;
        }

        for (const mr of mergedInWindow) {
          if (!mr.author) continue;
          const email = mr.author.email || `${mr.author.username || mr.author.name || "unknown"}@unknown.local`;
          const authorName = mr.author.name || mr.author.username || email.split("@")[0];
          if (!devActivity.has(email)) {
            devActivity.set(email, { email, name: authorName, commits: 0, linesAdded: 0, linesRemoved: 0, mrsOpened: 0, mrsMerged: 0, reviewsGiven: 0 });
          }
          devActivity.get(email)!.mrsMerged += 1;
        }

        for (const mr of openedInWindow) {
          if (!mr.author) continue;
          const email = mr.author.email || `${mr.author.username || mr.author.name || "unknown"}@unknown.local`;
          const authorName = mr.author.name || mr.author.username || email.split("@")[0];
          if (!devActivity.has(email)) {
            devActivity.set(email, { email, name: authorName, commits: 0, linesAdded: 0, linesRemoved: 0, mrsOpened: 0, mrsMerged: 0, reviewsGiven: 0 });
          }
          devActivity.get(email)!.mrsOpened += 1;
        }

        const mergedDevelopers = mergeDevelopersByIdentity(
          [...devActivity.values()].map((activity) => ({
            email: activity.email,
            name: activity.name,
            team,
            projectId: project.id,
            commits: activity.commits,
            linesAdded: activity.linesAdded,
            linesRemoved: activity.linesRemoved,
            mrsOpened: activity.mrsOpened,
            mrsMerged: activity.mrsMerged,
            reviewsGiven: activity.reviewsGiven,
            firstActivity: activity.firstCommit || null,
            lastActivity: activity.lastCommit || null,
          }))
        );
        const activeDevelopers = mergedDevelopers.length;
        const serviceId = traceabilityReady
          ? await upsertProjectService(project, team).catch((error) => {
            console.error(`Error upserting service for ${project.name}:`, error);
            return null;
          })
          : null;

        const hasActivity = deploymentCount > 0 || deploymentFailures > 0 || commitMap.size > 0 || mergedInWindow.length > 0;
        if (!hasActivity) {
          processedProjects++;
          continue;
        }

        if (canonicalGitLabReady) {
          for (const deployJob of deployJobsAll as GitLabDeployJob[]) {
            try {
              await upsertGitLabDeployJob(serviceId, project, team, deployJob);
              await upsertGitLabDeployAttempt(serviceId, null, project, team, deployJob);
            } catch (gitLabDeployError) {
              console.error(`Error saving canonical GitLab deploy record for ${project.name}/${deployJob.id}:`, gitLabDeployError);
            }
          }
        }

        await pool.query(
          `INSERT INTO dora_metrics_daily (
              snapshot_date, team, project_id, project_name, project_path,
              deployment_count, deployment_failures,
              lead_time_sum_hours, lead_time_count,
              lead_time_first_commit_sum_hours, lead_time_first_commit_count,
              lead_time_mr_sum_hours, lead_time_mr_count,
              mttr_sum_hours, mttr_count,
              unique_commits_deployed, rollback_count, hotfix_count, feature_count,
              coverage, bugs, vulnerabilities, code_smells, tech_debt_minutes,
              total_commits, total_mrs, total_reviews, active_devs, data_source
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
          ON CONFLICT (snapshot_date, project_id) DO UPDATE SET
              team = EXCLUDED.team, project_name = EXCLUDED.project_name, project_path = EXCLUDED.project_path,
              deployment_count = EXCLUDED.deployment_count, deployment_failures = EXCLUDED.deployment_failures,
              lead_time_sum_hours = EXCLUDED.lead_time_sum_hours, lead_time_count = EXCLUDED.lead_time_count,
              lead_time_first_commit_sum_hours = EXCLUDED.lead_time_first_commit_sum_hours,
              lead_time_first_commit_count = EXCLUDED.lead_time_first_commit_count,
              lead_time_mr_sum_hours = EXCLUDED.lead_time_mr_sum_hours, lead_time_mr_count = EXCLUDED.lead_time_mr_count,
              mttr_sum_hours = EXCLUDED.mttr_sum_hours, mttr_count = EXCLUDED.mttr_count,
              unique_commits_deployed = EXCLUDED.unique_commits_deployed,
              rollback_count = EXCLUDED.rollback_count, hotfix_count = EXCLUDED.hotfix_count, feature_count = EXCLUDED.feature_count,
              total_commits = EXCLUDED.total_commits, total_mrs = EXCLUDED.total_mrs,
              total_reviews = EXCLUDED.total_reviews, active_devs = EXCLUDED.active_devs,
              data_source = EXCLUDED.data_source, calculated_at = NOW()`,
          [
            snapshotDate, team, project.id, project.name, project.path_with_namespace,
            deploymentCount, deploymentFailures,
            leadTimeSumHours, leadTimeCount,
            leadTimeFirstCommitSumHours, leadTimeFirstCommitCount,
            leadTimeMrSumHours, leadTimeMrCount,
            mttrSumHours, mttrCount,
            uniqueCommits.size, rollbackCount, hotfixCount, featureCount,
            0, 0, 0, 0, 0,
            commitMap.size, mergedInWindow.length, 0, activeDevelopers, "gitlab",
          ]
        );

        for (const trace of deploymentTraces) {
          try {
            await pool.query(
              `INSERT INTO deployment_traces (
                  snapshot_date, project_id, project_name,
                  commit_sha, commit_created_at, commit_author_email,
                  mr_id, mr_iid, mr_created_at, mr_merged_at, mr_title, mr_labels, mr_source_branch,
                  mr_first_commit_at, mr_last_commit_at, mr_commit_count,
                  deploy_id, deploy_created_at, deploy_type, deploy_environment,
                  deploy_type_reason, lead_time_commit_hours, lead_time_mr_hours, lead_time_first_commit_hours
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
              ON CONFLICT (snapshot_date, project_id, deploy_id) DO UPDATE SET
                  commit_sha = EXCLUDED.commit_sha,
                  commit_created_at = EXCLUDED.commit_created_at,
                  commit_author_email = EXCLUDED.commit_author_email,
                  mr_id = EXCLUDED.mr_id,
                  mr_iid = EXCLUDED.mr_iid,
                  mr_created_at = EXCLUDED.mr_created_at,
                  mr_merged_at = EXCLUDED.mr_merged_at,
                  mr_title = EXCLUDED.mr_title,
                  mr_labels = EXCLUDED.mr_labels,
                  mr_source_branch = EXCLUDED.mr_source_branch,
                  mr_first_commit_at = EXCLUDED.mr_first_commit_at,
                  mr_last_commit_at = EXCLUDED.mr_last_commit_at,
                  mr_commit_count = EXCLUDED.mr_commit_count,
                  deploy_created_at = EXCLUDED.deploy_created_at,
                  deploy_type = EXCLUDED.deploy_type,
                  deploy_environment = EXCLUDED.deploy_environment,
                  deploy_type_reason = EXCLUDED.deploy_type_reason,
                  lead_time_commit_hours = EXCLUDED.lead_time_commit_hours,
                  lead_time_mr_hours = EXCLUDED.lead_time_mr_hours,
                  lead_time_first_commit_hours = EXCLUDED.lead_time_first_commit_hours`,
              [
                snapshotDate, project.id, project.name,
                trace.commit_sha, trace.commit_created_at, trace.commit_author_email,
                trace.mr_id, trace.mr_iid, trace.mr_created_at, trace.mr_merged_at,
                trace.mr_title, trace.mr_labels, trace.mr_source_branch,
                trace.mr_first_commit_at, trace.mr_last_commit_at, trace.mr_commit_count,
                trace.deploy_id, trace.deploy_created_at, trace.deploy_type, trace.deploy_environment,
                trace.deploy_type_reason, trace.lead_time_commit_hours, trace.lead_time_mr_hours, trace.lead_time_first_commit_hours,
              ]
            );
          } catch (traceError) {
            console.error(`Error saving deployment trace: ${traceError}`);
          }

          if (traceabilityReady && serviceId) {
            try {
              const deployJob = deployJobsById.get(trace.deploy_id) || null;
              const productionDeploymentId = await upsertProductionDeployment(serviceId, project, team, trace, deployJob);
              await upsertDeploymentChanges(productionDeploymentId, trace.changes);
              if (canonicalGitLabReady && deployJob) {
                await upsertGitLabDeployAttempt(serviceId, productionDeploymentId, project, team, deployJob);
              }
            } catch (productionTraceError) {
              console.error(`Error saving production deployment trace for ${project.name}/${trace.deploy_id}:`, productionTraceError);
            }
          }
        }

        for (const activity of mergedDevelopers) {
          try {
            const resolvedName = resolveNameFromMap(activity.name, activity.email);
            await pool.query(
              `INSERT INTO developer_activity_daily (
                  snapshot_date, developer_email, developer_name, team,
                  project_id, project_name, project_path,
                  commits_count, lines_added, lines_removed,
                  mrs_opened, mrs_merged, reviews_given,
                  first_commit_time, last_commit_time
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
              ON CONFLICT (snapshot_date, developer_email, project_id) DO UPDATE SET
                  developer_name = EXCLUDED.developer_name, team = EXCLUDED.team,
                  project_name = EXCLUDED.project_name, project_path = EXCLUDED.project_path,
                  commits_count = EXCLUDED.commits_count, lines_added = EXCLUDED.lines_added,
                  lines_removed = EXCLUDED.lines_removed, mrs_opened = EXCLUDED.mrs_opened,
                  mrs_merged = EXCLUDED.mrs_merged, reviews_given = EXCLUDED.reviews_given,
                  first_commit_time = EXCLUDED.first_commit_time, last_commit_time = EXCLUDED.last_commit_time,
                  calculated_at = NOW()`,
              [
                snapshotDate, activity.email, resolvedName, team,
                project.id, project.name, project.path_with_namespace,
                activity.commits, activity.linesAdded, activity.linesRemoved,
                activity.mrsOpened, activity.mrsMerged, activity.reviewsGiven,
                activity.firstActivity || null, activity.lastActivity || null,
              ]
            );
          } catch (devError) {
            console.error(`Error saving developer activity for ${activity.email}: ${devError}`);
          }
        }

        processedProjects++;
        console.log(`✓ Processed ${project.name} (${processedProjects}/${projects.length})`);
      } catch (projectError) {
        const errorMsg = `Error processing ${project.name}: ${projectError}`;
        console.error(errorMsg);
        errors.push(errorMsg);
      }
    }

    console.log(`Snapshot complete: ${processedProjects}/${projects.length} projects processed`);

    return {
      success: true,
      projectsProcessed: processedProjects,
      totalProjects: projects.length,
      errors: errors.length > 0 ? errors : undefined,
      date: snapshotDate,
      window: { start: windowStartIso, end: windowEndIso },
      traceability: {
        productionSchemaReady: traceabilityReady,
        canonicalGitLabReady,
      },
    };
  } catch (error) {
    console.error("Snapshot generation error:", error);
    throw error;
  }
}
