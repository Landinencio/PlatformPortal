import pool from "@/lib/db";
import {
  ADR_BRANCH_NAME_REGEX,
  DEFAULT_PRODUCTION_DEPLOY_JOB_PATTERNS,
  DEFAULT_PRODUCTION_ENVIRONMENTS,
} from "@/lib/gitlab-governance";
import {
  gitlabClient,
  type GitLabExpandedCiJob,
  type GitLabProject,
  type GitLabProtectedBranch,
  type GitLabPushRule,
} from "@/lib/gitlab";

const SNAPSHOT_GROUP_IDS = (process.env.DORA_SNAPSHOT_GROUP_IDS || "66347331")
  .split(",").map((id) => parseInt(id.trim(), 10)).filter((id) => id > 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_DEPLOY_WINDOW_DAYS = 90;
const DEFAULT_MAX_LIVE_CAPTURE_AGE_DAYS = 3;
const PRODUCTION_ENVIRONMENT_SET = new Set(DEFAULT_PRODUCTION_ENVIRONMENTS.map((environment) => environment.toLowerCase()));

type SchemaStatusRow = {
  service_compliance_daily: string | null;
};

type ComplianceContextRow = {
  project_id: string | number;
  service_team: string | null;
  deploy_team: string | null;
  production_team: string | null;
  dora_team: string | null;
  service_count: string | number | null;
  runtime_target_count: string | number | null;
  k8s_mapping_count: string | number | null;
  k8s_mapping_confidence: string | number | null;
  last_deploy_job_at: string | null;
  successful_jobs_90d: string | number | null;
  all_job_envs_standard: boolean | null;
  recent_job_envs: string[] | null;
  last_production_deploy_at: string | null;
  successful_deploys_90d: string | number | null;
  traced_deploys_90d: string | number | null;
  all_deploy_envs_standard: boolean | null;
  recent_deploy_envs: string[] | null;
  sonar_project_key: string | null;
  latest_sonar_snapshot: string | null;
  quality_gate_status: string | null;
};

type ComplianceContext = {
  team: string | null;
  serviceCount: number;
  runtimeTargetCount: number;
  k8sMappingCount: number;
  k8sMappingConfidence: number | null;
  lastDeployJobAt: string | null;
  successfulJobs90d: number;
  allJobEnvsStandard: boolean | null;
  recentJobEnvs: string[];
  lastProductionDeployAt: string | null;
  successfulDeploys90d: number;
  tracedDeploys90d: number;
  allDeployEnvsStandard: boolean | null;
  recentDeployEnvs: string[];
  sonarProjectKey: string | null;
  latestSonarSnapshot: string | null;
  qualityGateStatus: string | null;
};

type CiSignals = {
  deployProdDeclared: boolean;
  prodEnvironmentDeclared: boolean;
  declarationSource: "none" | "local" | "expanded";
  environmentSource: "none" | "local" | "expanded";
  includesDetected: boolean;
};

export type ServiceComplianceSnapshotOptions = {
  skipHistoricalLiveCapture?: boolean;
  maxLiveCaptureAgeDays?: number;
};

export async function generateServiceComplianceSnapshot(
  snapshotDate: string,
  options: ServiceComplianceSnapshotOptions = {}
) {
  const skipHistoricalLiveCapture = options.skipHistoricalLiveCapture ?? false;
  const maxLiveCaptureAgeDays = options.maxLiveCaptureAgeDays ?? DEFAULT_MAX_LIVE_CAPTURE_AGE_DAYS;

  if (skipHistoricalLiveCapture && isHistoricalSnapshot(snapshotDate, maxLiveCaptureAgeDays)) {
    return {
      success: true,
      skipped: true,
      date: snapshotDate,
      reason:
        "Compliance skipped for historical replay. This snapshot reflects current repository governance and only runs for recent dates.",
    };
  }

  const schemaStatus = await getSchemaStatus();
  if (!schemaStatus.schemaReady) {
    throw new Error(
      "service_compliance_daily table is not available. Apply migration 2026-03-17_service_compliance_daily.sql."
    );
  }

  console.log(`Starting service compliance snapshot for ${snapshotDate}...`);

  const allProjects: GitLabProject[] = [];
  for (const groupId of SNAPSHOT_GROUP_IDS) {
    const groupProjects = await gitlabClient.getProjects(groupId);
    allProjects.push(...groupProjects);
  }
  // Deduplicate by project ID
  const projectMap = new Map(allProjects.map((p) => [p.id, p]));
  const projects = [...projectMap.values()];
  console.log(`Found ${projects.length} unique projects across ${SNAPSHOT_GROUP_IDS.length} group(s)`);

  const [contextByProjectId] = await Promise.all([
    getComplianceContext(snapshotDate),
  ]);

  let processedProjects = 0;
  const errors: string[] = [];
  const batchSize = 4;

  for (let index = 0; index < projects.length; index += batchSize) {
    const batch = projects.slice(index, index + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (project) => {
        const context = contextByProjectId.get(project.id) || emptyComplianceContext();
        await upsertProjectCompliance(snapshotDate, project, context);
      })
    );

    for (const [batchIndex, result] of results.entries()) {
      if (result.status === "fulfilled") {
        processedProjects += 1;
      } else {
        const project = batch[batchIndex];
        errors.push(`${project.path_with_namespace}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }
  }

  console.log(`Service compliance snapshot complete: ${processedProjects}/${projects.length}`);

  return {
    success: true,
    skipped: false,
    date: snapshotDate,
    projectsProcessed: processedProjects,
    totalProjects: projects.length,
    errors: errors.length > 0 ? errors : undefined,
  };
}

async function upsertProjectCompliance(
  snapshotDate: string,
  project: GitLabProject,
  context: ComplianceContext
) {
  const [pushRule, protectedBranches, ciContent] = await Promise.all([
    gitlabClient.getProjectPushRule(project.id),
    gitlabClient.getProtectedBranches(project.id),
    project.default_branch
      ? gitlabClient.getRepositoryFileRaw(project.id, ".gitlab-ci.yml", project.default_branch)
      : Promise.resolve(null),
  ]);

  const localCiSignals = inspectCiContentWithSource(ciContent, [], "local");
  let ciSignals = localCiSignals;
  let expandedCiEvaluated = false;
  let expandedCiValid = false;
  let expandedCiErrors: string[] = [];

  if (project.default_branch && shouldInspectExpandedCi(ciContent, localCiSignals)) {
    const expandedCi = await gitlabClient.getExpandedCiConfig(project.id, project.default_branch);
    expandedCiEvaluated = Boolean(expandedCi);
    expandedCiValid = Boolean(expandedCi?.valid ?? false);
    expandedCiErrors = normalizeStringArray(expandedCi?.errors ?? []);

    if (expandedCi) {
      const expandedSignals = inspectCiContentWithSource(
        expandedCi.merged_yaml || null,
        expandedCi.jobs || [],
        "expanded"
      );
      ciSignals = mergeCiSignals(localCiSignals, expandedSignals);
    }
  }

  const protectedBranchNames = protectedBranches.map((branch) => branch.name);
  const branchNameRegex = pushRule?.branch_name_regex?.trim() || null;
  const pushRulesConfigured = hasConfiguredPushRule(pushRule);
  const branchRegexOk = branchNameRegex === ADR_BRANCH_NAME_REGEX;
  const defaultBranchProtected = isDefaultBranchProtected(project.default_branch, protectedBranches);
  const deployProdObserved = context.successfulJobs90d > 0 || context.successfulDeploys90d > 0;
  const deployProdStatus = deployProdObserved
    ? "observed"
    : ciSignals.deployProdDeclared
      ? "declared_no_recent_activity"
      : "no_evidence";
  const serviceCatalogLinked = context.serviceCount > 0;
  const runtimeMappingOk = context.runtimeTargetCount > 0 || context.k8sMappingCount > 0;
  const runtimeMappingSources = [
    ...(context.runtimeTargetCount > 0 ? ["service-runtime-target"] : []),
    ...(context.k8sMappingCount > 0 ? ["k8s-workload-mapping"] : []),
  ];
  const sonarLinked = Boolean(context.sonarProjectKey);
  const qualityGateReporting = sonarLinked && Boolean(context.qualityGateStatus);
  const prodEnvironmentStandardOk = deployProdObserved
    ? isObservedProductionEnvironmentStandard(context)
    : ciSignals.prodEnvironmentDeclared;
  const doraTraceabilityReady =
    deployProdObserved && context.successfulDeploys90d > 0 && context.tracedDeploys90d > 0;
  const complianceScore = calculateComplianceScore({
    defaultBranchProtected,
    branchRegexOk,
    deployProdDeclared: ciSignals.deployProdDeclared,
    deployProdObserved,
    prodEnvironmentStandardOk,
    serviceCatalogLinked,
    runtimeMappingOk,
    sonarLinked,
    qualityGateReporting,
    doraTraceabilityReady,
  });

  const metadata = {
    adrBranchRegex: ADR_BRANCH_NAME_REGEX,
    protectedBranches: protectedBranchNames.slice(0, 16),
    ciFilePresent: Boolean(ciContent),
    ciIncludesDetected: ciSignals.includesDetected,
    ciExpandedEvaluated: expandedCiEvaluated,
    ciExpandedValid: expandedCiValid,
    ciExpandedErrors: expandedCiErrors.slice(0, 8),
    deployProdDeclarationSource: ciSignals.declarationSource,
    deployProdStatus,
    prodEnvironmentDeclarationSource: ciSignals.environmentSource,
    deployObservedWindowDays: RECENT_DEPLOY_WINDOW_DAYS,
    recentJobEnvironments: context.recentJobEnvs,
    recentDeployEnvironments: context.recentDeployEnvs,
    runtimeMappingSources,
    latestSonarSnapshot: context.latestSonarSnapshot,
  };

  await pool.query(
    `
      INSERT INTO service_compliance_daily (
        snapshot_date,
        project_id,
        project_name,
        project_path,
        team,
        default_branch,
        default_branch_protected,
        push_rules_configured,
        branch_name_regex,
        branch_regex_ok,
        deploy_prod_declared,
        deploy_prod_observed,
        prod_environment_standard_ok,
        service_catalog_linked,
        runtime_mapping_ok,
        runtime_mapping_sources,
        k8s_mapping_count,
        k8s_mapping_confidence,
        sonar_linked,
        sonar_project_key,
        quality_gate_reporting,
        latest_quality_gate_status,
        last_deploy_job_at,
        last_production_deploy_at,
        successful_deploys_90d,
        traced_deploys_90d,
        dora_traceability_ready,
        compliance_score,
        metadata,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27, $28, $29, NOW()
      )
      ON CONFLICT (snapshot_date, project_id) DO UPDATE SET
        project_name = EXCLUDED.project_name,
        project_path = EXCLUDED.project_path,
        team = EXCLUDED.team,
        default_branch = EXCLUDED.default_branch,
        default_branch_protected = EXCLUDED.default_branch_protected,
        push_rules_configured = EXCLUDED.push_rules_configured,
        branch_name_regex = EXCLUDED.branch_name_regex,
        branch_regex_ok = EXCLUDED.branch_regex_ok,
        deploy_prod_declared = EXCLUDED.deploy_prod_declared,
        deploy_prod_observed = EXCLUDED.deploy_prod_observed,
        prod_environment_standard_ok = EXCLUDED.prod_environment_standard_ok,
        service_catalog_linked = EXCLUDED.service_catalog_linked,
        runtime_mapping_ok = EXCLUDED.runtime_mapping_ok,
        runtime_mapping_sources = EXCLUDED.runtime_mapping_sources,
        k8s_mapping_count = EXCLUDED.k8s_mapping_count,
        k8s_mapping_confidence = EXCLUDED.k8s_mapping_confidence,
        sonar_linked = EXCLUDED.sonar_linked,
        sonar_project_key = EXCLUDED.sonar_project_key,
        quality_gate_reporting = EXCLUDED.quality_gate_reporting,
        latest_quality_gate_status = EXCLUDED.latest_quality_gate_status,
        last_deploy_job_at = EXCLUDED.last_deploy_job_at,
        last_production_deploy_at = EXCLUDED.last_production_deploy_at,
        successful_deploys_90d = EXCLUDED.successful_deploys_90d,
        traced_deploys_90d = EXCLUDED.traced_deploys_90d,
        dora_traceability_ready = EXCLUDED.dora_traceability_ready,
        compliance_score = EXCLUDED.compliance_score,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `,
    [
      snapshotDate,
      project.id,
      project.name,
      project.path_with_namespace,
      context.team,
      project.default_branch || null,
      defaultBranchProtected,
      pushRulesConfigured,
      branchNameRegex,
      branchRegexOk,
      ciSignals.deployProdDeclared,
      deployProdObserved,
      prodEnvironmentStandardOk,
      serviceCatalogLinked,
      runtimeMappingOk,
      runtimeMappingSources,
      context.k8sMappingCount,
      context.k8sMappingConfidence,
      sonarLinked,
      context.sonarProjectKey,
      qualityGateReporting,
      context.qualityGateStatus,
      context.lastDeployJobAt,
      context.lastProductionDeployAt,
      context.successfulDeploys90d,
      context.tracedDeploys90d,
      doraTraceabilityReady,
      complianceScore,
      metadata,
    ]
  );
}

async function getSchemaStatus() {
  const result = await pool.query<SchemaStatusRow>(`
    SELECT
      to_regclass('public.service_compliance_daily')::text AS service_compliance_daily
  `);

  return {
    schemaReady: Boolean(result.rows[0]?.service_compliance_daily),
  };
}

async function getComplianceContext(snapshotDate: string) {
  const recentWindowStart = new Date(`${snapshotDate}T00:00:00.000Z`);
  recentWindowStart.setUTCDate(recentWindowStart.getUTCDate() - (RECENT_DEPLOY_WINDOW_DAYS - 1));
  const recentWindowEnd = new Date(`${snapshotDate}T00:00:00.000Z`);
  recentWindowEnd.setUTCDate(recentWindowEnd.getUTCDate() + 1);

  const result = await pool.query<ComplianceContextRow>(
    `
      WITH project_ids AS (
        SELECT gitlab_project_id AS project_id
        FROM services
        WHERE gitlab_project_id IS NOT NULL
        UNION
        SELECT project_id FROM k8s_workload_mapping
        UNION
        SELECT project_id FROM gitlab_deploy_jobs
        UNION
        SELECT project_id
        FROM production_deployments
        WHERE project_id IS NOT NULL
        UNION
        SELECT project_id
        FROM dora_metrics_daily
        WHERE project_id IS NOT NULL
        UNION
        SELECT gitlab_project_id AS project_id
        FROM project_sonar_mapping
        UNION
        SELECT gitlab_project_id AS project_id
        FROM sonarqube_metrics_daily
        WHERE gitlab_project_id IS NOT NULL
      ),
      service_scope AS (
        SELECT
          gitlab_project_id AS project_id,
          MAX(team) AS service_team,
          COUNT(*) AS service_count
        FROM services
        WHERE gitlab_project_id IS NOT NULL
        GROUP BY gitlab_project_id
      ),
      runtime_targets AS (
        SELECT
          s.gitlab_project_id AS project_id,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(srt.environment, 'production')) = ANY($2)
          ) AS runtime_target_count
        FROM services s
        LEFT JOIN service_runtime_targets srt
          ON srt.service_id = s.id
        WHERE s.gitlab_project_id IS NOT NULL
        GROUP BY s.gitlab_project_id
      ),
      k8s_map AS (
        SELECT
          project_id,
          COUNT(*) AS k8s_mapping_count,
          AVG(confidence) AS k8s_mapping_confidence
        FROM k8s_workload_mapping
        GROUP BY project_id
      ),
      deploy_jobs AS (
        SELECT
          project_id,
          MAX(job_finished_at) AS last_deploy_job_at,
          COUNT(*) FILTER (
            WHERE status = 'success'
              AND job_finished_at >= $3
              AND job_finished_at < $4
          ) AS successful_jobs_90d,
          BOOL_AND(LOWER(COALESCE(environment, 'production')) = ANY($2)) FILTER (
            WHERE status = 'success'
              AND job_finished_at >= $3
              AND job_finished_at < $4
          ) AS all_job_envs_standard,
          ARRAY_REMOVE(
            ARRAY_AGG(DISTINCT LOWER(environment)) FILTER (
              WHERE status = 'success'
                AND job_finished_at >= $3
                AND job_finished_at < $4
                AND environment IS NOT NULL
            ),
            NULL
          ) AS recent_job_envs,
          MAX(team) FILTER (WHERE team IS NOT NULL) AS deploy_team
        FROM gitlab_deploy_jobs
        GROUP BY project_id
      ),
      traced_deployments AS (
        SELECT DISTINCT deployment_id
        FROM deployment_changes
      ),
      prod_deploys AS (
        SELECT
          pd.project_id,
          MAX(pd.deploy_completed_at) AS last_production_deploy_at,
          COUNT(*) FILTER (
            WHERE pd.deploy_completed_at >= $3
              AND pd.deploy_completed_at < $4
          ) AS successful_deploys_90d,
          COUNT(*) FILTER (
            WHERE pd.deploy_completed_at >= $3
              AND pd.deploy_completed_at < $4
              AND td.deployment_id IS NOT NULL
          ) AS traced_deploys_90d,
          BOOL_AND(LOWER(COALESCE(pd.environment, 'production')) = ANY($2)) FILTER (
            WHERE pd.deploy_completed_at >= $3
              AND pd.deploy_completed_at < $4
          ) AS all_deploy_envs_standard,
          ARRAY_REMOVE(
            ARRAY_AGG(DISTINCT LOWER(pd.environment)) FILTER (
              WHERE pd.deploy_completed_at >= $3
                AND pd.deploy_completed_at < $4
                AND pd.environment IS NOT NULL
            ),
            NULL
          ) AS recent_deploy_envs,
          MAX(pd.team) FILTER (WHERE pd.team IS NOT NULL) AS production_team
        FROM production_deployments pd
        LEFT JOIN traced_deployments td
          ON td.deployment_id = pd.id
        WHERE pd.source = 'gitlab'
          AND pd.status = 'success'
        GROUP BY pd.project_id
      ),
      latest_dora AS (
        SELECT DISTINCT ON (project_id)
          project_id,
          team AS dora_team
        FROM dora_metrics_daily
        WHERE snapshot_date <= $1
          AND project_id IS NOT NULL
        ORDER BY project_id, snapshot_date DESC
      ),
      sonar_union AS (
        SELECT
          psm.gitlab_project_id AS project_id,
          psm.sonar_project_key,
          sm.snapshot_date,
          sm.quality_gate_status
        FROM project_sonar_mapping psm
        LEFT JOIN LATERAL (
          SELECT snapshot_date, quality_gate_status
          FROM sonarqube_metrics_daily
          WHERE sonar_project_key = psm.sonar_project_key
            AND snapshot_date <= $1
          ORDER BY snapshot_date DESC
          LIMIT 1
        ) sm ON TRUE
        UNION ALL
        SELECT
          sm.gitlab_project_id AS project_id,
          sm.sonar_project_key,
          sm.snapshot_date,
          sm.quality_gate_status
        FROM sonarqube_metrics_daily sm
        WHERE sm.gitlab_project_id IS NOT NULL
          AND sm.snapshot_date <= $1
      ),
      latest_sonar AS (
        SELECT DISTINCT ON (project_id)
          project_id,
          sonar_project_key,
          snapshot_date AS latest_sonar_snapshot,
          quality_gate_status
        FROM sonar_union
        WHERE project_id IS NOT NULL
        ORDER BY project_id, latest_sonar_snapshot DESC NULLS LAST
      )
      SELECT
        p.project_id,
        ss.service_team,
        dj.deploy_team,
        pd.production_team,
        ld.dora_team,
        ss.service_count,
        rt.runtime_target_count,
        km.k8s_mapping_count,
        km.k8s_mapping_confidence,
        dj.last_deploy_job_at,
        dj.successful_jobs_90d,
        dj.all_job_envs_standard,
        dj.recent_job_envs,
        pd.last_production_deploy_at,
        pd.successful_deploys_90d,
        pd.traced_deploys_90d,
        pd.all_deploy_envs_standard,
        pd.recent_deploy_envs,
        ls.sonar_project_key,
        ls.latest_sonar_snapshot,
        ls.quality_gate_status
      FROM project_ids p
      LEFT JOIN service_scope ss
        ON ss.project_id = p.project_id
      LEFT JOIN runtime_targets rt
        ON rt.project_id = p.project_id
      LEFT JOIN k8s_map km
        ON km.project_id = p.project_id
      LEFT JOIN deploy_jobs dj
        ON dj.project_id = p.project_id
      LEFT JOIN prod_deploys pd
        ON pd.project_id = p.project_id
      LEFT JOIN latest_dora ld
        ON ld.project_id = p.project_id
      LEFT JOIN latest_sonar ls
        ON ls.project_id = p.project_id
    `,
    [
      snapshotDate,
      DEFAULT_PRODUCTION_ENVIRONMENTS.map((environment) => environment.toLowerCase()),
      recentWindowStart.toISOString(),
      recentWindowEnd.toISOString(),
    ]
  );

  const entries: Array<[number, ComplianceContext]> = [];

  for (const row of result.rows) {
    const projectId = toNumber(row.project_id);
    if (projectId <= 0) continue;

    entries.push([
      projectId,
      {
        team: row.service_team || row.production_team || row.deploy_team || row.dora_team || null,
        serviceCount: toNumber(row.service_count),
        runtimeTargetCount: toNumber(row.runtime_target_count),
        k8sMappingCount: toNumber(row.k8s_mapping_count),
        k8sMappingConfidence: nullableNumber(row.k8s_mapping_confidence),
        lastDeployJobAt: row.last_deploy_job_at,
        successfulJobs90d: toNumber(row.successful_jobs_90d),
        allJobEnvsStandard: row.all_job_envs_standard,
        recentJobEnvs: normalizeStringArray(row.recent_job_envs),
        lastProductionDeployAt: row.last_production_deploy_at,
        successfulDeploys90d: toNumber(row.successful_deploys_90d),
        tracedDeploys90d: toNumber(row.traced_deploys_90d),
        allDeployEnvsStandard: row.all_deploy_envs_standard,
        recentDeployEnvs: normalizeStringArray(row.recent_deploy_envs),
        sonarProjectKey: row.sonar_project_key,
        latestSonarSnapshot: row.latest_sonar_snapshot,
        qualityGateStatus: row.quality_gate_status,
      },
    ]);
  }

  return new Map<number, ComplianceContext>(entries);
}

function inspectCiContentWithSource(
  content: string | null,
  jobs: GitLabExpandedCiJob[],
  source: "local" | "expanded"
): CiSignals {
  const normalizedContent = content || "";
  const includesDetected = /(^|\r?\n)\s*include\s*:/mi.test(normalizedContent);
  const deployProdDeclaredInYaml = DEFAULT_PRODUCTION_DEPLOY_JOB_PATTERNS.some((pattern) =>
    new RegExp(`(^|\\s)${escapeForRegex(pattern)}\\s*:`, "mi").test(normalizedContent)
    || new RegExp(`stage\\s*:\\s*${escapeForRegex(pattern)}`, "mi").test(normalizedContent)
  );
  const deployProdDeclaredInJobs = jobs.some((job) =>
    DEFAULT_PRODUCTION_DEPLOY_JOB_PATTERNS.some((pattern) => {
      const jobName = String(job.name || "").toLowerCase();
      const stageName = String(job.stage || "").toLowerCase();
      return jobName.includes(pattern) || stageName.includes(pattern);
    })
  );
  const deployProdDeclared = deployProdDeclaredInYaml || deployProdDeclaredInJobs;
  const prodEnvironmentDeclared =
    /environment\s*:\s*(?:\r?\n\s*name\s*:\s*)?["']?(production|prod)["']?/i.test(normalizedContent);

  return {
    deployProdDeclared,
    prodEnvironmentDeclared,
    declarationSource: deployProdDeclared ? source : "none",
    environmentSource: prodEnvironmentDeclared ? source : "none",
    includesDetected,
  };
}

function shouldInspectExpandedCi(content: string | null, localSignals: CiSignals) {
  if (!content) return false;
  if (!localSignals.includesDetected) return false;
  return !localSignals.deployProdDeclared || !localSignals.prodEnvironmentDeclared;
}

function mergeCiSignals(localSignals: CiSignals, expandedSignals: CiSignals): CiSignals {
  return {
    deployProdDeclared: localSignals.deployProdDeclared || expandedSignals.deployProdDeclared,
    prodEnvironmentDeclared: localSignals.prodEnvironmentDeclared || expandedSignals.prodEnvironmentDeclared,
    declarationSource: localSignals.deployProdDeclared
      ? localSignals.declarationSource
      : expandedSignals.deployProdDeclared
        ? expandedSignals.declarationSource
        : "none",
    environmentSource: localSignals.prodEnvironmentDeclared
      ? localSignals.environmentSource
      : expandedSignals.prodEnvironmentDeclared
        ? expandedSignals.environmentSource
        : "none",
    includesDetected: localSignals.includesDetected || expandedSignals.includesDetected,
  };
}

function hasConfiguredPushRule(pushRule: GitLabPushRule | null) {
  if (!pushRule) return false;
  return Object.values(pushRule).some((value) => value !== null && value !== undefined && String(value).trim() !== "");
}

function isDefaultBranchProtected(defaultBranch: string | null | undefined, protectedBranches: GitLabProtectedBranch[]) {
  const target = normalize(defaultBranch);
  if (!target) return false;

  return protectedBranches.some((branch) => wildcardMatches(target, normalize(branch.name)));
}

function wildcardMatches(target: string, pattern: string) {
  if (!pattern) return false;
  if (pattern === target) return true;
  if (!pattern.includes("*")) return false;

  const regex = new RegExp(`^${pattern.split("*").map(escapeForRegex).join(".*")}$`);
  return regex.test(target);
}

function isObservedProductionEnvironmentStandard(context: ComplianceContext) {
  const observedEnvs = [...context.recentJobEnvs, ...context.recentDeployEnvs];
  if (observedEnvs.length === 0) {
    return Boolean(context.allJobEnvsStandard ?? context.allDeployEnvsStandard);
  }

  return observedEnvs.every((environment) =>
    PRODUCTION_ENVIRONMENT_SET.has(environment)
  );
}

function calculateComplianceScore(flags: Record<string, boolean>) {
  const values = Object.values(flags);
  if (values.length === 0) return 0;

  const passed = values.filter(Boolean).length;
  return Number(((passed / values.length) * 100).toFixed(2));
}

function isHistoricalSnapshot(snapshotDate: string, maxAgeDays: number) {
  const snapshotAnchor = new Date(`${snapshotDate}T00:00:00.000Z`);
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const snapshotUtc = Date.UTC(
    snapshotAnchor.getUTCFullYear(),
    snapshotAnchor.getUTCMonth(),
    snapshotAnchor.getUTCDate()
  );

  return (todayUtc - snapshotUtc) / DAY_MS > maxAgeDays;
}

function emptyComplianceContext(): ComplianceContext {
  return {
    team: null,
    serviceCount: 0,
    runtimeTargetCount: 0,
    k8sMappingCount: 0,
    k8sMappingConfidence: null,
    lastDeployJobAt: null,
    successfulJobs90d: 0,
    allJobEnvsStandard: null,
    recentJobEnvs: [],
    lastProductionDeployAt: null,
    successfulDeploys90d: 0,
    tracedDeploys90d: 0,
    allDeployEnvsStandard: null,
    recentDeployEnvs: [],
    sonarProjectKey: null,
    latestSonarSnapshot: null,
    qualityGateStatus: null,
  };
}

function normalize(value: string | null | undefined) {
  return (value || "").trim().toLowerCase();
}

function normalizeStringArray(values: string[] | null | undefined) {
  if (!values) return [];
  return values
    .map((value) => normalize(value))
    .filter(Boolean);
}

function escapeForRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toNumber(value: unknown) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
