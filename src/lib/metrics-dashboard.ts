import { addDays, format, startOfWeek, subDays } from "date-fns";
import pool from "@/lib/db";
import { cached, cacheKey, CACHE_PREFIXES } from "@/lib/cache";
import { mergeDevelopersByIdentity } from "@/lib/developer-identity";
import {
  normalizeAuthorFilter,
  resolveChangeAuthorKeys,
  buildDeploymentAuthorship,
  countAttributedDeployments,
  selectAuthorLeadTimes,
  median as authorMedian,
  authorAttributionCoverage,
  listSelectableAuthors,
} from "@/lib/dora-author-scope";
import type { DeploymentChangeRow } from "@/lib/dora-author-scope";
import {
  calculateChangeFailureRatePct,
  calculateConfidenceScore,
  calculateDeploymentFrequencyPerProjectDay,
  calculateOpenAgingBuckets,
  calculateSonarRiskScore,
  isValidLeadTimeHours,
  isAnomalousDeploymentFrequency,
  selectLeadTimeWithVariant,
  DF_ANOMALY_THRESHOLD,
  LEAD_TIME_GUARD_HOURS,
  pickPreferredLeadTimeHours,
} from "@/lib/metrics-formulas";
import type { LeadTimeVariant } from "@/lib/metrics-formulas";
import {
  MIN_CORRELATION_CONFIDENCE,
} from "@/lib/deployment-correlation";
import { buildWhereClause, parseMetricFilters } from "@/lib/query-filters";
import {
  average,
  blend,
  clamp,
  localeCompare,
  metric,
  nullableInt,
  nullableNumber,
  parseCsv,
  resolveAuthorIdentitySeed,
  sanitizeDeveloperEmail,
  sumNumbers,
  toNumber,
  uniqueBy,
  type TrendMetric,
} from "@/lib/dashboard-utils";
import {
  calculateGap,
  calculateStats,
  gaussianDistribution,
  hasOutliers,
  isStable,
  isVolatile,
  median,
} from "@/lib/statistics";

export interface DashboardFilters {
  teams: string[];
  projectIds: number[];
  developers: string[];
  days: number;
  /** Custom range (YYYY-MM-DD). When both present, they win over `days`. */
  from?: string;
  to?: string;
  authors: string[];
  sonarProjectKeys: string[];
  sonarScope: "all" | "none";
}

export type { TrendMetric } from "@/lib/dashboard-utils";

type LeadTimeReference = {
  key: "first_commit" | "mr_created" | "last_commit" | "none";
  label: string;
  description: string;
};

type DoraDailyRow = {
  snapshot_date: string;
  deployments: string | number | null;
  unique_deployments: string | number | null;
  rollbacks: string | number | null;
  hotfixes: string | number | null;
  features: string | number | null;
  lead_time_sum: string | number | null;
  lead_time_count: string | number | null;
  lead_time_first_commit_sum: string | number | null;
  lead_time_first_commit_count: string | number | null;
  lead_time_mr_sum: string | number | null;
  lead_time_mr_count: string | number | null;
  mttr_sum: string | number | null;
  mttr_count: string | number | null;
  failures: string | number | null;
  project_count: string | number | null;
};

type LeadTimeTraceDailyRow = {
  snapshot_date: string;
  trace_deployments: string | number | null;
  lead_time_commit_sum: string | number | null;
  lead_time_commit_count: string | number | null;
  lead_time_first_commit_sum: string | number | null;
  lead_time_first_commit_count: string | number | null;
  lead_time_mr_sum: string | number | null;
  lead_time_mr_count: string | number | null;
};

type K8sRolloutRow = {
  snapshot_date: string;
  rollouts: string | number | null;
  workloads: string | number | null;
  namespaces: string | number | null;
};

type K8sFailureRow = {
  snapshot_date: string;
  failed_workloads: string | number | null;
  unavailable_replicas: string | number | null;
  container_restarts: string | number | null;
};

type ArgocdHealthRow = {
  snapshot_date: string;
  total_apps: string | number | null;
  healthy_apps: string | number | null;
  degraded_apps: string | number | null;
  out_of_sync_apps: string | number | null;
};

type ClusterTrendRow = {
  date: string;
  rollouts: number;
  workloads: number;
  namespaces: number;
  failedWorkloads: number;
  unavailableReplicas: number;
  containerRestarts: number;
  totalApps: number;
  healthyApps: number;
  degradedApps: number;
  outOfSyncApps: number;
};

type ClusterSignalsSummary = {
  available: boolean;
  scoped: boolean;
  reason: string | null;
  daysWithData: number;
  totals: {
    rollouts: number;
    failedWorkloads: number;
    unavailableReplicas: number;
    containerRestarts: number;
    totalApps: number;
    healthyApps: number;
    degradedApps: number;
    outOfSyncApps: number;
  };
  rolloutsPerDay: TrendMetric;
  failedWorkloadsPerDay: TrendMetric;
  degradedAppsPerDay: TrendMetric;
  healthRate: TrendMetric;
  outOfSyncAppsPerDay: TrendMetric;
};

type CorrelationDailyRow = {
  snapshot_date: string;
  correlated_deploys: string | number | null;
  runtime_failures: string | number | null;
  mttr_sum_hours: string | number | null;
  mttr_count: string | number | null;
  avg_confidence: string | number | null;
};

type CorrelationTrendRow = {
  date: string;
  correlatedDeployments: number;
  runtimeFailures: number;
  runtimeFailureRate: number;
  mttrSumHours: number;
  mttrCount: number;
  runtimeMttrHours: number;
  averageConfidence: number;
};

type ReliabilitySignalsSummary = {
  available: boolean;
  scoped: boolean;
  source: "gitlab" | "hybrid";
  cfrSource: "gitlab" | "hybrid";
  mttrSource: "gitlab" | "hybrid";
  reason: string | null;
  confidenceThreshold: number;
  minCoveragePct: number;
  coveragePct: number;
  previousCoveragePct: number;
  correlatedDeployments: number;
  runtimeFailures: number;
  mttrIncidents: number;
  averageConfidence: number;
  hybridChangeFailureRate: TrendMetric;
  hybridMttr: TrendMetric;
};

/**
 * Not-available indicator for a DORA metric under an author filter. Modeled as
 * an explicit flag object, distinct from the numeric value `0`, so the UI can
 * tell "no attributable activity" apart from "measured zero".
 */
export type DoraNotAvailable = { available: false };

/** Author-scope summary returned under `summary.authorScope`. */
export interface DoraAuthorScope {
  /** Applied Author_Filter (canonical keys + readable name). Empty ⇒ no filter. */
  authors: { key: string; name: string }[];
  /** % of in-scope deployments with resolvable authorship; null if 0 deployments. */
  attributionCoverage: number | null;
  /** Configurable threshold (default 80.0) for the coverage notice. */
  attributionCoverageThreshold: number;
  /** true when an author filter is active (drives banner/labels/empty-state in UI). */
  active: boolean;
}

/** Flags marking which metrics are deployment/pipeline level under an author filter. */
export interface DoraDeploymentLevelFlags {
  /** CFR is deployment-level (not attributed) under an author filter. */
  changeFailureRate: boolean;
  /** Pipeline Recovery Time is pipeline-level (not attributed) under an author filter. */
  pipelineRecoveryTime: boolean;
}

/**
 * Coalesce a possibly not-available DORA metric into a `TrendMetric`, mapping
 * the `{ available: false }` indicator to a zeroed metric. Used by the legacy
 * per-metric routes that expose a flat numeric shape. Under an empty author
 * filter the value is always a `TrendMetric`, so behavior is unchanged.
 */
export function trendMetricOrZero(
  value: TrendMetric | DoraNotAvailable
): TrendMetric {
  return "available" in value ? { current: 0, previous: 0, change: 0 } : value;
}

type AuditCheckStatus = "pass" | "warn" | "fail" | "info";

type AuditCheck = {
  key: string;
  label: string;
  status: AuditCheckStatus;
  value: string;
  detail: string;
};

type AuditSummary = {
  methodologyVersion: string;
  sourceOfTruth: string;
  note: string;
  coverageLabel: string;
  coveragePct: number;
  confidenceScore: number;
  confidenceLabel: "alta" | "media" | "baja";
  anomalies: number;
  checks: AuditCheck[];
};

type ProductionIntegritySummary = {
  totalDeployments: number;
  deploymentsWithTrace: number;
  deploymentsWithoutChanges: number;
  deploymentsWithoutJob: number;
  duplicateJobRecords: number;
};

type TraceabilitySummaryRow = {
  deployments: string | number | null;
  deployments_with_mr: string | number | null;
  unique_commits: string | number | null;
  unique_mrs: string | number | null;
  avg_mr_commit_count: string | number | null;
  first_commit_samples: string | number | null;
  mr_samples: string | number | null;
  commit_samples: string | number | null;
  first_commit_discarded: string | number | null;
  mr_discarded: string | number | null;
  commit_discarded: string | number | null;
};

type TraceabilityRecentRow = {
  snapshot_date: string;
  team: string | null;
  project_id: string | number | null;
  project_name: string | null;
  commit_sha: string | null;
  commit_created_at: string | null;
  commit_author_email: string | null;
  mr_id: string | number | null;
  mr_iid: string | number | null;
  mr_created_at: string | null;
  mr_merged_at: string | null;
  mr_title: string | null;
  mr_source_branch: string | null;
  mr_first_commit_at: string | null;
  mr_last_commit_at: string | null;
  mr_commit_count: string | number | null;
  deploy_id: string;
  deploy_created_at: string;
  deploy_type: "feature" | "hotfix" | "rollback" | null;
  deploy_type_reason: string | null;
  deploy_environment: string | null;
  lead_time_commit_hours: string | number | null;
  lead_time_mr_hours: string | number | null;
  lead_time_first_commit_hours: string | number | null;
  raw_commit_span_hours: string | number | null;
  raw_mr_span_hours: string | number | null;
  raw_first_commit_span_hours: string | number | null;
};

type DoraTraceabilitySummary = {
  available: boolean;
  reason: string | null;
  leadTimeGuardHours: number;
  deployments: number;
  deploymentsWithMr: number;
  uniqueCommits: number;
  uniqueMrs: number;
  averageMrCommitCount: number;
  leadTimeSamples: {
    firstCommit: number;
    mr: number;
    lastCommit: number;
  };
  discardedOutliers: {
    firstCommit: number;
    mr: number;
    lastCommit: number;
  };
  recentDeployments: Array<{
    snapshotDate: string;
    team: string | null;
    projectId: number;
    projectName: string;
    deployId: string;
    deployCreatedAt: string;
    deployType: "feature" | "hotfix" | "rollback";
    deployTypeReason: string | null;
    deployEnvironment: string | null;
    commitSha: string | null;
    commitCreatedAt: string | null;
    commitAuthorEmail: string | null;
    mrId: number | null;
    mrIid: number | null;
    mrCreatedAt: string | null;
    mrMergedAt: string | null;
    mrTitle: string | null;
    mrSourceBranch: string | null;
    mrFirstCommitAt: string | null;
    mrLastCommitAt: string | null;
    mrCommitCount: number;
    leadTimes: {
      firstCommitHours: number | null;
      mrHours: number | null;
      lastCommitHours: number | null;
    };
    rawLeadTimes: {
      firstCommitHours: number | null;
      mrHours: number | null;
      lastCommitHours: number | null;
    };
    discarded: {
      firstCommit: boolean;
      mr: boolean;
      lastCommit: boolean;
    };
  }>;
};

type Reviewer = {
  name: string;
  username: string;
  avatar_url: string | null;
  comments: number;
};

type MergeRequestRow = {
  project_id: number;
  project_name: string;
  team: string;
  mr_id: number;
  mr_iid: number;
  title: string;
  state: "opened" | "merged" | "closed" | "locked";
  web_url: string | null;
  author_name: string;
  author_username: string;
  author_email: string | null;
  author_avatar_url: string | null;
  canonical_author_key: string;
  canonical_author_name: string;
  created_at: string;
  merged_at: string | null;
  updated_at: string | null;
  first_comment_at: string | null;
  lifetime_hours: number;
  lead_time_hours: number;
  review_time_hours: number;
  commit_count: number;
  changes_count: number;
  review_count: number;
  reviewer_count: number;
  reviewers: Reviewer[];
  reference_at: string;
};

type MergeRequestQueryRow = {
  project_id: number;
  project_name: string;
  team: string;
  mr_id: number;
  mr_iid: number;
  title: string;
  state: "opened" | "merged" | "closed" | "locked";
  web_url: string | null;
  author_name: string;
  author_username: string;
  author_email: string | null;
  author_avatar_url: string | null;
  created_at: Date;
  merged_at: Date | null;
  updated_at: Date | null;
  first_comment_at: Date | null;
  lifetime_hours: string | number | null;
  lead_time_hours: string | number | null;
  review_time_hours: string | number | null;
  commit_count: string | number | null;
  changes_count: string | number | null;
  review_count: string | number | null;
  reviewer_count: string | number | null;
  reviewers: Reviewer[] | string | null;
  reference_at: Date;
  snapshot_date: Date | string;
};

type ProductionChangeRow = {
  deployment_id: string | number | null;
  project_id: string | number | null;
  project_name: string | null;
  team: string | null;
  deploy_completed_at: string;
  deploy_type: "feature" | "hotfix" | "rollback" | null;
  deploy_type_reason: string | null;
  deploy_environment: string | null;
  gitlab_job_id: string | null;
  gitlab_pipeline_id: string | null;
  commit_sha: string | null;
  commit_created_at: string | null;
  mr_iid: string | number | null;
  author_email: string | null;
  author_name: string | null;
};

type ProductionContributor = {
  canonicalKey: string;
  email: string;
  name: string;
  teams: string[];
  changesDeployed: number;
  deploymentsTouched: number;
  projectsActive: number;
  medianLeadTimeHours: number;
  hotfixDeployments: number;
  rollbackDeployments: number;
  lastDeployedAt: string | null;
  linesAdded: number;
  linesRemoved: number;
};

type ManagerAuthorOption = {
  key: string;
  label: string;
  name: string;
  email: string | null;
  /**
   * GitLab usernames that resolve to this canonical identity. Lets per-username
   * endpoints (team-activity, mr-details) honour the canonical author filter
   * without re-running the (population-dependent) identity merge themselves.
   */
  usernames: string[];
};

type ProductionTeamSummary = {
  team: string;
  deployments: number;
  changesDeployed: number;
  contributors: number;
  hotfixDeployments: number;
  rollbackDeployments: number;
  medianLeadTimeHours: number;
};

type SonarHistoryRow = {
  snapshot_date: string;
  avg_coverage: string | number | null;
  avg_duplication: string | number | null;
  total_bugs: string | number | null;
  total_vulnerabilities: string | number | null;
  total_code_smells: string | number | null;
  total_tech_debt: string | number | null;
  total_hotspots: string | number | null;
  quality_gate_ok: string | number | null;
  quality_gate_error: string | number | null;
  quality_gate_warn: string | number | null;
  project_count: string | number | null;
};

type SonarProjectRow = {
  sonar_project_key: string;
  sonar_project_name: string | null;
  snapshot_date: string;
  gitlab_project_id: string | number | null;
  gitlab_project_path: string | null;
  coverage: string | number | null;
  bugs: string | number | null;
  vulnerabilities: string | number | null;
  code_smells: string | number | null;
  tech_debt_minutes: string | number | null;
  security_hotspots: string | number | null;
  duplicated_lines_density: string | number | null;
  quality_gate_status: string | null;
};

type SonarAvailableProjectRow = {
  sonar_project_key: string;
  sonar_project_name: string | null;
  gitlab_project_id: string | number | null;
  gitlab_project_path: string | null;
};

type ServiceComplianceSummaryRow = {
  project_count: string | number | null;
  average_score: string | number | null;
  latest_snapshot: string | null;
  default_branch_protected_count: string | number | null;
  push_rules_configured_count: string | number | null;
  branch_regex_ok_count: string | number | null;
  deploy_prod_ready_count: string | number | null;
  prod_environment_standard_count: string | number | null;
  service_catalog_linked_count: string | number | null;
  runtime_mapping_ok_count: string | number | null;
  sonar_linked_count: string | number | null;
  quality_gate_reporting_count: string | number | null;
  dora_traceability_ready_count: string | number | null;
};

type ServiceComplianceProjectRow = {
  snapshot_date: string;
  project_id: string | number | null;
  project_name: string | null;
  project_path: string | null;
  team: string | null;
  compliance_score: string | number | null;
  default_branch_protected: boolean | null;
  push_rules_configured: boolean | null;
  branch_regex_ok: boolean | null;
  deploy_prod_declared: boolean | null;
  deploy_prod_observed: boolean | null;
  prod_environment_standard_ok: boolean | null;
  service_catalog_linked: boolean | null;
  runtime_mapping_ok: boolean | null;
  sonar_linked: boolean | null;
  quality_gate_reporting: boolean | null;
  dora_traceability_ready: boolean | null;
  latest_quality_gate_status: string | null;
  deploy_prod_declaration_source: string | null;
  deploy_prod_status: string | null;
  ci_includes_detected: boolean | null;
  gap_count: string | number | null;
};

type ComplianceControl = {
  count: number;
  pct: number;
};

type ServiceComplianceSummary = {
  available: boolean;
  reason: string | null;
  latestSnapshot: string | null;
  projects: number;
  averageScore: number;
  controls: {
    defaultBranchProtected: ComplianceControl;
    pushRulesConfigured: ComplianceControl;
    branchRegexOk: ComplianceControl;
    deployProdReady: ComplianceControl;
    prodEnvironmentStandard: ComplianceControl;
    serviceCatalogLinked: ComplianceControl;
    runtimeMappingOk: ComplianceControl;
    sonarLinked: ComplianceControl;
    qualityGateReporting: ComplianceControl;
    doraTraceabilityReady: ComplianceControl;
  };
  projectsWithGaps: Array<{
    snapshotDate: string;
    projectId: number;
    projectName: string;
    projectPath: string;
    team: string | null;
    score: number;
    gapCount: number;
      latestQualityGateStatus: string | null;
      deployProd: {
        declarationSource: "none" | "local" | "expanded";
        status: "observed" | "declared_no_recent_activity" | "no_evidence";
        includesDetected: boolean;
      };
      statuses: {
        defaultBranchProtected: boolean;
        pushRulesConfigured: boolean;
      branchRegexOk: boolean;
      deployProdDeclared: boolean;
      deployProdObserved: boolean;
      prodEnvironmentStandardOk: boolean;
      serviceCatalogLinked: boolean;
      runtimeMappingOk: boolean;
      sonarLinked: boolean;
      qualityGateReporting: boolean;
      doraTraceabilityReady: boolean;
    };
  }>;
};

const CORRELATION_MIN_CONFIDENCE = clamp(
  Number.parseFloat(process.env.DORA_CORRELATION_MIN_CONFIDENCE || "0.7"),
  0,
  1
);
const CORRELATION_MIN_COVERAGE = clamp(
  Number.parseFloat(process.env.DORA_CORRELATION_MIN_COVERAGE || "0.35"),
  0,
  1
);
const CORRELATION_MIN_DEPLOYS = Math.max(
  1,
  Number.parseInt(process.env.DORA_CORRELATION_MIN_DEPLOYS || "8", 10) || 8
);
const LEAD_TIME_GUARD_SQL = String(LEAD_TIME_GUARD_HOURS);
const DORA_PROD_ENVIRONMENTS = (process.env.DORA_PROD_ENVIRONMENTS || "production,prod")
  .split(",")
  .map((env) => env.trim().toLowerCase())
  .filter(Boolean);
const WEEK_STARTS_ON_MONDAY = { weekStartsOn: 1 as const };

export function parseDashboardFilters(searchParams: URLSearchParams): DashboardFilters {
  const base = parseMetricFilters(searchParams);
  return {
    ...base,
    authors: parseCsv(searchParams.get("authors") || searchParams.get("author")),
    sonarProjectKeys: parseCsv(searchParams.get("projectKeys") || searchParams.get("projectKey")),
    sonarScope: searchParams.get("sonarScope") === "none" ? "none" : "all",
  };
}

function createEmptyDoraDailyRow(snapshotDate: string): DoraDailyRow {
  return {
    snapshot_date: snapshotDate,
    deployments: 0,
    unique_deployments: 0,
    rollbacks: 0,
    hotfixes: 0,
    features: 0,
    lead_time_sum: 0,
    lead_time_count: 0,
    lead_time_first_commit_sum: 0,
    lead_time_first_commit_count: 0,
    lead_time_mr_sum: 0,
    lead_time_mr_count: 0,
    mttr_sum: 0,
    mttr_count: 0,
    failures: 0,
    project_count: 0,
  };
}

function normalizeSnapshotDate(value: unknown) {
  return value instanceof Date ? format(value, "yyyy-MM-dd") : String(value);
}

async function getCanonicalDoraRows(
  startDate: string,
  endDate: string,
  filters: DashboardFilters
): Promise<DoraDailyRow[]> {
  const params: unknown[] = [startDate, endDate, DORA_PROD_ENVIRONMENTS];
  const conditions = [
    "pd.source = 'gitlab'",
    "pd.status = 'success'",
    "pd.deploy_completed_at >= $1::date",
    "pd.deploy_completed_at < ($2::date + INTERVAL '1 day')",
    "LOWER(COALESCE(pd.environment, 'production')) = ANY($3)",
  ];

  if (filters.teams.length > 0) {
    conditions.push(`COALESCE(pd.team, s.team) = ANY($${params.length + 1})`);
    params.push(filters.teams);
  }
  if (filters.projectIds.length > 0) {
    conditions.push(`pd.project_id = ANY($${params.length + 1})`);
    params.push(filters.projectIds);
  }

  const result = await pool.query<DoraDailyRow>(
    `
      WITH change_windows AS (
        SELECT
          deployment_id,
          MAX(commit_created_at) FILTER (WHERE commit_created_at IS NOT NULL) AS last_commit_at,
          MIN(commit_created_at) FILTER (WHERE commit_created_at IS NOT NULL) AS first_commit_at,
          MIN(mr_created_at) FILTER (WHERE mr_created_at IS NOT NULL) AS first_mr_created_at
        FROM deployment_changes
        GROUP BY deployment_id
      )
      SELECT
        DATE(pd.deploy_completed_at) AS snapshot_date,
        COUNT(*) AS deployments,
        COUNT(DISTINCT pd.commit_sha) FILTER (WHERE pd.commit_sha IS NOT NULL) AS unique_deployments,
        COUNT(*) FILTER (
          WHERE COALESCE(pd.deploy_type, pd.metadata->>'deployType') = 'rollback'
        ) AS rollbacks,
        COUNT(*) FILTER (
          WHERE COALESCE(pd.deploy_type, pd.metadata->>'deployType') = 'hotfix'
        ) AS hotfixes,
        COUNT(*) FILTER (
          WHERE COALESCE(pd.deploy_type, pd.metadata->>'deployType', 'feature') = 'feature'
        ) AS features,
        SUM(
          CASE
            WHEN cw.last_commit_at IS NOT NULL
              AND EXTRACT(EPOCH FROM (pd.deploy_completed_at - cw.last_commit_at)) / 3600.0 >= 0
              AND EXTRACT(EPOCH FROM (pd.deploy_completed_at - cw.last_commit_at)) / 3600.0 <= ${LEAD_TIME_GUARD_SQL}
            THEN EXTRACT(EPOCH FROM (pd.deploy_completed_at - cw.last_commit_at)) / 3600.0
            ELSE 0
          END
        ) AS lead_time_sum,
        COUNT(*) FILTER (
          WHERE cw.last_commit_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (pd.deploy_completed_at - cw.last_commit_at)) / 3600.0 >= 0
            AND EXTRACT(EPOCH FROM (pd.deploy_completed_at - cw.last_commit_at)) / 3600.0 <= ${LEAD_TIME_GUARD_SQL}
        ) AS lead_time_count,
        SUM(
          CASE
            WHEN cw.first_commit_at IS NOT NULL
              AND EXTRACT(EPOCH FROM (pd.deploy_completed_at - cw.first_commit_at)) / 3600.0 >= 0
              AND EXTRACT(EPOCH FROM (pd.deploy_completed_at - cw.first_commit_at)) / 3600.0 <= ${LEAD_TIME_GUARD_SQL}
            THEN EXTRACT(EPOCH FROM (pd.deploy_completed_at - cw.first_commit_at)) / 3600.0
            ELSE 0
          END
        ) AS lead_time_first_commit_sum,
        COUNT(*) FILTER (
          WHERE cw.first_commit_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (pd.deploy_completed_at - cw.first_commit_at)) / 3600.0 >= 0
            AND EXTRACT(EPOCH FROM (pd.deploy_completed_at - cw.first_commit_at)) / 3600.0 <= ${LEAD_TIME_GUARD_SQL}
        ) AS lead_time_first_commit_count,
        SUM(
          CASE
            WHEN cw.first_mr_created_at IS NOT NULL
              AND EXTRACT(EPOCH FROM (pd.deploy_completed_at - cw.first_mr_created_at)) / 3600.0 >= 0
              AND EXTRACT(EPOCH FROM (pd.deploy_completed_at - cw.first_mr_created_at)) / 3600.0 <= ${LEAD_TIME_GUARD_SQL}
            THEN EXTRACT(EPOCH FROM (pd.deploy_completed_at - cw.first_mr_created_at)) / 3600.0
            ELSE 0
          END
        ) AS lead_time_mr_sum,
        COUNT(*) FILTER (
          WHERE cw.first_mr_created_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (pd.deploy_completed_at - cw.first_mr_created_at)) / 3600.0 >= 0
            AND EXTRACT(EPOCH FROM (pd.deploy_completed_at - cw.first_mr_created_at)) / 3600.0 <= ${LEAD_TIME_GUARD_SQL}
        ) AS lead_time_mr_count,
        0 AS mttr_sum,
        0 AS mttr_count,
        0 AS failures,
        COUNT(DISTINCT pd.project_id) AS project_count
      FROM production_deployments pd
      LEFT JOIN services s
        ON s.id = pd.service_id
      LEFT JOIN change_windows cw
        ON cw.deployment_id = pd.id
      WHERE ${conditions.join("\n        AND ")}
      GROUP BY DATE(pd.deploy_completed_at)
      ORDER BY snapshot_date ASC
    `,
    params
  );

  return result.rows;
}

function overlayCanonicalDoraRows(legacyRows: DoraDailyRow[], canonicalRows: DoraDailyRow[]) {
  const merged = new Map<string, DoraDailyRow>();

  for (const row of legacyRows) {
    const key = normalizeSnapshotDate(row.snapshot_date);
    merged.set(key, { ...row, snapshot_date: key });
  }

  for (const row of canonicalRows) {
    const key = normalizeSnapshotDate(row.snapshot_date);
    const base = merged.get(key) || createEmptyDoraDailyRow(key);
    merged.set(key, {
      ...base,
      snapshot_date: key,
      deployments: row.deployments,
      unique_deployments: row.unique_deployments,
      rollbacks: row.rollbacks,
      hotfixes: row.hotfixes,
      features: row.features,
      lead_time_sum: row.lead_time_sum,
      lead_time_count: row.lead_time_count,
      lead_time_first_commit_sum: row.lead_time_first_commit_sum,
      lead_time_first_commit_count: row.lead_time_first_commit_count,
      lead_time_mr_sum: row.lead_time_mr_sum,
      lead_time_mr_count: row.lead_time_mr_count,
      project_count: row.project_count,
    });
  }

  return [...merged.values()].sort((left, right) =>
    normalizeSnapshotDate(left.snapshot_date).localeCompare(normalizeSnapshotDate(right.snapshot_date))
  );
}

async function getCanonicalUniqueChangeCount(
  startDate: string,
  endDate: string,
  filters: DashboardFilters
) {
  const params: unknown[] = [startDate, endDate, DORA_PROD_ENVIRONMENTS];
  const conditions = [
    "pd.source = 'gitlab'",
    "pd.status = 'success'",
    "pd.deploy_completed_at >= $1::date",
    "pd.deploy_completed_at < ($2::date + INTERVAL '1 day')",
    "LOWER(COALESCE(pd.environment, 'production')) = ANY($3)",
  ];

  if (filters.teams.length > 0) {
    conditions.push(`COALESCE(pd.team, s.team) = ANY($${params.length + 1})`);
    params.push(filters.teams);
  }
  if (filters.projectIds.length > 0) {
    conditions.push(`pd.project_id = ANY($${params.length + 1})`);
    params.push(filters.projectIds);
  }

  const result = await pool.query<{ unique_changes: string | number | null }>(
    `
      SELECT
        COUNT(DISTINCT COALESCE(dc.commit_sha, pd.commit_sha)) FILTER (
          WHERE COALESCE(dc.commit_sha, pd.commit_sha) IS NOT NULL
        ) AS unique_changes
      FROM production_deployments pd
      LEFT JOIN deployment_changes dc
        ON dc.deployment_id = pd.id
      LEFT JOIN services s
        ON s.id = pd.service_id
      WHERE ${conditions.join("\n        AND ")}
    `,
    params
  );

  return toNumber(result.rows[0]?.unique_changes);
}

/**
 * Reads the deployment-change rows for author scoping from `deployment_changes`
 * joined to `production_deployments`, using the SAME scope conditions as
 * `getCanonicalDoraRows` (source='gitlab', status='success', date window,
 * environment ∈ DORA_PROD_ENVIRONMENTS, team/projectIds). A LEFT JOIN is used so
 * deployments with no changes still appear (they count as unresolvable in the
 * attribution coverage denominator). Query failures are captured and logged so
 * the response degrades gracefully (returns `[]`) instead of breaking.
 */
async function getDeploymentChangeRows(
  startDate: string,
  endDate: string,
  filters: DashboardFilters
): Promise<DeploymentChangeRow[]> {
  const params: unknown[] = [startDate, endDate, DORA_PROD_ENVIRONMENTS];
  const conditions = [
    "pd.source = 'gitlab'",
    "pd.status = 'success'",
    "pd.deploy_completed_at >= $1::date",
    "pd.deploy_completed_at < ($2::date + INTERVAL '1 day')",
    "LOWER(COALESCE(pd.environment, 'production')) = ANY($3)",
  ];

  if (filters.teams.length > 0) {
    conditions.push(`COALESCE(pd.team, s.team) = ANY($${params.length + 1})`);
    params.push(filters.teams);
  }
  if (filters.projectIds.length > 0) {
    conditions.push(`pd.project_id = ANY($${params.length + 1})`);
    params.push(filters.projectIds);
  }

  try {
    const result = await pool.query<{
      deployment_id: number;
      deploy_date: string | Date;
      commit_sha: string | null;
      commit_created_at: Date | string | null;
      mr_first_commit_at: Date | string | null;
      deploy_completed_at: Date | string | null;
      author_email: string | null;
    }>(
      `
        SELECT
          pd.id AS deployment_id,
          DATE(pd.deploy_completed_at) AS deploy_date,
          dc.commit_sha AS commit_sha,
          dc.commit_created_at AS commit_created_at,
          dc.mr_first_commit_at AS mr_first_commit_at,
          pd.deploy_completed_at AS deploy_completed_at,
          dc.author_email AS author_email
        FROM production_deployments pd
        LEFT JOIN deployment_changes dc
          ON dc.deployment_id = pd.id
        LEFT JOIN services s
          ON s.id = pd.service_id
        WHERE ${conditions.join("\n          AND ")}
      `,
      params
    );

    return result.rows.map((row) => ({
      deploymentId: toNumber(row.deployment_id),
      deployDate: normalizeSnapshotDate(row.deploy_date),
      commitSha: row.commit_sha,
      commitCreatedAt: row.commit_created_at,
      mrFirstCommitAt: row.mr_first_commit_at,
      deployCompletedAt: row.deploy_completed_at,
      authorEmail: row.author_email,
      authorUsername: null,
    }));
  } catch (error) {
    console.error("Deployment change rows query error:", error);
    return [];
  }
}

async function getServiceComplianceSummary(
  startDate: string,
  endDate: string,
  filters: DashboardFilters
): Promise<ServiceComplianceSummary> {
  const params: unknown[] = [startDate, endDate];
  const conditions = [
    "snapshot_date >= $1",
    "snapshot_date <= $2",
  ];

  if (filters.teams.length > 0) {
    conditions.push(`team = ANY($${params.length + 1})`);
    params.push(filters.teams);
  }
  if (filters.projectIds.length > 0) {
    conditions.push(`project_id = ANY($${params.length + 1})`);
    params.push(filters.projectIds);
  }

  const latestScope = `
    WITH latest AS (
      SELECT DISTINCT ON (project_id)
        snapshot_date,
        project_id,
        project_name,
        project_path,
        team,
        compliance_score,
        default_branch_protected,
        push_rules_configured,
        branch_regex_ok,
        deploy_prod_declared,
        deploy_prod_observed,
        prod_environment_standard_ok,
        service_catalog_linked,
        runtime_mapping_ok,
        sonar_linked,
        quality_gate_reporting,
        dora_traceability_ready,
        latest_quality_gate_status,
        metadata
      FROM service_compliance_daily
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY project_id, snapshot_date DESC
    )
  `;

  try {
    const [summaryResult, gapProjectsResult] = await Promise.all([
      pool.query<ServiceComplianceSummaryRow>(
        `
          ${latestScope}
          SELECT
            COUNT(*) AS project_count,
            AVG(compliance_score) AS average_score,
            MAX(snapshot_date) AS latest_snapshot,
            COUNT(*) FILTER (WHERE default_branch_protected) AS default_branch_protected_count,
            COUNT(*) FILTER (WHERE push_rules_configured) AS push_rules_configured_count,
            COUNT(*) FILTER (WHERE branch_regex_ok) AS branch_regex_ok_count,
            COUNT(*) FILTER (WHERE deploy_prod_declared OR deploy_prod_observed) AS deploy_prod_ready_count,
            COUNT(*) FILTER (WHERE prod_environment_standard_ok) AS prod_environment_standard_count,
            COUNT(*) FILTER (WHERE service_catalog_linked) AS service_catalog_linked_count,
            COUNT(*) FILTER (WHERE runtime_mapping_ok) AS runtime_mapping_ok_count,
            COUNT(*) FILTER (WHERE sonar_linked) AS sonar_linked_count,
            COUNT(*) FILTER (WHERE quality_gate_reporting) AS quality_gate_reporting_count,
            COUNT(*) FILTER (WHERE dora_traceability_ready) AS dora_traceability_ready_count
          FROM latest
        `,
        params
      ),
      pool.query<ServiceComplianceProjectRow>(
        `
          ${latestScope}
          SELECT
            snapshot_date,
            project_id,
            project_name,
            project_path,
            team,
            compliance_score,
            default_branch_protected,
            push_rules_configured,
            branch_regex_ok,
            deploy_prod_declared,
            deploy_prod_observed,
            prod_environment_standard_ok,
            service_catalog_linked,
            runtime_mapping_ok,
            sonar_linked,
            quality_gate_reporting,
            dora_traceability_ready,
            latest_quality_gate_status,
            COALESCE(metadata->>'deployProdDeclarationSource', 'none') AS deploy_prod_declaration_source,
            COALESCE(metadata->>'deployProdStatus', 'no_evidence') AS deploy_prod_status,
            COALESCE((metadata->>'ciIncludesDetected')::boolean, false) AS ci_includes_detected,
            (
              CASE WHEN COALESCE(default_branch_protected, false) THEN 0 ELSE 1 END +
              CASE WHEN COALESCE(push_rules_configured, false) THEN 0 ELSE 1 END +
              CASE WHEN COALESCE(branch_regex_ok, false) THEN 0 ELSE 1 END +
              CASE WHEN COALESCE(deploy_prod_declared, false) OR COALESCE(deploy_prod_observed, false) THEN 0 ELSE 1 END +
              CASE WHEN COALESCE(prod_environment_standard_ok, false) THEN 0 ELSE 1 END +
              CASE WHEN COALESCE(service_catalog_linked, false) THEN 0 ELSE 1 END +
              CASE WHEN COALESCE(runtime_mapping_ok, false) THEN 0 ELSE 1 END +
              CASE WHEN COALESCE(sonar_linked, false) THEN 0 ELSE 1 END +
              CASE WHEN COALESCE(quality_gate_reporting, false) THEN 0 ELSE 1 END +
              CASE WHEN COALESCE(dora_traceability_ready, false) THEN 0 ELSE 1 END
            ) AS gap_count
          FROM latest
          ORDER BY gap_count DESC, compliance_score ASC, project_name ASC
          LIMIT 12
        `,
        params
      ),
    ]);

    const row = summaryResult.rows[0];
    const projectCount = toNumber(row?.project_count);
    if (projectCount === 0) {
      return {
        available: false,
        reason: "Todavía no hay snapshots de compliance para el alcance seleccionado.",
        latestSnapshot: null,
        projects: 0,
        averageScore: 0,
        controls: {
          defaultBranchProtected: complianceControl(0, 0),
          pushRulesConfigured: complianceControl(0, 0),
          branchRegexOk: complianceControl(0, 0),
          deployProdReady: complianceControl(0, 0),
          prodEnvironmentStandard: complianceControl(0, 0),
          serviceCatalogLinked: complianceControl(0, 0),
          runtimeMappingOk: complianceControl(0, 0),
          sonarLinked: complianceControl(0, 0),
          qualityGateReporting: complianceControl(0, 0),
          doraTraceabilityReady: complianceControl(0, 0),
        },
        projectsWithGaps: [],
      };
    }

    return {
      available: true,
      reason: null,
      latestSnapshot: row?.latest_snapshot || null,
      projects: projectCount,
      averageScore: toNumber(row?.average_score),
      controls: {
        defaultBranchProtected: complianceControl(toNumber(row?.default_branch_protected_count), projectCount),
        pushRulesConfigured: complianceControl(toNumber(row?.push_rules_configured_count), projectCount),
        branchRegexOk: complianceControl(toNumber(row?.branch_regex_ok_count), projectCount),
        deployProdReady: complianceControl(toNumber(row?.deploy_prod_ready_count), projectCount),
        prodEnvironmentStandard: complianceControl(toNumber(row?.prod_environment_standard_count), projectCount),
        serviceCatalogLinked: complianceControl(toNumber(row?.service_catalog_linked_count), projectCount),
        runtimeMappingOk: complianceControl(toNumber(row?.runtime_mapping_ok_count), projectCount),
        sonarLinked: complianceControl(toNumber(row?.sonar_linked_count), projectCount),
        qualityGateReporting: complianceControl(toNumber(row?.quality_gate_reporting_count), projectCount),
        doraTraceabilityReady: complianceControl(toNumber(row?.dora_traceability_ready_count), projectCount),
      },
      projectsWithGaps: gapProjectsResult.rows.map((gapRow) => ({
        snapshotDate: gapRow.snapshot_date,
        projectId: toNumber(gapRow.project_id),
        projectName: gapRow.project_name || String(gapRow.project_id),
        projectPath: gapRow.project_path || gapRow.project_name || String(gapRow.project_id),
        team: gapRow.team,
        score: toNumber(gapRow.compliance_score),
        gapCount: toNumber(gapRow.gap_count),
        latestQualityGateStatus: gapRow.latest_quality_gate_status,
        deployProd: {
          declarationSource: (gapRow.deploy_prod_declaration_source || "none") as "none" | "local" | "expanded",
          status: (gapRow.deploy_prod_status || "no_evidence") as "observed" | "declared_no_recent_activity" | "no_evidence",
          includesDetected: Boolean(gapRow.ci_includes_detected),
        },
        statuses: {
          defaultBranchProtected: Boolean(gapRow.default_branch_protected),
          pushRulesConfigured: Boolean(gapRow.push_rules_configured),
          branchRegexOk: Boolean(gapRow.branch_regex_ok),
          deployProdDeclared: Boolean(gapRow.deploy_prod_declared),
          deployProdObserved: Boolean(gapRow.deploy_prod_observed),
          prodEnvironmentStandardOk: Boolean(gapRow.prod_environment_standard_ok),
          serviceCatalogLinked: Boolean(gapRow.service_catalog_linked),
          runtimeMappingOk: Boolean(gapRow.runtime_mapping_ok),
          sonarLinked: Boolean(gapRow.sonar_linked),
          qualityGateReporting: Boolean(gapRow.quality_gate_reporting),
          doraTraceabilityReady: Boolean(gapRow.dora_traceability_ready),
        },
      })),
    };
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown error";
    const missingTable = /relation .*service_compliance_daily.* does not exist/i.test(details);

    return {
      available: false,
      reason: missingTable
        ? "Tabla service_compliance_daily no disponible. Aplica migración 2026-03-17_service_compliance_daily.sql."
        : `No se pudo cargar la capa de compliance: ${details}`,
      latestSnapshot: null,
      projects: 0,
      averageScore: 0,
      controls: {
        defaultBranchProtected: complianceControl(0, 0),
        pushRulesConfigured: complianceControl(0, 0),
        branchRegexOk: complianceControl(0, 0),
        deployProdReady: complianceControl(0, 0),
        prodEnvironmentStandard: complianceControl(0, 0),
        serviceCatalogLinked: complianceControl(0, 0),
        runtimeMappingOk: complianceControl(0, 0),
        sonarLinked: complianceControl(0, 0),
        qualityGateReporting: complianceControl(0, 0),
        doraTraceabilityReady: complianceControl(0, 0),
      },
      projectsWithGaps: [],
    };
  }
}

export async function getDoraCoreDashboard(
  filters: DashboardFilters,
  options: { includeClusterSignals?: boolean } = {}
) {
  const key = cacheKey("dora-core", {
    days: filters.days,
    from: filters.from || null,
    to: filters.to || null,
    teams: filters.teams,
    projectIds: filters.projectIds,
    includeClusterSignals: options.includeClusterSignals ?? true,
    // Author dimension: empty filter ⇒ constant "authors=" sub-key ⇒ same cache
    // entry as queries without an author filter (zero regression). Same
    // canonical-key set in any order/duplication ⇒ same sub-key.
    authors: [...normalizeAuthorFilter(filters.authors)].sort(),
  });

  return cached(key, () => _getDoraCoreDashboardImpl(filters, options));
}

async function _getDoraCoreDashboardImpl(
  filters: DashboardFilters,
  options: { includeClusterSignals?: boolean } = {}
) {
  const includeClusterSignals = options.includeClusterSignals ?? true;
  // Honour explicit from/to when provided (used by period comparison and custom ranges).
  // Otherwise default to last `filters.days` days ending today.
  let endDate: Date;
  let startDate: Date;
  let windowDays: number;
  if (filters.from && filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.from) && /^\d{4}-\d{2}-\d{2}$/.test(filters.to)) {
    startDate = new Date(`${filters.from}T00:00:00Z`);
    endDate = new Date(`${filters.to}T00:00:00Z`);
    windowDays = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1);
  } else {
    endDate = new Date();
    startDate = subDays(endDate, filters.days);
    windowDays = filters.days;
  }
  const previousStartDate = subDays(startDate, windowDays);
  const baseParams = [format(previousStartDate, "yyyy-MM-dd"), format(endDate, "yyyy-MM-dd")];
  const doraScopeFilters = {
    ...filters,
    developers: [],
  };
  const { clause: filterClause, params: filterParams } = buildWhereClause(doraScopeFilters, 3);

  const query = `
    SELECT
      snapshot_date,
      SUM(deployment_count) AS deployments,
      SUM(COALESCE(unique_commits_deployed, deployment_count)) AS unique_deployments,
      SUM(COALESCE(rollback_count, 0)) AS rollbacks,
      SUM(COALESCE(hotfix_count, 0)) AS hotfixes,
      SUM(COALESCE(feature_count, 0)) AS features,
      SUM(COALESCE(lead_time_sum_hours, 0)) AS lead_time_sum,
      SUM(COALESCE(lead_time_count, 0)) AS lead_time_count,
      SUM(COALESCE(lead_time_first_commit_sum_hours, 0)) AS lead_time_first_commit_sum,
      SUM(COALESCE(lead_time_first_commit_count, 0)) AS lead_time_first_commit_count,
      SUM(COALESCE(lead_time_mr_sum_hours, 0)) AS lead_time_mr_sum,
      SUM(COALESCE(lead_time_mr_count, 0)) AS lead_time_mr_count,
      SUM(COALESCE(mttr_sum_hours, 0)) AS mttr_sum,
      SUM(COALESCE(mttr_count, 0)) AS mttr_count,
      SUM(COALESCE(deployment_failures, 0)) AS failures,
      COUNT(DISTINCT project_id) FILTER (
        WHERE deployment_count > 0 OR COALESCE(deployment_failures, 0) > 0 OR COALESCE(total_commits, 0) > 0
      ) AS project_count
    FROM dora_metrics_daily
    WHERE snapshot_date >= $1 AND snapshot_date <= $2
    ${filterClause}
    GROUP BY snapshot_date
    ORDER BY snapshot_date ASC
  `;

  const result = await pool.query<DoraDailyRow>(query, [...baseParams, ...filterParams]);
  let combinedRows = result.rows;

  try {
    const canonicalRows = await getCanonicalDoraRows(baseParams[0], baseParams[1], filters);
    if (canonicalRows.length > 0) {
      combinedRows = overlayCanonicalDoraRows(result.rows, canonicalRows);
    }
  } catch (error) {
    console.error("Canonical DORA overlay error:", error);
  }

  const cutoffDate = format(startDate, "yyyy-MM-dd");
  const toDateStr = (d: unknown) => normalizeSnapshotDate(d);
  const currentRows = combinedRows.filter((row) => toDateStr(row.snapshot_date) >= cutoffDate);
  const previousRows = combinedRows.filter((row) => toDateStr(row.snapshot_date) < cutoffDate);

  const sum = (rows: DoraDailyRow[], field: keyof DoraDailyRow) =>
    rows.reduce((total, row) => total + toNumber(row[field]), 0);

  const currentDeployments = sum(currentRows, "deployments");
  const previousDeployments = sum(previousRows, "deployments");
  const currentUniqueDeployments = sum(currentRows, "unique_deployments");
  let currentUniqueChangesExact = currentUniqueDeployments;
  const currentRollbacks = sum(currentRows, "rollbacks");
  const currentHotfixes = sum(currentRows, "hotfixes");
  const currentFeatures = sum(currentRows, "features");
  const currentProjectDays = sum(currentRows, "project_count");
  const previousProjectDays = sum(previousRows, "project_count");

  const currentFailureCount = sum(currentRows, "failures");
  const previousFailureCount = sum(previousRows, "failures");

  try {
    currentUniqueChangesExact = await getCanonicalUniqueChangeCount(
      format(startDate, "yyyy-MM-dd"),
      format(endDate, "yyyy-MM-dd"),
      filters
    );
  } catch (error) {
    console.error("Canonical unique change count error:", error);
  }

  const currentLeadCommitStats = aggregateLeadTimeFromDailyRows(currentRows, "lead_time_sum", "lead_time_count");
  const previousLeadCommitStats = aggregateLeadTimeFromDailyRows(previousRows, "lead_time_sum", "lead_time_count");
  let currentLeadCommit = currentLeadCommitStats.average;
  let previousLeadCommit = previousLeadCommitStats.average;
  let currentLeadCommitCount = currentLeadCommitStats.count;
  const currentLeadFirstCommitStats = aggregateLeadTimeFromDailyRows(
    currentRows,
    "lead_time_first_commit_sum",
    "lead_time_first_commit_count"
  );
  const previousLeadFirstCommitStats = aggregateLeadTimeFromDailyRows(
    previousRows,
    "lead_time_first_commit_sum",
    "lead_time_first_commit_count"
  );
  let currentLeadFirstCommit = currentLeadFirstCommitStats.average;
  let currentLeadFirstCommitCount = currentLeadFirstCommitStats.count;
  let previousLeadFirstCommit = previousLeadFirstCommitStats.average;
  const currentLeadMrStats = aggregateLeadTimeFromDailyRows(currentRows, "lead_time_mr_sum", "lead_time_mr_count");
  const previousLeadMrStats = aggregateLeadTimeFromDailyRows(previousRows, "lead_time_mr_sum", "lead_time_mr_count");
  let currentLeadMr = currentLeadMrStats.average;
  let currentLeadMrCount = currentLeadMrStats.count;
  let previousLeadMr = previousLeadMrStats.average;
  const currentMttrCount = sum(currentRows, "mttr_count");
  const effectiveCurrentLead = pickPreferredLeadTimeHours(
    currentLeadCommit,
    currentLeadMr,
    currentLeadFirstCommit
  ) ?? 0;
  const effectivePreviousLead = pickPreferredLeadTimeHours(
    previousLeadCommit,
    previousLeadMr,
    previousLeadFirstCommit
  ) ?? 0;

  const currentMttr = averageFromSums(currentRows, "mttr_sum", "mttr_count");
  const previousMttr = averageFromSums(previousRows, "mttr_sum", "mttr_count");

  const leadTimeTraceByDate = new Map<string, LeadTimeTraceDailyRow>();
  const shouldFallbackToTraceLeadTime =
    currentLeadCommitCount === 0 &&
    currentLeadFirstCommitCount === 0 &&
    currentLeadMrCount === 0 &&
    previousLeadCommitStats.count === 0 &&
    previousLeadFirstCommitStats.count === 0 &&
    previousLeadMrStats.count === 0;

  if (shouldFallbackToTraceLeadTime) {
    const leadTimeTraceParams: unknown[] = [format(previousStartDate, "yyyy-MM-dd"), format(endDate, "yyyy-MM-dd")];
    const leadTimeTraceFilters: string[] = [];
    if (filters.teams.length > 0) {
      leadTimeTraceFilters.push(`project_scope.team = ANY($${leadTimeTraceParams.length + 1})`);
      leadTimeTraceParams.push(filters.teams);
    }
    if (filters.projectIds.length > 0) {
      leadTimeTraceFilters.push(`dt.project_id = ANY($${leadTimeTraceParams.length + 1})`);
      leadTimeTraceParams.push(filters.projectIds);
    }
    const leadTimeTraceClause = leadTimeTraceFilters.length > 0
      ? ` AND ${leadTimeTraceFilters.join(" AND ")}`
      : "";

    try {
      const leadTimeTraceResult = await pool.query<LeadTimeTraceDailyRow>(
        `
          WITH project_scope AS (
            SELECT
              project_id,
              MAX(team) AS team
            FROM dora_metrics_daily
            GROUP BY project_id
          ),
          trace_spans AS (
            SELECT
              dt.snapshot_date,
              dt.project_id,
              CASE
                WHEN dt.commit_created_at IS NOT NULL
                THEN EXTRACT(EPOCH FROM (dt.deploy_created_at - dt.commit_created_at)) / 3600.0
                ELSE NULL
              END AS raw_commit_hours,
              CASE
                WHEN dt.mr_first_commit_at IS NOT NULL
                THEN EXTRACT(EPOCH FROM (dt.deploy_created_at - dt.mr_first_commit_at)) / 3600.0
                ELSE NULL
              END AS raw_first_commit_hours,
              CASE
                WHEN dt.mr_created_at IS NOT NULL
                THEN EXTRACT(EPOCH FROM (dt.deploy_created_at - dt.mr_created_at)) / 3600.0
                ELSE NULL
              END AS raw_mr_hours
            FROM deployment_traces dt
            LEFT JOIN project_scope
              ON project_scope.project_id = dt.project_id
            WHERE dt.snapshot_date >= $1
              AND dt.snapshot_date <= $2
              AND (dt.commit_created_at IS NULL OR dt.deploy_created_at - dt.commit_created_at < INTERVAL '90 days')
              ${leadTimeTraceClause}
          )
          SELECT
            snapshot_date,
            COUNT(*) AS trace_deployments,
            SUM(raw_commit_hours) FILTER (
              WHERE raw_commit_hours >= 0 AND raw_commit_hours <= ${LEAD_TIME_GUARD_SQL}
            ) AS lead_time_commit_sum,
            COUNT(*) FILTER (
              WHERE raw_commit_hours >= 0 AND raw_commit_hours <= ${LEAD_TIME_GUARD_SQL}
            ) AS lead_time_commit_count,
            SUM(raw_first_commit_hours) FILTER (
              WHERE raw_first_commit_hours >= 0 AND raw_first_commit_hours <= ${LEAD_TIME_GUARD_SQL}
            ) AS lead_time_first_commit_sum,
            COUNT(*) FILTER (
              WHERE raw_first_commit_hours >= 0 AND raw_first_commit_hours <= ${LEAD_TIME_GUARD_SQL}
            ) AS lead_time_first_commit_count,
            SUM(raw_mr_hours) FILTER (
              WHERE raw_mr_hours >= 0 AND raw_mr_hours <= ${LEAD_TIME_GUARD_SQL}
            ) AS lead_time_mr_sum,
            COUNT(*) FILTER (
              WHERE raw_mr_hours >= 0 AND raw_mr_hours <= ${LEAD_TIME_GUARD_SQL}
            ) AS lead_time_mr_count
          FROM trace_spans
          GROUP BY snapshot_date
          ORDER BY snapshot_date ASC
        `,
        leadTimeTraceParams
      );

      for (const row of leadTimeTraceResult.rows) {
        leadTimeTraceByDate.set(toDateStr(row.snapshot_date), row);
      }

      const currentTraceRows = leadTimeTraceResult.rows.filter((row) => toDateStr(row.snapshot_date) >= cutoffDate);
      const previousTraceRows = leadTimeTraceResult.rows.filter((row) => toDateStr(row.snapshot_date) < cutoffDate);
      const sumLeadTrace = (rows: LeadTimeTraceDailyRow[], field: keyof LeadTimeTraceDailyRow) =>
        rows.reduce((total, row) => total + toNumber(row[field]), 0);
      const averageLeadTrace = (
        rows: LeadTimeTraceDailyRow[],
        sumField: keyof LeadTimeTraceDailyRow,
        countField: keyof LeadTimeTraceDailyRow
      ) => {
        const total = rows.reduce((acc, row) => acc + toNumber(row[sumField]), 0);
        const count = rows.reduce((acc, row) => acc + toNumber(row[countField]), 0);
        return count > 0 ? total / count : 0;
      };

      const currentTraceDeployments = sumLeadTrace(currentTraceRows, "trace_deployments");
      const previousTraceDeployments = sumLeadTrace(previousTraceRows, "trace_deployments");

      if (currentTraceDeployments > 0 || previousTraceDeployments > 0) {
        currentLeadCommit = averageLeadTrace(currentTraceRows, "lead_time_commit_sum", "lead_time_commit_count");
        previousLeadCommit = averageLeadTrace(previousTraceRows, "lead_time_commit_sum", "lead_time_commit_count");
        currentLeadCommitCount = sumLeadTrace(currentTraceRows, "lead_time_commit_count");

        currentLeadFirstCommit = averageLeadTrace(
          currentTraceRows,
          "lead_time_first_commit_sum",
          "lead_time_first_commit_count"
        );
        previousLeadFirstCommit = averageLeadTrace(
          previousTraceRows,
          "lead_time_first_commit_sum",
          "lead_time_first_commit_count"
        );
        currentLeadFirstCommitCount = sumLeadTrace(currentTraceRows, "lead_time_first_commit_count");

        currentLeadMr = averageLeadTrace(currentTraceRows, "lead_time_mr_sum", "lead_time_mr_count");
        previousLeadMr = averageLeadTrace(previousTraceRows, "lead_time_mr_sum", "lead_time_mr_count");
        currentLeadMrCount = sumLeadTrace(currentTraceRows, "lead_time_mr_count");
      }
    } catch (error) {
      console.error("Lead time trace override error:", error);
    }
  }

  const leadTimeReference = resolveLeadTimeReference(
    currentLeadFirstCommitCount,
    currentLeadMrCount,
    currentLeadCommitCount
  );

  const currentFrequency = calculateDeploymentFrequencyPerProjectDay(currentDeployments, currentProjectDays);
  const previousFrequency = calculateDeploymentFrequencyPerProjectDay(previousDeployments, previousProjectDays);

  const currentFailureRate = calculateChangeFailureRatePct(currentDeployments, currentFailureCount);
  const previousFailureRate = calculateChangeFailureRatePct(previousDeployments, previousFailureCount);

  const hasDeveloperScope = filters.developers.length > 0;
  const hasTeamOrProjectScope = filters.teams.length > 0 || filters.projectIds.length > 0;
  const hasScopedFilters = hasTeamOrProjectScope || hasDeveloperScope;

  let effectiveCurrentFailureRate = currentFailureRate;
  let effectivePreviousFailureRate = previousFailureRate;
  let effectiveCurrentMttr = currentMttr;
  let effectivePreviousMttr = previousMttr;

  const correlationTrendByDate = new Map<string, CorrelationTrendRow>();
  const emptyReliabilitySignals: ReliabilitySignalsSummary = {
    available: false,
    scoped: false,
    source: "gitlab",
    cfrSource: "gitlab",
    mttrSource: "gitlab",
    reason: "No hay correlación runtime suficiente para reforzar CFR/MTTR.",
    confidenceThreshold: CORRELATION_MIN_CONFIDENCE,
    minCoveragePct: CORRELATION_MIN_COVERAGE * 100,
    coveragePct: 0,
    previousCoveragePct: 0,
    correlatedDeployments: 0,
    runtimeFailures: 0,
    mttrIncidents: 0,
    averageConfidence: 0,
    hybridChangeFailureRate: metric(currentFailureRate, previousFailureRate),
    hybridMttr: metric(currentMttr, previousMttr),
  };
  let reliabilitySignals: ReliabilitySignalsSummary = { ...emptyReliabilitySignals };

  if (hasDeveloperScope) {
    reliabilitySignals = {
      ...emptyReliabilitySignals,
      scoped: true,
      reason: "El filtro por desarrollador no aplica sobre la correlación runtime; CFR/MTTR se mantienen en modo GitLab.",
    };
  } else {
    try {
      let correlationProjectIds: number[] | null = null;
      if (hasTeamOrProjectScope) {
        const scopedProjectParams: unknown[] = [...baseParams];
        const scopedProjectConditions = [
          "snapshot_date >= $1",
          "snapshot_date <= $2",
        ];
        if (filters.teams.length > 0) {
          scopedProjectConditions.push(`team = ANY($${scopedProjectParams.length + 1})`);
          scopedProjectParams.push(filters.teams);
        }
        if (filters.projectIds.length > 0) {
          scopedProjectConditions.push(`project_id = ANY($${scopedProjectParams.length + 1})`);
          scopedProjectParams.push(filters.projectIds);
        }
        const scopedProjectsResult = await pool.query<{ project_id: number }>(
          `
            SELECT DISTINCT project_id
            FROM dora_metrics_daily
            WHERE ${scopedProjectConditions.join(" AND ")}
          `,
          scopedProjectParams
        );
        correlationProjectIds = scopedProjectsResult.rows
          .map((row) => toNumber(row.project_id))
          .filter((projectId) => projectId > 0);
      }

      if (!correlationProjectIds || correlationProjectIds.length > 0) {
        const correlationParams: unknown[] = [...baseParams, CORRELATION_MIN_CONFIDENCE];
        const projectScopeClause = correlationProjectIds
          ? ` AND gitlab_project_id = ANY($${correlationParams.length + 1})`
          : "";
        if (correlationProjectIds) {
          correlationParams.push(correlationProjectIds);
        }

        const correlationResult = await pool.query<CorrelationDailyRow>(
          `
            WITH correlated_deploys AS (
              SELECT
                correlation_date AS snapshot_date,
                gitlab_project_id,
                gitlab_pipeline_id,
                MAX(COALESCE(argocd_sync_timestamp, gitlab_pipeline_timestamp)) AS runtime_timestamp,
                BOOL_OR(
                  LOWER(COALESCE(argocd_sync_status, '')) IN ('failed', 'error')
                  OR LOWER(COALESCE(argocd_health_status, '')) = 'degraded'
                ) AS runtime_failed,
                AVG(COALESCE(correlation_confidence, 0)) AS avg_confidence
              FROM deployment_correlation
              WHERE correlation_date >= $1
                AND correlation_date <= $2
                AND COALESCE(correlation_confidence, 0) >= $3
                ${projectScopeClause}
              GROUP BY correlation_date, gitlab_project_id, gitlab_pipeline_id
            ),
            ordered AS (
              SELECT
                snapshot_date,
                gitlab_project_id,
                gitlab_pipeline_id,
                runtime_timestamp,
                runtime_failed,
                avg_confidence,
                MIN(runtime_timestamp) FILTER (WHERE NOT runtime_failed) OVER (
                  PARTITION BY gitlab_project_id
                  ORDER BY runtime_timestamp, gitlab_pipeline_id
                  ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
                ) AS next_success_timestamp
              FROM correlated_deploys
              WHERE runtime_timestamp IS NOT NULL
            )
            SELECT
              snapshot_date,
              COUNT(*) AS correlated_deploys,
              COUNT(*) FILTER (WHERE runtime_failed) AS runtime_failures,
              AVG(avg_confidence) AS avg_confidence,
              SUM(
                CASE
                  WHEN runtime_failed
                    AND next_success_timestamp IS NOT NULL
                    AND next_success_timestamp >= runtime_timestamp
                  THEN EXTRACT(EPOCH FROM (next_success_timestamp - runtime_timestamp)) / 3600.0
                  ELSE 0
                END
              ) AS mttr_sum_hours,
              COUNT(*) FILTER (
                WHERE runtime_failed
                  AND next_success_timestamp IS NOT NULL
                  AND next_success_timestamp >= runtime_timestamp
              ) AS mttr_count
            FROM ordered
            GROUP BY snapshot_date
            ORDER BY snapshot_date ASC
          `,
          correlationParams
        );

        for (const row of correlationResult.rows) {
          const date = toDateStr(row.snapshot_date);
          const correlatedDeployments = toNumber(row.correlated_deploys);
          const runtimeFailures = toNumber(row.runtime_failures);
          const mttrSumHours = toNumber(row.mttr_sum_hours);
          const mttrCount = toNumber(row.mttr_count);
          correlationTrendByDate.set(date, {
            date,
            correlatedDeployments,
            runtimeFailures,
            runtimeFailureRate: (correlatedDeployments + runtimeFailures) > 0 ? (runtimeFailures / (correlatedDeployments + runtimeFailures)) * 100 : 0,
            mttrSumHours,
            mttrCount,
            runtimeMttrHours: mttrCount > 0 ? mttrSumHours / mttrCount : 0,
            averageConfidence: toNumber(row.avg_confidence),
          });
        }
      }

      const correlationRows = [...correlationTrendByDate.values()]
        .sort((left, right) => left.date.localeCompare(right.date));
      const currentCorrelationRows = correlationRows.filter((row) => row.date >= cutoffDate);
      const previousCorrelationRows = correlationRows.filter((row) => row.date < cutoffDate);
      const sumCorrelation = (rows: CorrelationTrendRow[], field: keyof CorrelationTrendRow) =>
        rows.reduce((total, row) => total + toNumber(row[field]), 0);

      const currentCorrelatedDeployments = sumCorrelation(currentCorrelationRows, "correlatedDeployments");
      const previousCorrelatedDeployments = sumCorrelation(previousCorrelationRows, "correlatedDeployments");
      const currentRuntimeFailures = sumCorrelation(currentCorrelationRows, "runtimeFailures");
      const previousRuntimeFailures = sumCorrelation(previousCorrelationRows, "runtimeFailures");
      const currentRuntimeMttrSum = sumCorrelation(currentCorrelationRows, "mttrSumHours");
      const previousRuntimeMttrSum = sumCorrelation(previousCorrelationRows, "mttrSumHours");
      const currentRuntimeMttrCount = sumCorrelation(currentCorrelationRows, "mttrCount");
      const previousRuntimeMttrCount = sumCorrelation(previousCorrelationRows, "mttrCount");
      const currentRuntimeFailureRate = (currentCorrelatedDeployments + currentRuntimeFailures) > 0
        ? (currentRuntimeFailures / (currentCorrelatedDeployments + currentRuntimeFailures)) * 100
        : 0;
      const previousRuntimeFailureRate = (previousCorrelatedDeployments + previousRuntimeFailures) > 0
        ? (previousRuntimeFailures / (previousCorrelatedDeployments + previousRuntimeFailures)) * 100
        : 0;
      const currentRuntimeMttr = currentRuntimeMttrCount > 0
        ? currentRuntimeMttrSum / currentRuntimeMttrCount
        : 0;
      const previousRuntimeMttr = previousRuntimeMttrCount > 0
        ? previousRuntimeMttrSum / previousRuntimeMttrCount
        : 0;

      const currentCoverage = currentDeployments > 0
        ? clamp(currentCorrelatedDeployments / currentDeployments, 0, 1)
        : 0;
      const previousCoverage = previousDeployments > 0
        ? clamp(previousCorrelatedDeployments / previousDeployments, 0, 1)
        : 0;
      const currentBlendWeight = CORRELATION_MIN_COVERAGE > 0
        ? clamp(currentCoverage / CORRELATION_MIN_COVERAGE, 0, 1)
        : 1;
      const previousBlendWeight = CORRELATION_MIN_COVERAGE > 0
        ? clamp(previousCoverage / CORRELATION_MIN_COVERAGE, 0, 1)
        : 1;

      const hybridCurrentFailureRate = blend(currentFailureRate, currentRuntimeFailureRate, currentBlendWeight);
      const hybridPreviousFailureRate = blend(previousFailureRate, previousRuntimeFailureRate, previousBlendWeight);
      const hybridCurrentMttr = blend(currentMttr, currentRuntimeMttr, currentBlendWeight);
      const hybridPreviousMttr = blend(previousMttr, previousRuntimeMttr, previousBlendWeight);

      const canUseHybridFailure = currentCorrelatedDeployments >= CORRELATION_MIN_DEPLOYS
        && currentCoverage >= CORRELATION_MIN_COVERAGE;
      const canUseHybridMttr = canUseHybridFailure && currentRuntimeMttrCount > 0;

      if (canUseHybridFailure) {
        effectiveCurrentFailureRate = hybridCurrentFailureRate;
        effectivePreviousFailureRate = hybridPreviousFailureRate;
      }
      if (canUseHybridMttr) {
        effectiveCurrentMttr = hybridCurrentMttr;
        effectivePreviousMttr = hybridPreviousMttr;
      }

      const allCorrelationRows = [...currentCorrelationRows, ...previousCorrelationRows];
      const avgConfidence = allCorrelationRows.length > 0
        ? average(allCorrelationRows.map((row) => row.averageConfidence))
        : 0;

      reliabilitySignals = {
        available: currentCorrelatedDeployments > 0,
        scoped: hasTeamOrProjectScope,
        source: canUseHybridFailure || canUseHybridMttr ? "hybrid" : "gitlab",
        cfrSource: canUseHybridFailure ? "hybrid" : "gitlab",
        mttrSource: canUseHybridMttr ? "hybrid" : "gitlab",
        reason: currentCorrelatedDeployments === 0
          ? (hasTeamOrProjectScope
            ? "No hay correlaciones runtime para el alcance filtrado; CFR/MTTR permanecen en GitLab."
            : "No hay correlaciones runtime recientes; CFR/MTTR permanecen en GitLab.")
          : (canUseHybridFailure
            ? null
            : `Cobertura runtime insuficiente (${(currentCoverage * 100).toFixed(1)}%, mínimo ${(CORRELATION_MIN_COVERAGE * 100).toFixed(1)}%, deploys correlacionados ${Math.round(currentCorrelatedDeployments)} de mínimo ${CORRELATION_MIN_DEPLOYS}).`),
        confidenceThreshold: CORRELATION_MIN_CONFIDENCE,
        minCoveragePct: CORRELATION_MIN_COVERAGE * 100,
        coveragePct: currentCoverage * 100,
        previousCoveragePct: previousCoverage * 100,
        correlatedDeployments: Math.round(currentCorrelatedDeployments),
        runtimeFailures: Math.round(currentRuntimeFailures),
        mttrIncidents: Math.round(currentRuntimeMttrCount),
        averageConfidence: avgConfidence,
        hybridChangeFailureRate: metric(hybridCurrentFailureRate, hybridPreviousFailureRate),
        hybridMttr: metric(hybridCurrentMttr, hybridPreviousMttr),
      };
    } catch (error) {
      const details = error instanceof Error ? error.message : "Unknown error";
      const missingTable = /relation .*deployment_correlation.* does not exist/i.test(details);
      reliabilitySignals = {
        ...emptyReliabilitySignals,
        reason: missingTable
          ? "Tabla deployment_correlation no disponible. Aplica migración 2026-03-03_deployment_correlation.sql."
          : `No se pudo calcular la capa híbrida CFR/MTTR: ${details}`,
      };
    }
  }

  const k8sFilterParams: unknown[] = [...baseParams];
  const k8sScopedFilters: string[] = [];

  if (filters.teams.length > 0) {
    k8sScopedFilters.push(`team = ANY($${k8sFilterParams.length + 1})`);
    k8sFilterParams.push(filters.teams);
  }
  if (filters.projectIds.length > 0) {
    k8sScopedFilters.push(`project_id = ANY($${k8sFilterParams.length + 1})`);
    k8sFilterParams.push(filters.projectIds);
  }
  const k8sScopedClause = k8sScopedFilters.length > 0
    ? ` AND ${k8sScopedFilters.join(" AND ")}`
    : "";

  const emptyClusterSignals: ClusterSignalsSummary = {
    available: false,
    scoped: false,
    reason: "No hay señales de cluster disponibles para este alcance.",
    daysWithData: 0,
    totals: {
      rollouts: 0,
      failedWorkloads: 0,
      unavailableReplicas: 0,
      containerRestarts: 0,
      totalApps: 0,
      healthyApps: 0,
      degradedApps: 0,
      outOfSyncApps: 0,
    },
    rolloutsPerDay: metric(0, 0),
    failedWorkloadsPerDay: metric(0, 0),
    degradedAppsPerDay: metric(0, 0),
    healthRate: metric(0, 0),
    outOfSyncAppsPerDay: metric(0, 0),
  };

  let clusterSignals: ClusterSignalsSummary = { ...emptyClusterSignals };
  const clusterTrendByDate = new Map<string, ClusterTrendRow>();

  if (!includeClusterSignals) {
    clusterSignals = {
      ...emptyClusterSignals,
      reason: "Señales de Kubernetes omitidas para esta consulta.",
    };
  } else if (hasDeveloperScope) {
    clusterSignals = {
      ...emptyClusterSignals,
      scoped: true,
      reason: "Las señales de Kubernetes no admiten filtro por desarrollador; usa filtros de team/proyecto o vista global.",
    };
  } else {
    try {
    const healthGlobalOnly = hasScopedFilters;

    const [rolloutResult, failureResult, healthResult] = await Promise.all([
      pool.query<K8sRolloutRow>(
        `
          SELECT
            snapshot_date,
            SUM(rollout_count) AS rollouts,
            COUNT(DISTINCT namespace || '/' || deployment) AS workloads,
            COUNT(DISTINCT namespace) AS namespaces
          FROM k8s_rollouts_daily
          WHERE snapshot_date >= $1 AND snapshot_date <= $2
          ${k8sScopedClause}
          GROUP BY snapshot_date
          ORDER BY snapshot_date ASC
        `,
        k8sFilterParams
      ),
      pool.query<K8sFailureRow>(
        `
          SELECT
            snapshot_date,
            COUNT(*) FILTER (WHERE unavailable_replicas > 0 OR container_restarts > 10) AS failed_workloads,
            SUM(unavailable_replicas) AS unavailable_replicas,
            SUM(container_restarts) AS container_restarts
          FROM k8s_failures_daily
          WHERE snapshot_date >= $1 AND snapshot_date <= $2
          ${k8sScopedClause}
          GROUP BY snapshot_date
          ORDER BY snapshot_date ASC
        `,
        k8sFilterParams
      ),
      healthGlobalOnly
        ? Promise.resolve({ rows: [] as ArgocdHealthRow[] })
        : pool.query<ArgocdHealthRow>(
            `
              SELECT
                snapshot_date,
                COUNT(*) AS total_apps,
                COUNT(*) FILTER (WHERE health_status = 'Healthy') AS healthy_apps,
                COUNT(*) FILTER (WHERE health_status = 'Degraded') AS degraded_apps,
                COUNT(*) FILTER (WHERE sync_status = 'OutOfSync') AS out_of_sync_apps
              FROM argocd_health_daily
              WHERE snapshot_date >= $1 AND snapshot_date <= $2
              GROUP BY snapshot_date
              ORDER BY snapshot_date ASC
            `,
            baseParams
          ),
    ]);

    const ensureClusterRow = (date: string): ClusterTrendRow => {
      if (!clusterTrendByDate.has(date)) {
        clusterTrendByDate.set(date, {
          date,
          rollouts: 0,
          workloads: 0,
          namespaces: 0,
          failedWorkloads: 0,
          unavailableReplicas: 0,
          containerRestarts: 0,
          totalApps: 0,
          healthyApps: 0,
          degradedApps: 0,
          outOfSyncApps: 0,
        });
      }
      return clusterTrendByDate.get(date)!;
    };

    for (const row of rolloutResult.rows) {
      const date = toDateStr(row.snapshot_date);
      const target = ensureClusterRow(date);
      target.rollouts = toNumber(row.rollouts);
      target.workloads = toNumber(row.workloads);
      target.namespaces = toNumber(row.namespaces);
    }

    for (const row of failureResult.rows) {
      const date = toDateStr(row.snapshot_date);
      const target = ensureClusterRow(date);
      target.failedWorkloads = toNumber(row.failed_workloads);
      target.unavailableReplicas = toNumber(row.unavailable_replicas);
      target.containerRestarts = toNumber(row.container_restarts);
    }

    for (const row of healthResult.rows) {
      const date = toDateStr(row.snapshot_date);
      const target = ensureClusterRow(date);
      target.totalApps = toNumber(row.total_apps);
      target.healthyApps = toNumber(row.healthy_apps);
      target.degradedApps = toNumber(row.degraded_apps);
      target.outOfSyncApps = toNumber(row.out_of_sync_apps);
    }

    const clusterRows = [...clusterTrendByDate.values()].sort((left, right) => left.date.localeCompare(right.date));
    const currentClusterRows = clusterRows.filter((row) => row.date >= cutoffDate);
    const previousClusterRows = clusterRows.filter((row) => row.date < cutoffDate);

    const sumCluster = (rows: ClusterTrendRow[], field: keyof ClusterTrendRow) =>
      rows.reduce((total, row) => total + toNumber(row[field]), 0);

    const currentRollouts = sumCluster(currentClusterRows, "rollouts");
    const previousRollouts = sumCluster(previousClusterRows, "rollouts");
    const currentFailedWorkloads = sumCluster(currentClusterRows, "failedWorkloads");
    const previousFailedWorkloads = sumCluster(previousClusterRows, "failedWorkloads");
    const currentDegradedApps = sumCluster(currentClusterRows, "degradedApps");
    const previousDegradedApps = sumCluster(previousClusterRows, "degradedApps");
    const currentOutOfSyncApps = sumCluster(currentClusterRows, "outOfSyncApps");
    const previousOutOfSyncApps = sumCluster(previousClusterRows, "outOfSyncApps");
    const currentTotalApps = sumCluster(currentClusterRows, "totalApps");
    const previousTotalApps = sumCluster(previousClusterRows, "totalApps");
    const currentHealthyApps = sumCluster(currentClusterRows, "healthyApps");
    const previousHealthyApps = sumCluster(previousClusterRows, "healthyApps");

    const currentDays = currentClusterRows.length;
    const previousDays = previousClusterRows.length;
    const currentHealthRate = currentTotalApps > 0 ? (currentHealthyApps / currentTotalApps) * 100 : 0;
    const previousHealthRate = previousTotalApps > 0 ? (previousHealthyApps / previousTotalApps) * 100 : 0;

    clusterSignals = {
      available: currentDays > 0,
      scoped: hasScopedFilters,
      reason: currentDays > 0
        ? (hasScopedFilters
          ? "Scope parcial: los indicadores de salud ArgoCD aún se muestran solo en vista global."
          : null)
        : (hasScopedFilters
          ? "No hay snapshots de Kubernetes mapeados para el alcance filtrado."
          : "Todavía no hay snapshots de Kubernetes para el periodo seleccionado."),
      daysWithData: currentDays,
      totals: {
        rollouts: Math.round(currentRollouts),
        failedWorkloads: Math.round(currentFailedWorkloads),
        unavailableReplicas: Math.round(sumCluster(currentClusterRows, "unavailableReplicas")),
        containerRestarts: Math.round(sumCluster(currentClusterRows, "containerRestarts")),
        totalApps: Math.round(currentTotalApps),
        healthyApps: Math.round(currentHealthyApps),
        degradedApps: Math.round(currentDegradedApps),
        outOfSyncApps: Math.round(currentOutOfSyncApps),
      },
      rolloutsPerDay: metric(
        currentDays > 0 ? currentRollouts / currentDays : 0,
        previousDays > 0 ? previousRollouts / previousDays : 0
      ),
      failedWorkloadsPerDay: metric(
        currentDays > 0 ? currentFailedWorkloads / currentDays : 0,
        previousDays > 0 ? previousFailedWorkloads / previousDays : 0
      ),
      degradedAppsPerDay: metric(
        currentDays > 0 ? currentDegradedApps / currentDays : 0,
        previousDays > 0 ? previousDegradedApps / previousDays : 0
      ),
      healthRate: metric(currentHealthRate, previousHealthRate),
      outOfSyncAppsPerDay: metric(
        currentDays > 0 ? currentOutOfSyncApps / currentDays : 0,
        previousDays > 0 ? previousOutOfSyncApps / previousDays : 0
      ),
    };
    } catch (error) {
      const details = error instanceof Error ? error.message : "Unknown error";
      const missingTables = /relation .* does not exist/i.test(details);
      clusterSignals = {
        ...emptyClusterSignals,
        reason: missingTables
          ? "Faltan tablas de snapshots/mapeo de Kubernetes. Aplica migraciones 2026-03-04_k8s_metrics_tables.sql y 2026-03-05_k8s_workload_mapping.sql."
          : `No se pudieron cargar señales de Kubernetes: ${details}`,
      };
    }
  }

  const traceabilityParams: unknown[] = [format(startDate, "yyyy-MM-dd"), format(endDate, "yyyy-MM-dd")];
  const traceabilityFilters: string[] = [];
  if (filters.teams.length > 0) {
    traceabilityFilters.push(`project_scope.team = ANY($${traceabilityParams.length + 1})`);
    traceabilityParams.push(filters.teams);
  }
  if (filters.projectIds.length > 0) {
    traceabilityFilters.push(`dt.project_id = ANY($${traceabilityParams.length + 1})`);
    traceabilityParams.push(filters.projectIds);
  }
  const traceabilityClause = traceabilityFilters.length > 0
    ? ` AND ${traceabilityFilters.join(" AND ")}`
    : "";

  let traceability: DoraTraceabilitySummary = {
    available: false,
    reason: "No hay despliegues trazados en el periodo seleccionado.",
    leadTimeGuardHours: LEAD_TIME_GUARD_HOURS,
    deployments: 0,
    deploymentsWithMr: 0,
    uniqueCommits: 0,
    uniqueMrs: 0,
    averageMrCommitCount: 0,
    leadTimeSamples: {
      firstCommit: 0,
      mr: 0,
      lastCommit: 0,
    },
    discardedOutliers: {
      firstCommit: 0,
      mr: 0,
      lastCommit: 0,
    },
    recentDeployments: [],
  };

  try {
    const [traceabilitySummaryResult, traceabilityRecentResult] = await Promise.all([
      pool.query<TraceabilitySummaryRow>(
        `
          WITH project_scope AS (
            SELECT
              project_id,
              MAX(team) AS team
            FROM dora_metrics_daily
            GROUP BY project_id
          )
          SELECT
            COUNT(*) AS deployments,
            COUNT(*) FILTER (WHERE dt.mr_id IS NOT NULL OR dt.mr_iid IS NOT NULL) AS deployments_with_mr,
            COUNT(DISTINCT dt.commit_sha) FILTER (WHERE dt.commit_sha IS NOT NULL) AS unique_commits,
            COUNT(DISTINCT COALESCE(dt.mr_id::text, dt.project_id::text || '-' || dt.mr_iid::text))
              FILTER (WHERE dt.mr_id IS NOT NULL OR dt.mr_iid IS NOT NULL) AS unique_mrs,
            AVG(NULLIF(dt.mr_commit_count, 0)) AS avg_mr_commit_count,
            COUNT(*) FILTER (WHERE dt.lead_time_first_commit_hours IS NOT NULL) AS first_commit_samples,
            COUNT(*) FILTER (WHERE dt.lead_time_mr_hours IS NOT NULL) AS mr_samples,
            COUNT(*) FILTER (WHERE dt.lead_time_commit_hours IS NOT NULL) AS commit_samples,
            COUNT(*) FILTER (
              WHERE dt.mr_first_commit_at IS NOT NULL
                AND EXTRACT(EPOCH FROM (dt.deploy_created_at - dt.mr_first_commit_at)) / 3600.0 > ${LEAD_TIME_GUARD_SQL}
            ) AS first_commit_discarded,
            COUNT(*) FILTER (
              WHERE dt.mr_created_at IS NOT NULL
                AND EXTRACT(EPOCH FROM (dt.deploy_created_at - dt.mr_created_at)) / 3600.0 > ${LEAD_TIME_GUARD_SQL}
            ) AS mr_discarded,
            COUNT(*) FILTER (
              WHERE dt.commit_created_at IS NOT NULL
                AND EXTRACT(EPOCH FROM (dt.deploy_created_at - dt.commit_created_at)) / 3600.0 > ${LEAD_TIME_GUARD_SQL}
            ) AS commit_discarded
          FROM deployment_traces dt
          LEFT JOIN project_scope
            ON project_scope.project_id = dt.project_id
          WHERE dt.snapshot_date >= $1
            AND dt.snapshot_date <= $2
            AND (dt.commit_created_at IS NULL OR dt.deploy_created_at - dt.commit_created_at < INTERVAL '90 days')
            ${traceabilityClause}
        `,
        traceabilityParams
      ),
      pool.query<TraceabilityRecentRow>(
        `
          WITH project_scope AS (
            SELECT
              project_id,
              MAX(team) AS team
            FROM dora_metrics_daily
            GROUP BY project_id
          )
          SELECT
            dt.snapshot_date,
            project_scope.team,
            dt.project_id,
            dt.project_name,
            dt.commit_sha,
            dt.commit_created_at,
            dt.commit_author_email,
            dt.mr_id,
            dt.mr_iid,
            dt.mr_created_at,
            dt.mr_merged_at,
            dt.mr_title,
            dt.mr_source_branch,
            dt.mr_first_commit_at,
            dt.mr_last_commit_at,
            dt.mr_commit_count,
            dt.deploy_id,
            dt.deploy_created_at,
            dt.deploy_type,
            dt.deploy_type_reason,
            dt.deploy_environment,
            dt.lead_time_commit_hours,
            dt.lead_time_mr_hours,
            dt.lead_time_first_commit_hours,
            CASE
              WHEN dt.commit_created_at IS NOT NULL
              THEN EXTRACT(EPOCH FROM (dt.deploy_created_at - dt.commit_created_at)) / 3600.0
              ELSE NULL
            END AS raw_commit_span_hours,
            CASE
              WHEN dt.mr_created_at IS NOT NULL
              THEN EXTRACT(EPOCH FROM (dt.deploy_created_at - dt.mr_created_at)) / 3600.0
              ELSE NULL
            END AS raw_mr_span_hours,
            CASE
              WHEN dt.mr_first_commit_at IS NOT NULL
              THEN EXTRACT(EPOCH FROM (dt.deploy_created_at - dt.mr_first_commit_at)) / 3600.0
              ELSE NULL
            END AS raw_first_commit_span_hours
          FROM deployment_traces dt
          LEFT JOIN project_scope
            ON project_scope.project_id = dt.project_id
          WHERE dt.snapshot_date >= $1
            AND dt.snapshot_date <= $2
            AND (dt.commit_created_at IS NULL OR dt.deploy_created_at - dt.commit_created_at < INTERVAL '90 days')
            ${traceabilityClause}
          ORDER BY dt.deploy_created_at DESC
          LIMIT 8
        `,
        traceabilityParams
      ),
    ]);

    const traceabilityRow = traceabilitySummaryResult.rows[0];
    const deployments = toNumber(traceabilityRow?.deployments);

    traceability = {
      available: deployments > 0,
      reason: deployments > 0 ? null : "No hay despliegues trazados en el periodo seleccionado.",
      leadTimeGuardHours: LEAD_TIME_GUARD_HOURS,
      deployments,
      deploymentsWithMr: toNumber(traceabilityRow?.deployments_with_mr),
      uniqueCommits: toNumber(traceabilityRow?.unique_commits),
      uniqueMrs: toNumber(traceabilityRow?.unique_mrs),
      averageMrCommitCount: toNumber(traceabilityRow?.avg_mr_commit_count),
      leadTimeSamples: {
        firstCommit: toNumber(traceabilityRow?.first_commit_samples),
        mr: toNumber(traceabilityRow?.mr_samples),
        lastCommit: toNumber(traceabilityRow?.commit_samples),
      },
      discardedOutliers: {
        firstCommit: toNumber(traceabilityRow?.first_commit_discarded),
        mr: toNumber(traceabilityRow?.mr_discarded),
        lastCommit: toNumber(traceabilityRow?.commit_discarded),
      },
      recentDeployments: traceabilityRecentResult.rows.map((row) => {
        const rawFirstCommitHours = nullableNumber(row.raw_first_commit_span_hours);
        const rawMrHours = nullableNumber(row.raw_mr_span_hours);
        const rawCommitHours = nullableNumber(row.raw_commit_span_hours);
        return {
          snapshotDate: row.snapshot_date,
          team: row.team,
          projectId: toNumber(row.project_id),
          projectName: row.project_name || String(row.project_id),
          deployId: row.deploy_id,
          deployCreatedAt: row.deploy_created_at,
          deployType: (row.deploy_type || "feature") as "feature" | "hotfix" | "rollback",
          deployTypeReason: row.deploy_type_reason,
          deployEnvironment: row.deploy_environment,
          commitSha: row.commit_sha,
          commitCreatedAt: row.commit_created_at,
          commitAuthorEmail: row.commit_author_email,
          mrId: nullableInt(row.mr_id),
          mrIid: nullableInt(row.mr_iid),
          mrCreatedAt: row.mr_created_at,
          mrMergedAt: row.mr_merged_at,
          mrTitle: row.mr_title,
          mrSourceBranch: row.mr_source_branch,
          mrFirstCommitAt: row.mr_first_commit_at,
          mrLastCommitAt: row.mr_last_commit_at,
          mrCommitCount: toNumber(row.mr_commit_count),
          leadTimes: {
            firstCommitHours: nullableNumber(row.lead_time_first_commit_hours),
            mrHours: nullableNumber(row.lead_time_mr_hours),
            lastCommitHours: nullableNumber(row.lead_time_commit_hours),
          },
          rawLeadTimes: {
            firstCommitHours: rawFirstCommitHours,
            mrHours: rawMrHours,
            lastCommitHours: rawCommitHours,
          },
          discarded: {
            firstCommit: rawFirstCommitHours !== null && rawFirstCommitHours > LEAD_TIME_GUARD_HOURS,
            mr: rawMrHours !== null && rawMrHours > LEAD_TIME_GUARD_HOURS,
            lastCommit: rawCommitHours !== null && rawCommitHours > LEAD_TIME_GUARD_HOURS,
          },
        };
      }),
    };
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown error";
    traceability = {
      ...traceability,
      reason: /relation .*deployment_traces.* does not exist/i.test(details)
        ? "La tabla deployment_traces no está disponible; aplica las migraciones de trazabilidad DORA."
        : `No se pudo cargar la trazabilidad de despliegues: ${details}`,
    };
  }

  const compliance = await getServiceComplianceSummary(
    format(startDate, "yyyy-MM-dd"),
    format(endDate, "yyyy-MM-dd"),
    filters
  );
  const productionIntegrity = await getProductionIntegritySummary(startDate, endDate, filters);
  const totalDiscardedLeadSamples =
    traceability.discardedOutliers.firstCommit
    + traceability.discardedOutliers.mr
    + traceability.discardedOutliers.lastCommit;
  const traceabilityCoveragePct = productionIntegrity.totalDeployments > 0
    ? (productionIntegrity.deploymentsWithTrace / productionIntegrity.totalDeployments) * 100
    : 0;
  const discardedLeadSampleBase =
    traceability.leadTimeSamples.firstCommit
    + traceability.leadTimeSamples.mr
    + traceability.leadTimeSamples.lastCommit
    + totalDiscardedLeadSamples;
  const discardedLeadPct = discardedLeadSampleBase > 0
    ? (totalDiscardedLeadSamples / discardedLeadSampleBase) * 100
    : 0;

  // ---------------------------------------------------------------------------
  // Author scoping (Author_Filter applied).
  //
  // ZERO REGRESSION: when `filters.authors` is empty, `authorScopeIsActive` is
  // false, no author query runs, no override/flag is set, and every metric and
  // audit check stays IDENTICAL to the behavior before this feature. Author
  // scoping is applied ONLY when at least one author is selected.
  // ---------------------------------------------------------------------------
  const authorFilter = normalizeAuthorFilter(filters.authors);
  const authorScopeIsActive = authorFilter.size > 0;
  const ATTRIBUTION_COVERAGE_THRESHOLD = 80.0;

  let authorScope: DoraAuthorScope = {
    authors: [],
    attributionCoverage: null,
    attributionCoverageThreshold: ATTRIBUTION_COVERAGE_THRESHOLD,
    active: false,
  };
  let deploymentLevelFlags: DoraDeploymentLevelFlags = {
    changeFailureRate: false,
    pipelineRecoveryTime: false,
  };
  // Author-attributed overrides (only set when the filter is active).
  let attributedDeploymentFrequency: TrendMetric | null = null;
  let attributedLeadTime: TrendMetric | DoraNotAvailable | null = null;
  let deploymentLevelChangeFailureRate: TrendMetric | DoraNotAvailable | null = null;
  let deploymentLevelMttr: TrendMetric | DoraNotAvailable | null = null;
  let authorAttributionCheck: AuditCheck | null = null;

  if (authorScopeIsActive) {
    const changeRows = await getDeploymentChangeRows(
      format(startDate, "yyyy-MM-dd"),
      format(endDate, "yyyy-MM-dd"),
      filters
    );
    const authorKeyByRow = resolveChangeAuthorKeys(changeRows);
    const authorship = buildDeploymentAuthorship(changeRows);

    // Deployment Frequency: attributed count (deploy counted exactly once),
    // 0 when no deployment includes a change of the selected authors.
    const attributedDeployments = countAttributedDeployments(authorship, authorFilter);
    attributedDeploymentFrequency = metric(attributedDeployments, attributedDeployments);

    // Lead Time: median of the first_commit lead times of the author's changes;
    // explicit "not available" (never inherits the no-author scope value) when
    // there are no attributable changes.
    const authorLeadTimes = selectAuthorLeadTimes(
      changeRows,
      authorKeyByRow,
      authorFilter,
      LEAD_TIME_GUARD_HOURS
    );
    const authorLeadMedian = authorMedian(authorLeadTimes);
    attributedLeadTime =
      authorLeadMedian === null
        ? { available: false }
        : metric(authorLeadMedian, authorLeadMedian);

    // CFR & Pipeline Recovery Time: deployment/pipeline level — SQL untouched.
    // Reuse the scope-level `(date ∩ team ∩ project)` values, mark them with the
    // deploymentLevel flags, and surface "not available" when the scope has no
    // deployments/pipelines (never 0).
    deploymentLevelFlags = { changeFailureRate: true, pipelineRecoveryTime: true };
    const scopeHasDeployments = currentDeployments > 0;
    deploymentLevelChangeFailureRate = scopeHasDeployments
      ? metric(effectiveCurrentFailureRate, effectivePreviousFailureRate)
      : { available: false };
    deploymentLevelMttr = scopeHasDeployments
      ? metric(effectiveCurrentMttr, effectivePreviousMttr)
      : { available: false };

    // Author_Attribution_Coverage over ALL in-scope deployments (best-effort).
    const coverage = authorAttributionCoverage(authorship);

    // Readable author list for the applied filter (canonical key → display name).
    const selectable = listSelectableAuthors(changeRows);
    const nameByKey = new Map(selectable.map((author) => [author.canonicalKey, author.name]));
    const appliedAuthors = [...authorFilter]
      .sort()
      .map((key) => ({ key, name: nameByKey.get(key) ?? key }));

    authorScope = {
      authors: appliedAuthors,
      attributionCoverage: coverage,
      attributionCoverageThreshold: ATTRIBUTION_COVERAGE_THRESHOLD,
      active: true,
    };

    authorAttributionCheck = createAuditCheck(
      "author_attribution_coverage",
      "Cobertura de atribución por autor",
      coverage === null ? "info" : coverage >= ATTRIBUTION_COVERAGE_THRESHOLD ? "pass" : "warn",
      coverage === null ? "n/d" : `${coverage.toFixed(1)}%`,
      "% de despliegues del alcance con autoría resoluble desde deployment_changes."
    );
  }

  const doraAudit = buildAuditSummary({
    methodologyVersion: "dora-gitlab-v2.4",
    sourceOfTruth: "GitLab canónico sobre production_deployments, deployment_changes y deployment_traces; runtime solo ajusta CFR/MTTR cuando la correlación es suficiente.",
    note: "Deployment Frequency usa despliegues exitosos a producción; Lead Time prioriza último commit, luego MR y por último primer commit. CFR y MTTR siguen siendo proxies técnicos basados en GitLab, con refuerzo runtime cuando la cobertura lo permite.",
    coverageLabel: "Cobertura trazable",
    coveragePct: traceabilityCoveragePct,
    checks: [
      createAuditCheck(
        "deploys_without_changes",
        "Deploys sin changes",
        productionIntegrity.deploymentsWithoutChanges === 0
          ? "pass"
          : productionIntegrity.deploymentsWithoutChanges <= 2
            ? "warn"
            : "fail",
        String(productionIntegrity.deploymentsWithoutChanges),
        productionIntegrity.totalDeployments > 0
          ? `${productionIntegrity.deploymentsWithoutChanges}/${productionIntegrity.totalDeployments} despliegues productivos no tienen filas en deployment_changes.`
          : "No hay despliegues productivos canónicos en el alcance actual."
      ),
      createAuditCheck(
        "duplicate_gitlab_jobs",
        "Jobs GitLab duplicados",
        productionIntegrity.duplicateJobRecords === 0
          ? "pass"
          : productionIntegrity.duplicateJobRecords <= 2
            ? "warn"
            : "fail",
        String(productionIntegrity.duplicateJobRecords),
        "Registros de production_deployments que repiten el mismo gitlab_job_id dentro del alcance actual."
      ),
      createAuditCheck(
        "traceability_coverage",
        "Cobertura de trazas",
        traceabilityCoveragePct >= 85
          ? "pass"
          : traceabilityCoveragePct >= 60
            ? "warn"
            : "fail",
        `${traceabilityCoveragePct.toFixed(1)}%`,
        `${productionIntegrity.deploymentsWithTrace}/${productionIntegrity.totalDeployments || 0} despliegues productivos canónicos tienen traza utilizable para lead time.`
      ),
      createAuditCheck(
        "lead_time_guard_discards",
        "Descartes guard rail",
        discardedLeadPct <= 5
          ? "pass"
          : discardedLeadPct <= 15
            ? "warn"
            : "fail",
        totalDiscardedLeadSamples > 0 ? `${totalDiscardedLeadSamples}` : "0",
        `Se descartaron ${totalDiscardedLeadSamples} spans por superar ${Math.round(LEAD_TIME_GUARD_HOURS / 24)} días (${discardedLeadPct.toFixed(1)}% de la muestra bruta).`
      ),
      createAuditCheck(
        "runtime_correlation",
        "Cobertura runtime",
        !reliabilitySignals.available
          ? "info"
          : reliabilitySignals.coveragePct >= CORRELATION_MIN_COVERAGE * 100
            ? "pass"
            : reliabilitySignals.coveragePct >= 15
              ? "warn"
              : "info",
        `${reliabilitySignals.coveragePct.toFixed(1)}%`,
        reliabilitySignals.available
          ? `Cobertura de correlación runtime para CFR/MTTR híbridos, con confianza media del ${(reliabilitySignals.averageConfidence * 100).toFixed(1)}%.`
          : reliabilitySignals.reason || "No hay correlación runtime disponible para este alcance."
      ),
      ...(authorAttributionCheck ? [authorAttributionCheck] : []),
    ],
  });

  // Build a lookup of currentRows by date for gap-filling
  const currentRowsByDate = new Map<string, DoraDailyRow>();
  for (const row of currentRows) {
    currentRowsByDate.set(toDateStr(row.snapshot_date), row);
  }

  // Generate all dates from startDate to endDate (inclusive)
  const allDates: string[] = [];
  {
    let cursor = new Date(startDate);
    const end = new Date(endDate);
    while (cursor <= end) {
      allDates.push(format(cursor, "yyyy-MM-dd"));
      cursor = addDays(cursor, 1);
    }
  }

  const buildTrendEntry = (row: DoraDailyRow, date: string) => {
    const deployments = toNumber(row.deployments);
    const failures = toNumber(row.failures);
    const projectCount = toNumber(row.project_count);
    const cluster = clusterTrendByDate.get(date);
    const correlation = correlationTrendByDate.get(date);
    const leadTimeTrace = leadTimeTraceByDate.get(date);
    const gitlabFailureRate = calculateChangeFailureRatePct(deployments, failures);
    const gitlabMttrHours = averageFromRow(row, "mttr_sum", "mttr_count");
    const leadTimeCommitHours = leadTimeTrace
      ? averageFromLeadTraceRow(leadTimeTrace, "lead_time_commit_sum", "lead_time_commit_count")
      : averageLeadTimeFromDailyRow(row, "lead_time_sum", "lead_time_count");
    const leadTimeFirstCommitHours = leadTimeTrace
      ? averageFromLeadTraceRow(leadTimeTrace, "lead_time_first_commit_sum", "lead_time_first_commit_count")
      : averageLeadTimeFromDailyRow(row, "lead_time_first_commit_sum", "lead_time_first_commit_count");
    const leadTimeMrHours = leadTimeTrace
      ? averageFromLeadTraceRow(leadTimeTrace, "lead_time_mr_sum", "lead_time_mr_count")
      : averageLeadTimeFromDailyRow(row, "lead_time_mr_sum", "lead_time_mr_count");
    const runtimeFailureRate = correlation?.runtimeFailureRate || 0;
    const runtimeMttrHours = correlation?.runtimeMttrHours || 0;
    const correlatedDeployments = correlation?.correlatedDeployments || 0;
    const runtimeFailures = correlation?.runtimeFailures || 0;
    const gitlabMttrIncidents = toNumber(row.mttr_count);
    const runtimeMttrIncidents = correlation?.mttrCount || 0;
    const coverage = deployments > 0 ? clamp(correlatedDeployments / deployments, 0, 1) : 0;
    const blendWeight = CORRELATION_MIN_COVERAGE > 0
      ? clamp(coverage / CORRELATION_MIN_COVERAGE, 0, 1)
      : 1;
    const blendedFailureRate = blend(gitlabFailureRate, runtimeFailureRate, blendWeight);
    const blendedMttrHours = correlation && correlation.mttrCount > 0
      ? blend(gitlabMttrHours, runtimeMttrHours, blendWeight)
      : gitlabMttrHours;
    const useHybridFailure = reliabilitySignals.cfrSource === "hybrid"
      && coverage >= CORRELATION_MIN_COVERAGE;
    const useHybridMttr = reliabilitySignals.mttrSource === "hybrid"
      && coverage >= CORRELATION_MIN_COVERAGE
      && Boolean(correlation && correlation.mttrCount > 0);

    return {
      date,
      deploymentFrequency: calculateDeploymentFrequencyPerProjectDay(deployments, projectCount),
      deployments,
      uniqueDeployments: toNumber(row.unique_deployments),
      rollbacks: toNumber(row.rollbacks),
      hotfixes: toNumber(row.hotfixes),
      features: toNumber(row.features),
      leadTimeHours: leadTimeCommitHours,
      leadTimeEffectiveHours: pickPreferredLeadTimeHours(
        leadTimeCommitHours,
        leadTimeMrHours,
        leadTimeFirstCommitHours
      ) ?? 0,
      leadTimeFirstCommitHours,
      leadTimeMrHours,
      changeFailureRate: useHybridFailure ? blendedFailureRate : gitlabFailureRate,
      mttrHours: useHybridMttr ? blendedMttrHours : gitlabMttrHours,
      gitlabFailures: failures,
      gitlabChangeFailureRate: gitlabFailureRate,
      runtimeFailures,
      gitlabMttrHours,
      gitlabMttrIncidents,
      runtimeChangeFailureRate: runtimeFailureRate,
      runtimeMttrHours,
      runtimeMttrIncidents,
      correlatedDeployments,
      correlationCoverage: coverage * 100,
      correlationConfidence: correlation?.averageConfidence || 0,
      cfrSource: useHybridFailure ? "hybrid" : "gitlab",
      mttrSource: useHybridMttr ? "hybrid" : "gitlab",
      clusterRollouts: cluster?.rollouts || 0,
      clusterFailedWorkloads: cluster?.failedWorkloads || 0,
      clusterDegradedApps: cluster?.degradedApps || 0,
      clusterOutOfSyncApps: cluster?.outOfSyncApps || 0,
      clusterHealthRate: cluster?.totalApps
        ? (cluster.healthyApps / cluster.totalApps) * 100
        : 0,
      projects: projectCount,
    };
  };

  const trend = allDates.map((date) => {
    const row = currentRowsByDate.get(date);
    if (row) {
      return buildTrendEntry(row, date);
    }
    // Day without snapshot data — insert null values so charts break the line
    return {
      date,
      deploymentFrequency: null,
      deployments: null,
      uniqueDeployments: null,
      rollbacks: null,
      hotfixes: null,
      features: null,
      leadTimeHours: null,
      leadTimeEffectiveHours: null,
      leadTimeFirstCommitHours: null,
      leadTimeMrHours: null,
      changeFailureRate: null,
      mttrHours: null,
      gitlabFailures: null,
      gitlabChangeFailureRate: null,
      runtimeFailures: null,
      gitlabMttrHours: null,
      gitlabMttrIncidents: null,
      runtimeChangeFailureRate: null,
      runtimeMttrHours: null,
      runtimeMttrIncidents: null,
      correlatedDeployments: null,
      correlationCoverage: null,
      correlationConfidence: null,
      cfrSource: null,
      mttrSource: null,
      clusterRollouts: null,
      clusterFailedWorkloads: null,
      clusterDegradedApps: null,
      clusterOutOfSyncApps: null,
      clusterHealthRate: null,
      projects: null,
    };
  });

  return {
    summary: {
      deploymentFrequency:
        authorScopeIsActive && attributedDeploymentFrequency
          ? attributedDeploymentFrequency
          : metric(currentFrequency, previousFrequency),
      leadTimeForChanges:
        authorScopeIsActive && attributedLeadTime
          ? attributedLeadTime
          : metric(effectiveCurrentLead, effectivePreviousLead),
      leadTimeCommit: metric(currentLeadCommit, previousLeadCommit),
      leadTimeFirstCommit: metric(currentLeadFirstCommit, previousLeadFirstCommit),
      leadTimeFromMr: metric(currentLeadMr, previousLeadMr),
      changeFailureRate:
        authorScopeIsActive && deploymentLevelChangeFailureRate
          ? deploymentLevelChangeFailureRate
          : metric(effectiveCurrentFailureRate, effectivePreviousFailureRate),
      mttr:
        authorScopeIsActive && deploymentLevelMttr
          ? deploymentLevelMttr
          : metric(effectiveCurrentMttr, effectivePreviousMttr),
      authorScope,
      deploymentLevel: deploymentLevelFlags,
      anomalies: {
        deploymentFrequency: isAnomalousDeploymentFrequency(currentFrequency),
      },
      totals: {
        deployments: Math.round(currentDeployments),
        uniqueDeployments: Math.round(currentUniqueChangesExact),
        rollbacks: Math.round(currentRollbacks),
        hotfixes: Math.round(currentHotfixes),
        features: Math.round(currentFeatures),
        failures: Math.round(currentFailureCount),
      },
      methodology: {
        leadTimeReference,
        version: "dora-gitlab-v2.4",
        samples: {
          deployments: Math.round(currentDeployments),
          leadTimeFirstCommit: Math.round(currentLeadFirstCommitCount),
          leadTimeFromMr: Math.round(currentLeadMrCount),
          leadTimeFromLastCommit: Math.round(currentLeadCommitCount),
          gitlabFailures: Math.round(currentFailureCount),
          gitlabRecoveries: Math.round(currentMttrCount),
        },
      },
      audit: doraAudit,
      compliance,
      traceability,
      reliabilitySignals,
      clusterSignals,
      performanceBands: classifyDoraPerformance(
        currentFrequency,
        effectiveCurrentLead,
        effectiveCurrentFailureRate,
        effectiveCurrentMttr
      ),
    },
    trend,
    meta: {
      daysRequested: filters.days,
      daysWithData: currentRows.length,
      latestSnapshot: currentRows.length > 0 ? currentRows[currentRows.length - 1].snapshot_date : null,
      teams: filters.teams,
      projectIds: filters.projectIds,
    },
  };
}

export async function getManagerDashboard(filters: DashboardFilters) {
  const key = cacheKey("manager-dashboard", {
    days: filters.days,
    from: filters.from || null,
    to: filters.to || null,
    teams: filters.teams,
    projectIds: filters.projectIds,
    authors: filters.authors,
  });

  return cached(key, () => _getManagerDashboardImpl(filters));
}

async function _getManagerDashboardImpl(filters: DashboardFilters) {
  // Honour explicit from/to (custom range / period comparison) when both are valid
  // YYYY-MM-DD values; otherwise default to the last `filters.days` days ending today.
  let endDate: Date;
  let startDate: Date;
  if (
    filters.from &&
    filters.to &&
    /^\d{4}-\d{2}-\d{2}$/.test(filters.from) &&
    /^\d{4}-\d{2}-\d{2}$/.test(filters.to)
  ) {
    startDate = new Date(`${filters.from}T00:00:00.000Z`);
    endDate = new Date(`${filters.to}T23:59:59.999Z`);
  } else {
    endDate = new Date();
    startDate = subDays(endDate, filters.days);
  }
  const { clause: scopeClause, params: scopeParams } = buildWhereClause(filters, 1, {
    teamColumn: "team",
    projectColumn: "project_id",
  });
  const startParam = scopeParams.length + 1;
  const endParam = scopeParams.length + 2;

  const latestMrCte = `
    WITH latest AS (
      SELECT DISTINCT ON (project_id, mr_iid)
        project_id,
        project_name,
        team,
        mr_id,
        mr_iid,
        title,
        state,
        web_url,
        author_name,
        author_username,
        author_email,
        author_avatar_url,
        created_at,
        merged_at,
        updated_at,
        first_comment_at,
        lifetime_hours,
        lead_time_hours,
        review_time_hours,
        commit_count,
        changes_count,
        review_count,
        reviewer_count,
        reviewers,
        CASE
          WHEN state = 'merged' AND merged_at IS NOT NULL THEN merged_at
          ELSE created_at
        END AS reference_at,
        snapshot_date
      FROM gitlab_mr_analytics
      WHERE 1 = 1
      ${scopeClause}
      ORDER BY project_id, mr_iid, snapshot_date DESC
    )
  `;

  const [result, currentOpenResult] = await Promise.all([
    pool.query<MergeRequestQueryRow>(
      `
        ${latestMrCte}
        SELECT *
        FROM latest
        WHERE reference_at >= $${startParam}
          AND reference_at <= $${endParam}
        ORDER BY COALESCE(merged_at, created_at) DESC
      `,
      [...scopeParams, startDate.toISOString(), endDate.toISOString()]
    ),
    pool.query<MergeRequestQueryRow>(
      `
        ${latestMrCte}
        SELECT *
        FROM latest
        WHERE state = 'opened'
        ORDER BY created_at DESC
      `,
      scopeParams
    ),
  ]);

  const scopeRows = result.rows.map(mapMergeRequestQueryRow);
  const currentOpenScopeRows = currentOpenResult.rows.map(mapMergeRequestQueryRow);

  const managerIdentityRows = [...scopeRows, ...currentOpenScopeRows];

  // Enrich identity data with developer_activity_daily (captures commit emails
  // which are often the real corporate email, unlike MR author which may be empty
  // when the user has a private email in GitLab)
  let activityIdentityInputs: Array<{
    email: string | null;
    name: string | null;
    team: string | null;
    projectId: number | null;
    commits: number;
    linesAdded: number;
    linesRemoved: number;
  }> = [];
  try {
    // Build a separate where clause for the activity query with param indices starting at 3
    // ($1 = startDate, $2 = endDate, then scope filters from $3 onwards)
    const { clause: activityScopeClause, params: activityScopeParams } = buildWhereClause(filters, 3, {
      teamColumn: "team",
      projectColumn: "project_id",
    });
    const activityResult = await pool.query<{
      developer_email: string;
      developer_name: string;
      team: string;
      project_id: number;
      total_commits: string;
      total_lines_added: string;
      total_lines_removed: string;
    }>(`
      SELECT developer_email, MAX(developer_name) as developer_name,
             team, project_id, SUM(commits_count)::text as total_commits,
             SUM(COALESCE(lines_added, 0))::text as total_lines_added,
             SUM(COALESCE(lines_removed, 0))::text as total_lines_removed
      FROM developer_activity_daily
      WHERE snapshot_date >= $1 AND snapshot_date <= $2
      ${activityScopeClause}
      GROUP BY developer_email, team, project_id
    `, [startDate.toISOString().split("T")[0], endDate.toISOString().split("T")[0], ...activityScopeParams]);
    activityIdentityInputs = activityResult.rows.map((row) => ({
      email: row.developer_email,
      name: row.developer_name,
      team: row.team,
      projectId: row.project_id,
      commits: parseInt(row.total_commits) || 0,
      linesAdded: parseInt(row.total_lines_added) || 0,
      linesRemoved: parseInt(row.total_lines_removed) || 0,
    }));
  } catch (err) {
    console.error("Error enriching identities from developer_activity_daily:", err);
  }

  // Load canonical name map from developer_name_map table
  // Maps gitlab_username → canonical_name to fix emails-as-names
  const nameMap = new Map<string, string>();
  try {
    const nameMapResult = await pool.query<{ gitlab_username: string; canonical_name: string }>(
      `SELECT gitlab_username, canonical_name FROM developer_name_map`
    );
    for (const row of nameMapResult.rows) {
      nameMap.set(row.gitlab_username, row.canonical_name);
    }
  } catch {
    // Table may not exist yet — silently ignore
  }

  const managerIdentities = mergeDevelopersByIdentity([
    ...managerIdentityRows.map((row) => ({
      email: resolveAuthorIdentitySeed(row.author_email, row.author_username),
      // Use canonical name from name map if available (resolves emails-as-names)
      name: nameMap.get(row.author_username) || row.author_name,
      team: row.team,
      projectId: row.project_id,
      mrsOpened: 1,
      mrsMerged: row.state === "merged" ? 1 : 0,
      firstActivity: row.created_at,
      lastActivity: row.merged_at || row.created_at,
    })),
    ...activityIdentityInputs.map((row) => ({
      email: row.email,
      name: row.name,
      team: row.team,
      projectId: row.projectId,
      commits: row.commits,
      linesAdded: row.linesAdded,
      linesRemoved: row.linesRemoved,
    })),
  ]);

  const managerIdentityBySeed = new Map<
    string,
    {
      canonicalKey: string;
      email: string;
      name: string;
    }
  >();
  for (const identity of managerIdentities) {
    for (const email of identity.allEmails) {
      managerIdentityBySeed.set(sanitizeDeveloperEmail(email), {
        canonicalKey: identity.canonicalKey,
        email: identity.email,
        name: identity.name,
      });
    }
  }

  const normalizeManagerRow = (row: MergeRequestRow) => {
    const identity = managerIdentityBySeed.get(resolveAuthorIdentitySeed(row.author_email, row.author_username));
    return {
      ...row,
      canonical_author_key: identity?.canonicalKey || resolveAuthorIdentitySeed(row.author_email, row.author_username),
      canonical_author_name: identity?.name || row.author_name,
    };
  };

  const normalizedScopeRows = scopeRows.map(normalizeManagerRow);
  const normalizedOpenScopeRows = currentOpenScopeRows.map(normalizeManagerRow);

  // Map each canonical identity → the set of GitLab usernames that feed it.
  // Exposed via options.authors so per-username endpoints (team-activity,
  // mr-details) can translate a canonical-key filter into the usernames they
  // actually store, instead of re-deriving canonical keys from a different
  // (and smaller) row population — which would not match.
  const usernamesByCanonicalKey = new Map<string, Set<string>>();
  for (const row of [...normalizedScopeRows, ...normalizedOpenScopeRows]) {
    const username = (row.author_username || "").trim();
    if (!username) continue;
    let set = usernamesByCanonicalKey.get(row.canonical_author_key);
    if (!set) {
      set = new Set<string>();
      usernamesByCanonicalKey.set(row.canonical_author_key, set);
    }
    set.add(username);
  }

  const filteredRows = filters.authors.length > 0
    ? normalizedScopeRows.filter((row) =>
        filters.authors.includes(row.canonical_author_key) || filters.authors.includes(row.author_name)
      )
    : normalizedScopeRows;
  const filteredOpenRows = filters.authors.length > 0
    ? normalizedOpenScopeRows.filter((row) =>
        filters.authors.includes(row.canonical_author_key) || filters.authors.includes(row.author_name)
      )
    : normalizedOpenScopeRows;

  const mergedRows = filteredRows.filter((row) => row.state === "merged");
  const openedRows = filteredOpenRows;
  const reviewTimes = filteredRows.map((row) => row.review_time_hours);
  const mergedReviewTimes = mergedRows.map((row) => row.review_time_hours);
  const mergedLifetime = mergedRows.map((row) => row.lifetime_hours);
  const mergedLead = mergedRows.map((row) => row.lead_time_hours);
  const mergedChangeSize = mergedRows
    .map((row) => row.changes_count)
    .filter((value) => value != null && value > 0);
  const now = endDate.getTime();
  const openAgesHours = openedRows.map((row) =>
    Math.max(0, (now - new Date(row.created_at).getTime()) / (1000 * 60 * 60))
  );
  const openAging = calculateOpenAgingBuckets(openAgesHours);

  const reviewStats = calculateStats(reviewTimes, true);
  const gap = calculateGap(reviewStats.mean, reviewStats.median);
  const contributorStats = buildContributorStats(filteredRows, managerIdentities);
  const reviewParticipation = filteredRows.reduce((total, row) => total + row.reviewers.length, 0);
  const feedbackComments = filteredRows.reduce((total, row) => total + row.review_count, 0);

  const productionScopeFilters = {
    ...filters,
    developers: [],
  };
  const { clause: productionScopeClause, params: productionScopeParams } = buildWhereClause(
    productionScopeFilters,
    1,
    {
      teamColumn: "COALESCE(pd.team, s.team)",
      projectColumn: "pd.project_id",
    }
  );
  const productionStartParam = productionScopeParams.length + 1;
  const productionEndParam = productionScopeParams.length + 2;

  const productionResult = await pool.query<ProductionChangeRow>(
    `
      WITH latest_author AS (
      SELECT DISTINCT ON (LOWER(author_email))
          LOWER(author_email) AS author_email_key,
          author_name
        FROM gitlab_mr_analytics
        WHERE author_email IS NOT NULL
          AND author_email <> ''
        ORDER BY LOWER(author_email), snapshot_date DESC
      )
      SELECT
        pd.id AS deployment_id,
        pd.project_id,
        COALESCE(pd.project_name, s.service_name) AS project_name,
        COALESCE(pd.team, s.team) AS team,
        pd.deploy_completed_at,
        COALESCE(pd.deploy_type, 'feature') AS deploy_type,
        pd.deploy_type_reason,
        pd.environment AS deploy_environment,
        pd.gitlab_job_id,
        pd.gitlab_pipeline_id,
        dc.commit_sha,
        dc.commit_created_at,
        dc.mr_iid,
        dc.author_email,
        COALESCE(
          la.author_name,
          split_part(COALESCE(dc.author_email, 'unknown@unknown.local'), '@', 1)
        ) AS author_name
      FROM production_deployments pd
      INNER JOIN deployment_changes dc
        ON dc.deployment_id = pd.id
      LEFT JOIN services s
        ON s.id = pd.service_id
      LEFT JOIN latest_author la
        ON la.author_email_key = LOWER(COALESCE(dc.author_email, ''))
      WHERE pd.source = 'gitlab'
        AND pd.status = 'success'
        ${productionScopeClause}
        AND pd.deploy_completed_at >= $${productionStartParam}
        AND pd.deploy_completed_at <= $${productionEndParam}
        AND (dc.commit_created_at IS NULL OR pd.deploy_completed_at - dc.commit_created_at < INTERVAL '90 days')      ORDER BY pd.deploy_completed_at DESC
    `,
    [...productionScopeParams, startDate.toISOString(), endDate.toISOString()]
  );

  const rawProductionEvents = productionResult.rows.map((row) => {
    const authorEmail = sanitizeDeveloperEmail(row.author_email);
    const authorName = row.author_name || authorEmail.split("@")[0] || "unknown";
    const commitCreatedAt = row.commit_created_at;
    const deployCompletedAt = row.deploy_completed_at;
    const rawLeadTimeHours = commitCreatedAt
      ? Math.max(0, (new Date(deployCompletedAt).getTime() - new Date(commitCreatedAt).getTime()) / (1000 * 60 * 60))
      : 0;
    const leadTimeHours = isValidLeadTimeHours(rawLeadTimeHours) ? rawLeadTimeHours : 0;

    return {
      canonicalKey: authorEmail,
      deploymentId: toNumber(row.deployment_id),
      projectId: toNumber(row.project_id),
      projectName: row.project_name || String(row.project_id),
      team: row.team || "Sin team",
      deployCompletedAt,
      deployType: (row.deploy_type || "feature") as "feature" | "hotfix" | "rollback",
      deployTypeReason: row.deploy_type_reason || null,
      deployEnvironment: row.deploy_environment,
      gitlabJobId: row.gitlab_job_id,
      gitlabPipelineId: row.gitlab_pipeline_id,
      commitSha: row.commit_sha || `${row.project_id}-${row.deployment_id}`,
      commitCreatedAt,
      mrIid: nullableInt(row.mr_iid),
      authorEmail,
      authorName,
      leadTimeHours,
    };
  });

  const productionIdentities = mergeDevelopersByIdentity(
    rawProductionEvents.map((event) => ({
      email: event.authorEmail,
      name: event.authorName,
      team: event.team,
      projectId: event.projectId,
      commits: 1,
      firstActivity: event.commitCreatedAt || event.deployCompletedAt,
      lastActivity: event.deployCompletedAt,
    }))
  );

  const identityByEmail = new Map<string, { canonicalKey: string; email: string; name: string; teams: string[] }>();
  for (const identity of productionIdentities) {
    for (const email of identity.allEmails) {
      identityByEmail.set(sanitizeDeveloperEmail(email), {
        canonicalKey: identity.canonicalKey,
        email: identity.email,
        name: identity.name,
        teams: identity.teams,
      });
    }
  }

  const productionEvents = rawProductionEvents
    .map((event) => {
      const identity = identityByEmail.get(event.authorEmail);
      return {
        ...event,
        canonicalKey: identity?.canonicalKey || event.authorEmail,
        canonicalEmail: identity?.email || event.authorEmail,
        canonicalName: identity?.name || event.authorName,
      };
    })
    .filter((event) =>
      filters.authors.length === 0
        || filters.authors.includes(event.canonicalKey)
        || filters.authors.includes(event.canonicalName)
    );

  const uniqueDeploymentsTouched = new Set<number>();
  const hotfixDeployments = new Set<number>();
  const rollbackDeployments = new Set<number>();
  const uniqueChangeEvents = new Map<string, typeof productionEvents[number]>();

  for (const event of productionEvents) {
    uniqueDeploymentsTouched.add(event.deploymentId);
    if (event.deployType === "hotfix") {
      hotfixDeployments.add(event.deploymentId);
    } else if (event.deployType === "rollback") {
      rollbackDeployments.add(event.deploymentId);
    }

    const changeKey = `${event.projectId}:${event.commitSha}`;
    const existing = uniqueChangeEvents.get(changeKey);
    if (!existing || new Date(event.deployCompletedAt).getTime() < new Date(existing.deployCompletedAt).getTime()) {
      uniqueChangeEvents.set(changeKey, event);
    }
  }

  const productionContributorMap = new Map<
    string,
    {
      canonicalKey: string;
      email: string;
      name: string;
      teams: Set<string>;
      changes: Set<string>;
      deployments: Set<number>;
      projects: Set<number>;
      leadTimes: number[];
      hotfixDeployments: Set<number>;
      rollbackDeployments: Set<number>;
      lastDeployedAt: string | null;
    }
  >();
  const productionTeamMap = new Map<
    string,
    {
      deployments: Set<number>;
      changes: Set<string>;
      contributors: Set<string>;
      leadTimes: number[];
      hotfixDeployments: Set<number>;
      rollbackDeployments: Set<number>;
    }
  >();
  const productionWeekly = new Map<
    string,
    {
      weekDate: string;
      week: string;
      deployments: Set<number>;
      changes: Set<string>;
      contributors: Set<string>;
      leadTimes: number[];
    }
  >();

  for (const event of productionEvents) {
    if (!productionContributorMap.has(event.canonicalKey)) {
      productionContributorMap.set(event.canonicalKey, {
        canonicalKey: event.canonicalKey,
        email: event.canonicalEmail,
        name: event.canonicalName,
        teams: new Set<string>(),
        changes: new Set<string>(),
        deployments: new Set<number>(),
        projects: new Set<number>(),
        leadTimes: [],
        hotfixDeployments: new Set<number>(),
        rollbackDeployments: new Set<number>(),
        lastDeployedAt: null,
      });
    }

    const contributor = productionContributorMap.get(event.canonicalKey)!;
    contributor.teams.add(event.team);
    contributor.deployments.add(event.deploymentId);
    contributor.projects.add(event.projectId);
    if (!contributor.lastDeployedAt || new Date(event.deployCompletedAt) > new Date(contributor.lastDeployedAt)) {
      contributor.lastDeployedAt = event.deployCompletedAt;
    }
    if (event.deployType === "hotfix") contributor.hotfixDeployments.add(event.deploymentId);
    if (event.deployType === "rollback") contributor.rollbackDeployments.add(event.deploymentId);

    if (!productionTeamMap.has(event.team)) {
      productionTeamMap.set(event.team, {
        deployments: new Set<number>(),
        changes: new Set<string>(),
        contributors: new Set<string>(),
        leadTimes: [],
        hotfixDeployments: new Set<number>(),
        rollbackDeployments: new Set<number>(),
      });
    }

    const team = productionTeamMap.get(event.team)!;
    team.deployments.add(event.deploymentId);
    team.contributors.add(event.canonicalKey);
    if (event.deployType === "hotfix") team.hotfixDeployments.add(event.deploymentId);
    if (event.deployType === "rollback") team.rollbackDeployments.add(event.deploymentId);

    const weekStart = startOfWeek(new Date(event.deployCompletedAt), WEEK_STARTS_ON_MONDAY);
    const weekDate = format(weekStart, "yyyy-MM-dd");
    if (!productionWeekly.has(weekDate)) {
      productionWeekly.set(weekDate, {
        weekDate,
        week: format(weekStart, "MMM dd"),
        deployments: new Set<number>(),
        changes: new Set<string>(),
        contributors: new Set<string>(),
        leadTimes: [],
      });
    }

    const weekly = productionWeekly.get(weekDate)!;
    weekly.deployments.add(event.deploymentId);
    weekly.contributors.add(event.canonicalKey);
  }

  for (const [changeKey, event] of uniqueChangeEvents.entries()) {
    const contributor = productionContributorMap.get(event.canonicalKey);
    if (contributor) {
      contributor.changes.add(changeKey);
      if (event.leadTimeHours > 0) contributor.leadTimes.push(event.leadTimeHours);
    }

    const team = productionTeamMap.get(event.team);
    if (team) {
      team.changes.add(changeKey);
      if (event.leadTimeHours > 0) team.leadTimes.push(event.leadTimeHours);
    }

    const weekStart = startOfWeek(new Date(event.deployCompletedAt), WEEK_STARTS_ON_MONDAY);
    const weekDate = format(weekStart, "yyyy-MM-dd");
    const weekly = productionWeekly.get(weekDate);
    if (weekly) {
      weekly.changes.add(changeKey);
      if (event.leadTimeHours > 0) weekly.leadTimes.push(event.leadTimeHours);
    }
  }

  // Build a lookup for lines data from merged identities
  const identityLinesLookup = new Map<string, { linesAdded: number; linesRemoved: number }>();
  for (const identity of managerIdentities) {
    identityLinesLookup.set(identity.canonicalKey, {
      linesAdded: identity.linesAdded,
      linesRemoved: identity.linesRemoved,
    });
  }

  const productionContributors: ProductionContributor[] = [...productionContributorMap.values()]
    .map((contributor) => ({
      canonicalKey: contributor.canonicalKey,
      email: contributor.email,
      name: contributor.name,
      teams: [...contributor.teams].sort(localeCompare),
      changesDeployed: contributor.changes.size,
      deploymentsTouched: contributor.deployments.size,
      projectsActive: contributor.projects.size,
      medianLeadTimeHours: median(contributor.leadTimes),
      hotfixDeployments: contributor.hotfixDeployments.size,
      rollbackDeployments: contributor.rollbackDeployments.size,
      lastDeployedAt: contributor.lastDeployedAt,
      linesAdded: identityLinesLookup.get(contributor.canonicalKey)?.linesAdded ?? 0,
      linesRemoved: identityLinesLookup.get(contributor.canonicalKey)?.linesRemoved ?? 0,
    }))
    .sort((left, right) => {
      if (right.changesDeployed !== left.changesDeployed) {
        return right.changesDeployed - left.changesDeployed;
      }
      if (right.deploymentsTouched !== left.deploymentsTouched) {
        return right.deploymentsTouched - left.deploymentsTouched;
      }
      return right.projectsActive - left.projectsActive;
    });

  const productionTeams: ProductionTeamSummary[] = [...productionTeamMap.entries()]
    .map(([team, value]) => ({
      team,
      deployments: value.deployments.size,
      changesDeployed: value.changes.size,
      contributors: value.contributors.size,
      hotfixDeployments: value.hotfixDeployments.size,
      rollbackDeployments: value.rollbackDeployments.size,
      medianLeadTimeHours: median(value.leadTimes),
    }))
    .sort((left, right) => {
      if (right.changesDeployed !== left.changesDeployed) {
        return right.changesDeployed - left.changesDeployed;
      }
      return right.deployments - left.deployments;
    });

  const productionLeadTimes = [...uniqueChangeEvents.values()]
    .map((event) => event.leadTimeHours)
    .filter((value) => value > 0);

  const productionWeeklyTrend = [...productionWeekly.values()]
    .map((week) => ({
      week: week.week,
      weekDate: week.weekDate,
      deployments: week.deployments.size,
      changesDeployed: week.changes.size,
      contributors: week.contributors.size,
      medianLeadTimeHours: median(week.leadTimes),
    }))
    .sort((left, right) => left.weekDate.localeCompare(right.weekDate));

  const productionRecentChanges = [...uniqueChangeEvents.values()]
    .sort((left, right) => new Date(right.deployCompletedAt).getTime() - new Date(left.deployCompletedAt).getTime())
    .slice(0, 24)
    .map((event) => ({
      canonicalKey: event.canonicalKey,
      authorName: event.canonicalName,
      authorEmail: event.canonicalEmail,
      team: event.team,
      projectId: event.projectId,
      projectName: event.projectName,
      deploymentId: event.deploymentId,
      deployCompletedAt: event.deployCompletedAt,
      deployType: event.deployType,
      deployTypeReason: event.deployTypeReason,
      deployEnvironment: event.deployEnvironment,
      gitlabJobId: event.gitlabJobId,
      gitlabPipelineId: event.gitlabPipelineId,
      commitSha: event.commitSha,
      mrIid: event.mrIid,
      leadTimeHours: event.leadTimeHours,
    }));

  const focusContributor = filters.authors.length === 1
    ? productionContributors.find((contributor) =>
        contributor.canonicalKey === filters.authors[0] || contributor.name === filters.authors[0]
      ) || null
    : null;

  const authorOptions = [...managerIdentities]
    .map<ManagerAuthorOption>((identity) => {
      const hasKnownEmail = identity.email !== "unknown@unknown.local";
      return {
        key: identity.canonicalKey,
        label: hasKnownEmail ? `${identity.name} · ${identity.email}` : identity.name,
        name: identity.name,
        email: hasKnownEmail ? identity.email : null,
        usernames: [...(usernamesByCanonicalKey.get(identity.canonicalKey) ?? [])].sort(),
      };
    })
    .sort((left, right) => localeCompare(left.label, right.label));

  const focusContributorDetails = focusContributor
    ? {
        ...focusContributor,
        recentChanges: productionRecentChanges
          .filter((change) => change.canonicalKey === focusContributor.canonicalKey)
          .slice(0, 8),
      }
    : null;
  const latestManagerSnapshot = [...result.rows, ...currentOpenResult.rows].reduce<string | null>((latest, row) => {
    const snapshot = row.snapshot_date instanceof Date ? row.snapshot_date.toISOString() : String(row.snapshot_date);
    if (!latest) return snapshot;
    return new Date(snapshot).getTime() > new Date(latest).getTime() ? snapshot : latest;
  }, null);
  const productionIntegrity = await getProductionIntegritySummary(startDate, endDate, filters);
  const unknownIdentityRows = filteredRows.filter(
    (row) => resolveAuthorIdentitySeed(row.author_email, row.author_username) === "unknown@unknown.local"
  ).length;
  const identityCoveragePct = filteredRows.length > 0
    ? ((filteredRows.length - unknownIdentityRows) / filteredRows.length) * 100
    : 0;
  const productionAttachPct = productionIntegrity.totalDeployments > 0
    ? (uniqueDeploymentsTouched.size / productionIntegrity.totalDeployments) * 100
    : 0;
  const managerAudit = buildAuditSummary({
    methodologyVersion: "manager-delivery-v1.2",
    sourceOfTruth: "gitlab_mr_analytics para flujo de MR y production_deployments/deployment_changes para llegada real a producción.",
    note: "Las MRs se deduplican por proyecto e IID en su snapshot más reciente. La entrega real se deduplica por proyecto y commit para no inflar redeploys, y los autores se agrupan por identidad canónica.",
    coverageLabel: "Cobertura a producción",
    coveragePct: productionAttachPct,
    checks: [
      createAuditCheck(
        "identity_resolution",
        "Identidad de autor",
        identityCoveragePct >= 98
          ? "pass"
          : identityCoveragePct >= 90
            ? "warn"
            : "fail",
        `${identityCoveragePct.toFixed(1)}%`,
        `${filteredRows.length - unknownIdentityRows}/${filteredRows.length} MRs visibles tienen identidad de autor resoluble con email o username.`
      ),
      createAuditCheck(
        "production_attach_rate",
        "Attach rate prod",
        productionAttachPct >= 85
          ? "pass"
          : productionAttachPct >= 60
            ? "warn"
            : "fail",
        `${productionAttachPct.toFixed(1)}%`,
        `${uniqueDeploymentsTouched.size}/${productionIntegrity.totalDeployments || 0} despliegues productivos del alcance tienen changes asociados para cruzarlos con management.`
      ),
      createAuditCheck(
        "deploys_without_changes",
        "Deploys sin changes",
        productionIntegrity.deploymentsWithoutChanges === 0
          ? "pass"
          : productionIntegrity.deploymentsWithoutChanges <= 2
            ? "warn"
            : "fail",
        String(productionIntegrity.deploymentsWithoutChanges),
        "Despliegues productivos del alcance que no pueden enlazarse todavía con commits o MRs."
      ),
      createAuditCheck(
        "duplicate_gitlab_jobs",
        "Jobs duplicados",
        productionIntegrity.duplicateJobRecords === 0
          ? "pass"
          : productionIntegrity.duplicateJobRecords <= 2
            ? "warn"
            : "fail",
        String(productionIntegrity.duplicateJobRecords),
        "Filas productivas que repiten el mismo gitlab_job_id dentro del alcance filtrado."
      ),
      createAuditCheck(
        "mr_sample_size",
        "Muestra de MR",
        filteredRows.length >= 25
          ? "pass"
          : filteredRows.length >= 10
            ? "warn"
            : "info",
        String(filteredRows.length),
        `MR visibles en el alcance actual para construir tendencias y percentiles de gestión.`
      ),
    ],
  });

  return {
    filters: {
      days: filters.days,
      teams: filters.teams,
      projectIds: filters.projectIds,
      authors: filters.authors,
    },
    audit: managerAudit,
    options: {
      authors: authorOptions,
      projects: scopeRows
        .reduce<{ id: number; name: string; team: string }[]>((acc, row) => {
          if (!acc.some((project) => project.id === row.project_id)) {
            acc.push({ id: row.project_id, name: row.project_name, team: row.team });
          }
          return acc;
        }, [])
        .sort((left, right) => localeCompare(left.name, right.name)),
    },
    summary: {
      totalMRs: filteredRows.length,
      mergedMRs: mergedRows.length,
      openMRs: openedRows.length,
      contributors: uniqueBy(filteredRows.map((row) => row.canonical_author_key)).length,
      throughputMerged: mergedRows.length,
      reviewDensity: filteredRows.length > 0 ? reviewParticipation / filteredRows.length : 0,
      feedbackCollective: feedbackComments,
      lifetimeMedianHours: median(mergedLifetime),
      leadTimeMedianHours: median(mergedLead),
      reviewTimeMedianHours: median(mergedReviewTimes, true),
      changeSizeMedian: mergedChangeSize.length > 0 ? median(mergedChangeSize) : null,
      changeSizeP90: mergedChangeSize.length > 0 ? calculateStats(mergedChangeSize).p90 : null,
      openAging,
      productionChangesDeployed: uniqueChangeEvents.size,
      productionDeploymentsTouched: uniqueDeploymentsTouched.size,
      productionContributors: productionContributors.length,
      productionLeadTimeMedianHours: median(productionLeadTimes),
      productionHotfixDeployments: hotfixDeployments.size,
      productionRollbackDeployments: rollbackDeployments.size,
      totalLinesAdded: managerIdentities.reduce((sum, identity) => sum + identity.linesAdded, 0),
      totalLinesRemoved: managerIdentities.reduce((sum, identity) => sum + identity.linesRemoved, 0),
    },
    stats: {
      lifetime: calculateStats(filteredRows.map((row) => row.lifetime_hours)),
      leadTime: calculateStats(filteredRows.map((row) => row.lead_time_hours)),
      reviewTime: reviewStats,
      reviewTimeAnalysis: {
        gap,
        hasOutliers: hasOutliers(gap),
        stability: isVolatile(reviewStats.stdDev, reviewStats.median)
          ? "volatile"
          : isStable(reviewStats.stdDev, reviewStats.median)
            ? "very_stable"
            : "stable",
        stdDevRatio: reviewStats.median > 0 ? reviewStats.stdDev / reviewStats.median : 0,
      },
      gaussian: reviewStats.count >= 2 && reviewStats.stdDev > 0
        ? gaussianDistribution(reviewStats.mean, reviewStats.stdDev, 100)
        : [],
    },
    weekly: buildWeeklyMrBreakdown(mergedRows),
    bottlenecks: [...mergedRows]
      .sort((left, right) => right.review_time_hours - left.review_time_hours)
      .slice(0, 8),
    contributors: contributorStats,
    productionDelivery: {
      summary: {
        changesDeployed: uniqueChangeEvents.size,
        deploymentsTouched: uniqueDeploymentsTouched.size,
        contributors: productionContributors.length,
        medianLeadTimeHours: median(productionLeadTimes),
        hotfixDeployments: hotfixDeployments.size,
        rollbackDeployments: rollbackDeployments.size,
      },
      weekly: productionWeeklyTrend,
      contributors: productionContributors.slice(0, 20),
      teams: productionTeams.slice(0, 12),
      focusContributor: focusContributorDetails,
      recentChanges: productionRecentChanges,
    },
    meta: {
      latestSnapshot: latestManagerSnapshot,
    },
    recentMergeRequests: filteredRows.slice(0, 150),
  };
}

export async function getSonarDashboard(filters: DashboardFilters) {
  const key = cacheKey("sonar-dashboard", {
    days: filters.days,
    teams: filters.teams,
    projectIds: filters.projectIds,
    sonarProjectKeys: filters.sonarProjectKeys,
    sonarScope: filters.sonarScope,
  });

  return cached(key, () => _getSonarDashboardImpl(filters));
}

async function _getSonarDashboardImpl(filters: DashboardFilters) {
  const endDate = new Date();
  const startDate = subDays(endDate, filters.days);
  const historyKeyClause = filters.sonarProjectKeys.length > 0 ? " AND sonar_project_key = ANY($3)" : "";
  const scopedKeyClause = filters.sonarProjectKeys.length > 0 ? " AND sm.sonar_project_key = ANY($3)" : "";
  const keyParams = filters.sonarProjectKeys.length > 0 ? [filters.sonarProjectKeys] : [];

  const historyResult = await pool.query<SonarHistoryRow>(
    `
      SELECT
        snapshot_date,
        AVG(coverage) AS avg_coverage,
        AVG(duplicated_lines_density) AS avg_duplication,
        SUM(COALESCE(bugs, 0)) AS total_bugs,
        SUM(COALESCE(vulnerabilities, 0)) AS total_vulnerabilities,
        SUM(COALESCE(code_smells, 0)) AS total_code_smells,
        SUM(COALESCE(tech_debt_minutes, 0)) AS total_tech_debt,
        SUM(COALESCE(security_hotspots, 0)) AS total_hotspots,
        COUNT(*) FILTER (WHERE quality_gate_status = 'OK') AS quality_gate_ok,
        COUNT(*) FILTER (WHERE quality_gate_status = 'ERROR') AS quality_gate_error,
        COUNT(*) FILTER (WHERE quality_gate_status NOT IN ('OK', 'ERROR') OR quality_gate_status IS NULL) AS quality_gate_warn,
        COUNT(*) AS project_count
      FROM sonarqube_metrics_daily
      WHERE snapshot_date >= $1
        AND snapshot_date <= $2
        ${historyKeyClause}
      GROUP BY snapshot_date
      ORDER BY snapshot_date ASC
    `,
    [format(startDate, "yyyy-MM-dd"), format(endDate, "yyyy-MM-dd"), ...keyParams]
  );

  const currentProjectResult = await pool.query<SonarProjectRow>(
    `
      SELECT DISTINCT ON (sm.sonar_project_key)
        sm.sonar_project_key,
        sm.sonar_project_name,
        sm.snapshot_date,
        COALESCE(sm.gitlab_project_id, psm.gitlab_project_id) AS gitlab_project_id,
        COALESCE(sm.gitlab_project_path, psm.gitlab_project_path) AS gitlab_project_path,
        sm.coverage,
        sm.bugs,
        sm.vulnerabilities,
        sm.code_smells,
        sm.tech_debt_minutes,
        sm.security_hotspots,
        sm.duplicated_lines_density,
        sm.quality_gate_status
      FROM sonarqube_metrics_daily sm
      LEFT JOIN project_sonar_mapping psm
        ON psm.sonar_project_key = sm.sonar_project_key
      WHERE sm.snapshot_date >= $1
        AND sm.snapshot_date <= $2
        ${scopedKeyClause}
      ORDER BY sm.sonar_project_key, sm.snapshot_date DESC
    `,
    [format(startDate, "yyyy-MM-dd"), format(endDate, "yyyy-MM-dd"), ...keyParams]
  );

  const baselineProjectResult = await pool.query<SonarProjectRow>(
    `
      SELECT DISTINCT ON (sm.sonar_project_key)
        sm.sonar_project_key,
        sm.sonar_project_name,
        sm.snapshot_date,
        COALESCE(sm.gitlab_project_id, psm.gitlab_project_id) AS gitlab_project_id,
        COALESCE(sm.gitlab_project_path, psm.gitlab_project_path) AS gitlab_project_path,
        sm.coverage,
        sm.bugs,
        sm.vulnerabilities,
        sm.code_smells,
        sm.tech_debt_minutes,
        sm.security_hotspots,
        sm.duplicated_lines_density,
        sm.quality_gate_status
      FROM sonarqube_metrics_daily sm
      LEFT JOIN project_sonar_mapping psm
        ON psm.sonar_project_key = sm.sonar_project_key
      WHERE sm.snapshot_date >= $1
        AND sm.snapshot_date <= $2
        ${scopedKeyClause}
      ORDER BY sm.sonar_project_key, sm.snapshot_date ASC
    `,
    [format(startDate, "yyyy-MM-dd"), format(endDate, "yyyy-MM-dd"), ...keyParams]
  );

  const availableProjectsResult = await pool.query<SonarAvailableProjectRow>(
    `
      SELECT DISTINCT ON (sm.sonar_project_key)
        sm.sonar_project_key,
        sm.sonar_project_name,
        COALESCE(sm.gitlab_project_id, psm.gitlab_project_id) AS gitlab_project_id,
        COALESCE(sm.gitlab_project_path, psm.gitlab_project_path) AS gitlab_project_path
      FROM sonarqube_metrics_daily sm
      LEFT JOIN project_sonar_mapping psm
        ON psm.sonar_project_key = sm.sonar_project_key
      ORDER BY sm.sonar_project_key, sm.snapshot_date DESC
    `
  );

  const latestSnapshotOverallResult = await pool.query<{ latest_snapshot: string | null }>(
    `
      SELECT MAX(snapshot_date) AS latest_snapshot
      FROM sonarqube_metrics_daily
      ${filters.sonarProjectKeys.length > 0 ? "WHERE sonar_project_key = ANY($1)" : ""}
    `,
    filters.sonarProjectKeys.length > 0 ? [filters.sonarProjectKeys] : []
  );

  if (filters.sonarScope === "none") {
    return {
      filters: {
        days: filters.days,
        projectKeys: filters.sonarProjectKeys,
      },
      audit: buildAuditSummary({
        methodologyVersion: "sonar-gitlab-v1.2",
        sourceOfTruth: "sonarqube_metrics_daily con enlace preferente vía project_sonar_mapping y selección Sonar explícitamente vacía para este alcance.",
        note: "Cuando el scope Sonar queda vacío porque no existe mapping para el filtro GitLab actual, el backend no inventa cobertura ni riesgo: deja la selección libre para override manual.",
        coverageLabel: "Cobertura mapping",
        coveragePct: 0,
        checks: [
          createAuditCheck(
            "empty_scope",
            "Scope Sonar",
            "info",
            "Vacío",
            "No hay proyecto Sonar autoaplicado para la selección GitLab actual."
          ),
        ],
      }),
      availableProjects: availableProjectsResult.rows
        .map((row) => ({
          key: row.sonar_project_key,
          name: row.sonar_project_name || row.sonar_project_key,
          gitlabProjectId: nullableInt(row.gitlab_project_id),
          gitlabProjectPath: row.gitlab_project_path || null,
        }))
        .sort((left, right) => localeCompare(left.name, right.name)),
      summary: {
        projectCount: 0,
        averageCoverage: 0,
        averageDuplication: 0,
        totalBugs: 0,
        totalVulnerabilities: 0,
        totalCodeSmells: 0,
        totalSecurityHotspots: 0,
        techDebtHours: 0,
        mappedProjects: 0,
        unmappedProjects: 0,
        mappingCoveragePct: 0,
        qualityGate: {
          ok: 0,
          error: 0,
          warn: 0,
          passRate: 0,
        },
        latestSnapshot: null,
      },
      meta: {
        latestSnapshotInWindow: null,
        latestSnapshotOverall: null,
        stale: false,
      },
      trend: [],
      projects: [],
      reports: {
        weakestCoverage: [],
        highestRisk: [],
        mostDebt: [],
      },
    };
  }

  const baselineMap = new Map<
    string,
    {
      coverage: number;
      bugs: number;
      vulnerabilities: number;
      codeSmells: number;
      techDebtMinutes: number;
    }
  >(
    baselineProjectResult.rows.map((row) => [
      row.sonar_project_key,
      {
        coverage: toNumber(row.coverage),
        bugs: toNumber(row.bugs),
        vulnerabilities: toNumber(row.vulnerabilities),
        codeSmells: toNumber(row.code_smells),
        techDebtMinutes: toNumber(row.tech_debt_minutes),
      },
    ])
  );

  const currentProjects = currentProjectResult.rows.map((row) => {
    const baseline = baselineMap.get(row.sonar_project_key);
    const coverageValue = nullableNumber(row.coverage);
    const duplicationValue = nullableNumber(row.duplicated_lines_density);
    const coverage = coverageValue ?? 0;
    const bugs = toNumber(row.bugs);
    const vulnerabilities = toNumber(row.vulnerabilities);
    const codeSmells = toNumber(row.code_smells);
    const techDebtMinutes = toNumber(row.tech_debt_minutes);
    const duplication = duplicationValue ?? 0;
    const securityHotspots = toNumber(row.security_hotspots);
    const qualityGate = row.quality_gate_status || "UNKNOWN";
    const gitlabProjectId = nullableInt(row.gitlab_project_id);
    const gitlabProjectPath = row.gitlab_project_path || null;

    return {
      key: row.sonar_project_key,
      name: row.sonar_project_name || row.sonar_project_key,
      snapshotDate: row.snapshot_date,
      gitlabProjectId,
      gitlabProjectPath,
      mappedToGitLab: gitlabProjectId !== null,
      coverage,
      hasCoverageData: coverageValue !== null,
      bugs,
      vulnerabilities,
      codeSmells,
      techDebtHours: techDebtMinutes / 60,
      techDebtMinutes,
      duplication,
      hasDuplicationData: duplicationValue !== null,
      securityHotspots,
      qualityGate,
      delta: {
        coverage: baseline ? coverage - baseline.coverage : 0,
        bugs: baseline ? bugs - baseline.bugs : 0,
        vulnerabilities: baseline ? vulnerabilities - baseline.vulnerabilities : 0,
        codeSmells: baseline ? codeSmells - baseline.codeSmells : 0,
        techDebtHours: baseline ? (techDebtMinutes - baseline.techDebtMinutes) / 60 : 0,
      },
      riskScore: calculateSonarRiskScore({
        vulnerabilities,
        bugs,
        securityHotspots,
        qualityGate,
        coverage,
      }),
    };
  });

  const latestHistory = historyResult.rows[historyResult.rows.length - 1];
  const summaryCoverage = average(
    currentProjects
      .filter((project) => project.hasCoverageData)
      .map((project) => project.coverage)
  );
  const summaryDuplication = average(
    currentProjects
      .filter((project) => project.hasDuplicationData)
      .map((project) => project.duplication)
  );
  const mappedProjects = currentProjects.filter((project) => project.mappedToGitLab).length;
  const projectsWithCoverageData = currentProjects.filter((project) => project.hasCoverageData).length;
  const unknownGateProjects = currentProjects.filter((project) => project.qualityGate !== "OK" && project.qualityGate !== "ERROR").length;
  const zeroCoverageProjects = currentProjects.filter((project) => project.hasCoverageData && project.coverage === 0).length;
  const gates = currentProjects.reduce(
    (acc, project) => {
      if (project.qualityGate === "OK") acc.ok++;
      else if (project.qualityGate === "ERROR") acc.error++;
      else acc.warn++;
      return acc;
    },
    { ok: 0, error: 0, warn: 0 }
  );
  const sonarAudit = buildAuditSummary({
    methodologyVersion: "sonar-gitlab-v1.2",
    sourceOfTruth: "sonarqube_metrics_daily unido a project_sonar_mapping; manual primero, match exacto de repo después, sin fuzzy matching.",
    note: "La cartera Sonar se calcula por snapshots diarios. El enlace con GitLab prioriza mapeo persistido y, si no existe, solo acepta coincidencia exacta del repo en namespace digital.",
    coverageLabel: "Cobertura mapping",
    coveragePct: currentProjects.length > 0 ? (mappedProjects / currentProjects.length) * 100 : 0,
    checks: [
      createAuditCheck(
        "gitlab_mapping",
        "Mapeo GitLab",
        currentProjects.length === 0
          ? "info"
          : mappedProjects === currentProjects.length
            ? "pass"
            : mappedProjects / currentProjects.length >= 0.7
              ? "warn"
              : "fail",
        currentProjects.length > 0 ? `${((mappedProjects / currentProjects.length) * 100).toFixed(1)}%` : "N/D",
        `${mappedProjects}/${currentProjects.length} proyectos Sonar visibles están ligados a GitLab Digital.`
      ),
      createAuditCheck(
        "coverage_data",
        "Datos de cobertura",
        currentProjects.length === 0
          ? "info"
          : projectsWithCoverageData === currentProjects.length
            ? "pass"
            : projectsWithCoverageData / currentProjects.length >= 0.85
              ? "warn"
              : "fail",
        currentProjects.length > 0 ? `${((projectsWithCoverageData / currentProjects.length) * 100).toFixed(1)}%` : "N/D",
        `${projectsWithCoverageData}/${currentProjects.length} proyectos visibles tienen cobertura reportada en la ventana actual.`
      ),
      createAuditCheck(
        "unknown_quality_gate",
        "Quality Gate unknown",
        unknownGateProjects === 0
          ? "pass"
          : unknownGateProjects <= Math.max(2, Math.round(currentProjects.length * 0.1))
            ? "warn"
            : "fail",
        String(unknownGateProjects),
        "Proyectos cuya quality gate no llega como OK/ERROR en la ventana visible."
      ),
      createAuditCheck(
        "zero_coverage_projects",
        "Cobertura 0%",
        zeroCoverageProjects === 0
          ? "pass"
          : zeroCoverageProjects <= Math.max(2, Math.round(currentProjects.length * 0.15))
            ? "warn"
            : "fail",
        String(zeroCoverageProjects),
        "Proyectos con cobertura explícita al 0%, visibles como señal real y no descartados de la media."
      ),
      createAuditCheck(
        "snapshot_freshness",
        "Freshness snapshot",
        !latestSnapshotOverallResult.rows[0]?.latest_snapshot
          ? "info"
          : latestHistory
            ? "pass"
            : "warn",
        latestHistory?.snapshot_date || latestSnapshotOverallResult.rows[0]?.latest_snapshot || "N/D",
        latestHistory
          ? "Existe snapshot Sonar dentro de la ventana temporal actual."
          : "No hay snapshot en ventana; el dashboard cae al último snapshot global disponible."
      ),
    ],
  });

  return {
    filters: {
      days: filters.days,
      projectKeys: filters.sonarProjectKeys,
    },
    audit: sonarAudit,
    availableProjects: availableProjectsResult.rows
      .map((row) => ({
        key: row.sonar_project_key,
        name: row.sonar_project_name || row.sonar_project_key,
        gitlabProjectId: nullableInt(row.gitlab_project_id),
        gitlabProjectPath: row.gitlab_project_path || null,
      }))
      .sort((left, right) => localeCompare(left.name, right.name)),
    summary: {
      projectCount: currentProjects.length,
      averageCoverage: summaryCoverage,
      averageDuplication: summaryDuplication,
      totalBugs: sumNumbers(currentProjects.map((project) => project.bugs)),
      totalVulnerabilities: sumNumbers(currentProjects.map((project) => project.vulnerabilities)),
      totalCodeSmells: sumNumbers(currentProjects.map((project) => project.codeSmells)),
      totalSecurityHotspots: sumNumbers(currentProjects.map((project) => project.securityHotspots)),
      techDebtHours: sumNumbers(currentProjects.map((project) => project.techDebtHours)),
      mappedProjects,
      unmappedProjects: Math.max(0, currentProjects.length - mappedProjects),
      mappingCoveragePct: currentProjects.length > 0 ? (mappedProjects / currentProjects.length) * 100 : 0,
      qualityGate: {
        ok: gates.ok,
        error: gates.error,
        warn: gates.warn,
        passRate: currentProjects.length > 0 ? (gates.ok / currentProjects.length) * 100 : 0,
      },
      latestSnapshot: latestHistory?.snapshot_date || null,
    },
    meta: {
      latestSnapshotInWindow: latestHistory?.snapshot_date || null,
      latestSnapshotOverall: latestSnapshotOverallResult.rows[0]?.latest_snapshot || null,
      stale: !latestHistory && Boolean(latestSnapshotOverallResult.rows[0]?.latest_snapshot),
    },
    trend: historyResult.rows.map((row) => ({
      date: row.snapshot_date,
      coverage: toNumber(row.avg_coverage),
      duplication: toNumber(row.avg_duplication),
      bugs: toNumber(row.total_bugs),
      vulnerabilities: toNumber(row.total_vulnerabilities),
      codeSmells: toNumber(row.total_code_smells),
      techDebtHours: toNumber(row.total_tech_debt) / 60,
      securityHotspots: toNumber(row.total_hotspots),
      projects: toNumber(row.project_count),
      qualityGateOk: toNumber(row.quality_gate_ok),
      qualityGateError: toNumber(row.quality_gate_error),
      qualityGateWarn: toNumber(row.quality_gate_warn),
    })),
    projects: currentProjects.sort((left, right) => right.riskScore - left.riskScore),
    reports: {
      weakestCoverage: [...currentProjects]
        .filter((project) => project.hasCoverageData)
        .sort((left, right) => left.coverage - right.coverage)
        .slice(0, 8),
      highestRisk: [...currentProjects].sort((left, right) => right.riskScore - left.riskScore).slice(0, 8),
      mostDebt: [...currentProjects].sort((left, right) => right.techDebtHours - left.techDebtHours).slice(0, 8),
    },
  };
}

async function getProductionIntegritySummary(
  startDate: Date,
  endDate: Date,
  filters: DashboardFilters
): Promise<ProductionIntegritySummary> {
  const scopeFilters = {
    ...filters,
    developers: [],
  };
  const { clause, params } = buildWhereClause(scopeFilters, 1, {
    teamColumn: "COALESCE(pd.team, s.team)",
    projectColumn: "pd.project_id",
  });
  const startParam = params.length + 1;
  const endParam = params.length + 2;

  try {
    const result = await pool.query<{
      total_deployments: string | number | null;
      deployments_with_trace: string | number | null;
      deployments_without_changes: string | number | null;
      deployments_without_job: string | number | null;
      duplicate_job_records: string | number | null;
    }>(
      `
        WITH scoped_deployments AS (
          SELECT
            pd.id,
            pd.gitlab_job_id
          FROM production_deployments pd
          LEFT JOIN services s
            ON s.id = pd.service_id
          WHERE pd.source = 'gitlab'
            AND pd.status = 'success'
            ${clause}
            AND pd.deploy_completed_at >= $${startParam}
            AND pd.deploy_completed_at <= $${endParam}
        ),
        traceable_deployments AS (
          SELECT DISTINCT sd.id
          FROM scoped_deployments sd
          INNER JOIN production_deployments pd
            ON pd.id = sd.id
          INNER JOIN deployment_traces dt
            ON dt.project_id = pd.project_id
           AND dt.deploy_id = split_part(pd.external_id, ':', 2)
           AND dt.snapshot_date >= $${startParam}::date
           AND dt.snapshot_date <= $${endParam}::date
        ),
        duplicated_jobs AS (
          SELECT gitlab_job_id, COUNT(*) AS occurrences
          FROM scoped_deployments
          WHERE gitlab_job_id IS NOT NULL
            AND gitlab_job_id <> ''
          GROUP BY gitlab_job_id
          HAVING COUNT(*) > 1
        )
        SELECT
          COUNT(*) AS total_deployments,
          COUNT(*) FILTER (WHERE td.id IS NOT NULL) AS deployments_with_trace,
          COUNT(*) FILTER (
            WHERE NOT EXISTS (
              SELECT 1
              FROM deployment_changes dc
              WHERE dc.deployment_id = sd.id
            )
          ) AS deployments_without_changes,
          COUNT(*) FILTER (WHERE sd.gitlab_job_id IS NULL OR sd.gitlab_job_id = '') AS deployments_without_job,
          COUNT(*) FILTER (WHERE dj.gitlab_job_id IS NOT NULL) AS duplicate_job_records
        FROM scoped_deployments sd
        LEFT JOIN traceable_deployments td
          ON td.id = sd.id
        LEFT JOIN duplicated_jobs dj
          ON dj.gitlab_job_id = sd.gitlab_job_id
      `,
      [...params, startDate.toISOString(), endDate.toISOString()]
    );

    const row = result.rows[0];
    return {
      totalDeployments: toNumber(row?.total_deployments),
      deploymentsWithTrace: toNumber(row?.deployments_with_trace),
      deploymentsWithoutChanges: toNumber(row?.deployments_without_changes),
      deploymentsWithoutJob: toNumber(row?.deployments_without_job),
      duplicateJobRecords: toNumber(row?.duplicate_job_records),
    };
  } catch {
    return {
      totalDeployments: 0,
      deploymentsWithTrace: 0,
      deploymentsWithoutChanges: 0,
      deploymentsWithoutJob: 0,
      duplicateJobRecords: 0,
    };
  }
}

// Utility functions moved to @/lib/dashboard-utils

function complianceControl(count: number, total: number): ComplianceControl {
  return {
    count,
    pct: total > 0 ? (count / total) * 100 : 0,
  };
}

function createAuditCheck(
  key: string,
  label: string,
  status: AuditCheckStatus,
  value: string,
  detail: string
): AuditCheck {
  return {
    key,
    label,
    status,
    value,
    detail,
  };
}

function buildAuditSummary(input: {
  methodologyVersion: string;
  sourceOfTruth: string;
  note: string;
  coverageLabel: string;
  coveragePct: number;
  checks: AuditCheck[];
}): AuditSummary {
  const anomalies = input.checks.filter((check) => check.status === "warn" || check.status === "fail").length;
  const checksScore = average(input.checks.map((check) => auditStatusWeight(check.status)));
  const coverageScore = clamp(input.coveragePct / 100, 0, 1);
  const confidenceScore = clamp(checksScore * 0.7 + coverageScore * 0.3, 0, 1);

  return {
    methodologyVersion: input.methodologyVersion,
    sourceOfTruth: input.sourceOfTruth,
    note: input.note,
    coverageLabel: input.coverageLabel,
    coveragePct: input.coveragePct,
    confidenceScore,
    confidenceLabel: confidenceScore >= 0.8 ? "alta" : confidenceScore >= 0.55 ? "media" : "baja",
    anomalies,
    checks: input.checks,
  };
}

function auditStatusWeight(status: AuditCheckStatus) {
  switch (status) {
    case "pass":
      return 1;
    case "warn":
      return 0.55;
    case "fail":
      return 0.15;
    case "info":
    default:
      return 0.75;
  }
}

// clamp, blend moved to @/lib/dashboard-utils

function averageFromSums(
  rows: DoraDailyRow[],
  sumField: keyof DoraDailyRow,
  countField: keyof DoraDailyRow
) {
  const total = rows.reduce((acc, row) => {
    const count = toNumber(row[countField]);
    if (count <= 0) return acc;
    const sum = toNumber(row[sumField]);
    const avg = sum / count;
    // Discard negative values (e.g. negative Pipeline Recovery Time)
    if (avg < 0) return acc;
    return { sum: acc.sum + sum, count: acc.count + count };
  }, { sum: 0, count: 0 });
  return total.count > 0 ? total.sum / total.count : 0;
}

function averageFromRow(row: DoraDailyRow, sumField: keyof DoraDailyRow, countField: keyof DoraDailyRow) {
  const count = toNumber(row[countField]);
  if (count <= 0) return 0;
  const avg = toNumber(row[sumField]) / count;
  // Discard negative values (e.g. negative Pipeline Recovery Time)
  return avg >= 0 ? avg : 0;
}

function aggregateLeadTimeFromDailyRows(
  rows: DoraDailyRow[],
  sumField: keyof DoraDailyRow,
  countField: keyof DoraDailyRow
) {
  const totals = rows.reduce(
    (acc, row) => {
      const count = toNumber(row[countField]);
      if (count <= 0) {
        return acc;
      }

      const sum = toNumber(row[sumField]);
      const average = sum / count;
      if (!isValidLeadTimeHours(average)) {
        return acc;
      }

      acc.sum += sum;
      acc.count += count;
      return acc;
    },
    { sum: 0, count: 0 }
  );

  return {
    average: totals.count > 0 ? totals.sum / totals.count : 0,
    count: totals.count,
  };
}

function averageLeadTimeFromDailyRow(
  row: DoraDailyRow,
  sumField: keyof DoraDailyRow,
  countField: keyof DoraDailyRow
) {
  const average = averageFromRow(row, sumField, countField);
  return isValidLeadTimeHours(average) ? average : 0;
}

function averageFromLeadTraceRow(
  row: LeadTimeTraceDailyRow,
  sumField: keyof LeadTimeTraceDailyRow,
  countField: keyof LeadTimeTraceDailyRow
) {
  const count = toNumber(row[countField]);
  return count > 0 ? toNumber(row[sumField]) / count : 0;
}

function classifyDoraPerformance(
  deploymentFrequency: number,
  leadTimeHours: number,
  changeFailureRate: number,
  mttrHours: number
) {
  return {
    deploymentFrequency: deploymentFrequency >= 1 ? "elite" : deploymentFrequency >= 0.2 ? "high" : "medium",
    leadTime: leadTimeHours <= 24 ? "elite" : leadTimeHours <= 24 * 7 ? "high" : "medium",
    changeFailureRate: changeFailureRate <= 15 ? "elite" : changeFailureRate <= 30 ? "high" : "medium",
    mttr: mttrHours <= 1 ? "elite" : mttrHours <= 24 ? "high" : "medium",
  };
}

function resolveLeadTimeReference(
  firstCommitCount: number,
  mrCount: number,
  lastCommitCount: number
): LeadTimeReference {
  if (lastCommitCount > 0) {
    return {
      key: "last_commit",
      label: "Último commit desplegado",
      description: "Usa como base preferida el tiempo desde el último commit trazado hasta producción.",
    };
  }
  if (mrCount > 0) {
    return {
      key: "mr_created",
      label: "Creación del MR",
      description: "Si falta el último commit trazado, cae al tiempo desde la apertura del MR hasta producción.",
    };
  }
  if (firstCommitCount > 0) {
    return {
      key: "first_commit",
      label: "Primer commit del cambio",
      description: "Fallback final cuando solo existe trazabilidad del inicio del cambio y no del commit final ni del MR.",
    };
  }
  return {
    key: "none",
    label: "Sin trazabilidad suficiente",
    description: "No hay suficientes despliegues trazados para calcular lead time en este alcance.",
  };
}

function parseReviewers(value: Reviewer[] | string | null): Reviewer[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((reviewer) => ({
      name: reviewer.name,
      username: reviewer.username,
      avatar_url: reviewer.avatar_url || null,
      comments: toNumber(reviewer.comments),
    }));
  }
  try {
    const parsed = JSON.parse(value) as Reviewer[];
    return Array.isArray(parsed) ? parsed.map((reviewer) => ({
      name: reviewer.name,
      username: reviewer.username,
      avatar_url: reviewer.avatar_url || null,
      comments: toNumber(reviewer.comments),
    })) : [];
  } catch {
    return [];
  }
}

function mapMergeRequestQueryRow(row: MergeRequestQueryRow): MergeRequestRow {
  return {
    project_id: row.project_id,
    project_name: row.project_name,
    team: row.team,
    mr_id: row.mr_id,
    mr_iid: row.mr_iid,
    title: row.title,
    state: row.state,
    web_url: row.web_url,
    author_name: row.author_name,
    author_username: row.author_username,
    author_email: row.author_email,
    author_avatar_url: row.author_avatar_url,
    canonical_author_key: "",
    canonical_author_name: row.author_name,
    created_at: row.created_at.toISOString(),
    merged_at: row.merged_at ? row.merged_at.toISOString() : null,
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
    first_comment_at: row.first_comment_at ? row.first_comment_at.toISOString() : null,
    lifetime_hours: toNumber(row.lifetime_hours),
    lead_time_hours: toNumber(row.lead_time_hours),
    review_time_hours: toNumber(row.review_time_hours),
    commit_count: toNumber(row.commit_count),
    changes_count: toNumber(row.changes_count),
    review_count: toNumber(row.review_count),
    reviewer_count: toNumber(row.reviewer_count),
    reviewers: parseReviewers(row.reviewers),
    reference_at: row.reference_at.toISOString(),
  };
}

function buildWeeklyMrBreakdown(rows: MergeRequestRow[]) {
  const weekly = new Map<
    string,
    {
      weekDate: string;
      weekLabel: string;
      volume: number;
      reviewTimes: number[];
      leadTimes: number[];
      reviewTimeTotalHours: number;
    }
  >();

  for (const row of rows) {
    const referenceDate = new Date(row.merged_at || row.created_at);
    const weekStart = startOfWeek(referenceDate, WEEK_STARTS_ON_MONDAY);
    const weekDate = format(weekStart, "yyyy-MM-dd");

    if (!weekly.has(weekDate)) {
      weekly.set(weekDate, {
        weekDate,
        weekLabel: format(weekStart, "MMM dd"),
        volume: 0,
        reviewTimes: [],
        leadTimes: [],
        reviewTimeTotalHours: 0,
      });
    }

    const week = weekly.get(weekDate)!;
    week.volume += 1;
    week.reviewTimeTotalHours += row.review_time_hours;
    if (row.review_time_hours > 0) {
      week.reviewTimes.push(row.review_time_hours);
    }
    week.leadTimes.push(row.lead_time_hours);
  }

  return [...weekly.values()]
    .map((week) => ({
      week: week.weekLabel,
      weekDate: week.weekDate,
      volume: week.volume,
      reviewTimeMedianHours: median(week.reviewTimes, true),
      reviewTimeTotalHours: week.reviewTimeTotalHours,
      leadTimeMedianHours: median(week.leadTimes),
    }))
    .sort((left, right) => left.weekDate.localeCompare(right.weekDate));
}

function buildContributorStats(rows: MergeRequestRow[], identities?: import("@/lib/developer-identity").MergedDeveloperIdentity[]) {
  const identityInputs = rows.flatMap((row) => [
    {
      email: resolveAuthorIdentitySeed(row.author_email, row.author_username),
      name: row.canonical_author_name || row.author_name,
      team: row.team,
      projectId: row.project_id,
      mrsOpened: 1,
      mrsMerged: row.state === "merged" ? 1 : 0,
      firstActivity: row.created_at,
      lastActivity: row.merged_at || row.created_at,
    },
    ...row.reviewers.map((reviewer) => ({
      email: reviewer.username,
      name: reviewer.name,
      team: row.team,
      projectId: row.project_id,
      reviewsGiven: 1,
      firstActivity: row.first_comment_at || row.created_at,
      lastActivity: row.merged_at || row.updated_at || row.created_at,
    })),
  ]);
  const mergedIdentities = mergeDevelopersByIdentity(identityInputs);
  const identityBySeed = new Map<string, { canonicalKey: string; name: string; handle: string }>();

  for (const identity of mergedIdentities) {
    const handle = identity.email.split("@")[0] || identity.name;
    for (const email of identity.allEmails) {
      identityBySeed.set(sanitizeDeveloperEmail(email), {
        canonicalKey: identity.canonicalKey,
        name: identity.name,
        handle,
      });
    }
  }

  // Build a lookup from canonicalKey to lines + commits data from the pre-merged identities
  const activityLookup = new Map<string, { linesAdded: number; linesRemoved: number; commits: number }>();
  if (identities) {
    for (const identity of identities) {
      activityLookup.set(identity.canonicalKey, {
        linesAdded: identity.linesAdded,
        linesRemoved: identity.linesRemoved,
        commits: identity.commits,
      });
    }
  }

  const contributors = new Map<
    string,
    {
      username: string;
      name: string;
      avatarUrl: string | null;
      mrsCreated: number;
      reviewsGiven: number;
      commentsGiven: number;
      collaboratedWith: Set<string>;
    }
  >();

  // Seed contributors from commit-only devs so they appear even without MRs
  if (identities) {
    for (const identity of identities) {
      if (identity.commits > 0) {
        const handle = identity.email.split("@")[0] || identity.name;
        if (!contributors.has(identity.canonicalKey)) {
          contributors.set(identity.canonicalKey, {
            username: handle,
            name: identity.name,
            avatarUrl: null,
            mrsCreated: 0,
            reviewsGiven: 0,
            commentsGiven: 0,
            collaboratedWith: new Set<string>(),
          });
        }
      }
    }
  }

  for (const row of rows) {
    const authorSeed = resolveAuthorIdentitySeed(row.author_email, row.author_username);
    const authorIdentity = identityBySeed.get(authorSeed);
    const authorKey = authorIdentity?.canonicalKey || authorSeed;

    if (!contributors.has(authorKey)) {
      contributors.set(authorKey, {
        username: authorIdentity?.handle || row.author_username,
        name: authorIdentity?.name || row.canonical_author_name || row.author_name,
        avatarUrl: row.author_avatar_url,
        mrsCreated: 0,
        reviewsGiven: 0,
        commentsGiven: 0,
        collaboratedWith: new Set<string>(),
      });
    }

    contributors.get(authorKey)!.mrsCreated += 1;

    for (const reviewer of row.reviewers) {
      const reviewerSeed = sanitizeDeveloperEmail(reviewer.username);
      const reviewerIdentity = identityBySeed.get(reviewerSeed);
      const reviewerKey = reviewerIdentity?.canonicalKey || reviewerSeed;

      if (!contributors.has(reviewerKey)) {
        contributors.set(reviewerKey, {
          username: reviewerIdentity?.handle || reviewer.username,
          name: reviewerIdentity?.name || reviewer.name,
          avatarUrl: reviewer.avatar_url || null,
          mrsCreated: 0,
          reviewsGiven: 0,
          commentsGiven: 0,
          collaboratedWith: new Set<string>(),
        });
      }

      const contributor = contributors.get(reviewerKey)!;
      contributor.reviewsGiven += 1;
      contributor.commentsGiven += reviewer.comments;
      contributor.collaboratedWith.add(authorKey);
    }
  }

  return [...contributors.entries()]
    .map(([canonicalKey, contributor]) => ({
      canonicalKey,
      username: contributor.username,
      name: contributor.name,
      avatarUrl: contributor.avatarUrl,
      mrsCreated: contributor.mrsCreated,
      reviewsGiven: contributor.reviewsGiven,
      commentsGiven: contributor.commentsGiven,
      collaborationSize: contributor.collaboratedWith.size,
      reviewRatio: contributor.mrsCreated > 0 ? contributor.reviewsGiven / contributor.mrsCreated : 0,
      linesAdded: activityLookup.get(canonicalKey)?.linesAdded ?? 0,
      linesRemoved: activityLookup.get(canonicalKey)?.linesRemoved ?? 0,
    }))
    .sort((left, right) => {
      if (right.reviewsGiven !== left.reviewsGiven) {
        return right.reviewsGiven - left.reviewsGiven;
      }
      return right.commentsGiven - left.commentsGiven;
    });
}

// average, sumNumbers, sanitizeDeveloperEmail, resolveAuthorIdentitySeed, uniqueBy, localeCompare
// moved to @/lib/dashboard-utils

/* ------------------------------------------------------------------ */
/*  Executive Summary — Unified endpoint                               */
/* ------------------------------------------------------------------ */

/**
 * Response shape for the unified executive summary endpoint.
 * Combines DORA metrics, MR stats, and audit data in a single response.
 */
export interface ExecutiveSummaryResponse {
  deploymentFrequency: TrendMetric;
  leadTime: {
    value: TrendMetric;
    variant: LeadTimeVariant;
    variantCoverage: Record<LeadTimeVariant, number>;
  };
  changeFailureRate: {
    value: TrendMetric;
    confidenceLevel: "alta" | "media" | "baja";
    avgCorrelationConfidence: number;
    lowConfidenceWarning: boolean;
  };
  pipelineRecoveryTime: TrendMetric;
  totals: {
    deployments: number;
    failures: number;
    developers: number;
  };
  mrStats: {
    lifetime: { median: number; mean: number };
    leadTime: { median: number; mean: number };
    reviewTime: { median: number; mean: number };
    summary: { totalMRs: number; mergedMRs: number; openMRs: number; uniqueContributors: number };
  };
  audit: AuditSummary;
  errors: string[];
}

/**
 * Generates the unified executive summary in a single call.
 * Executes sub-queries in parallel and handles partial failures gracefully.
 */
export async function getExecutiveSummary(
  filters: DashboardFilters
): Promise<ExecutiveSummaryResponse> {
  const key = cacheKey(CACHE_PREFIXES.executive, {
    days: filters.days,
    teams: filters.teams,
    projectIds: filters.projectIds,
  });

  return cached(key, () => _getExecutiveSummaryImpl(filters));
}

async function _getExecutiveSummaryImpl(
  filters: DashboardFilters
): Promise<ExecutiveSummaryResponse> {
  const errors: string[] = [];

  // Execute all sub-queries in parallel
  const [doraResult, mrStatsResult, correlationResult, developersResult] = await Promise.allSettled([
    _queryDoraMetrics(filters),
    _queryMrStats(filters),
    _queryCorrelationData(filters),
    _queryDeveloperCount(filters),
  ]);

  // --- DORA metrics ---
  let deploymentFrequency: TrendMetric = metric(0, 0);
  let leadTimeValue: TrendMetric = metric(0, 0);
  let leadTimeVariant: LeadTimeVariant = "first_commit";
  let variantCoverage: Record<LeadTimeVariant, number> = { first_commit: 0, mr_created: 0, last_commit: 0 };
  let pipelineRecoveryTime: TrendMetric = metric(0, 0);
  let totalDeployments = 0;
  let totalFailures = 0;
  let anomalyCount = 0;
  let droppedDeployments = 0;
  let leadTimeCoveragePct = 0;

  if (doraResult.status === "fulfilled") {
    const dora = doraResult.value;
    deploymentFrequency = dora.deploymentFrequency;
    leadTimeValue = dora.leadTime;
    leadTimeVariant = dora.variant;
    variantCoverage = dora.variantCoverage;
    pipelineRecoveryTime = dora.pipelineRecoveryTime;
    totalDeployments = dora.totalDeployments;
    totalFailures = dora.totalFailures;
    anomalyCount = dora.anomalyCount;
    droppedDeployments = dora.droppedDeployments;
    leadTimeCoveragePct = dora.leadTimeCoveragePct;
  } else {
    errors.push("deploymentFrequency");
    errors.push("leadTime");
    errors.push("pipelineRecoveryTime");
  }

  // --- CFR with confidence filtering ---
  let cfrValue: TrendMetric = metric(0, 0);
  let avgCorrelationConfidence = 0;
  let lowConfidenceWarning = false;
  let confidenceLevel: "alta" | "media" | "baja" = "baja";

  if (doraResult.status === "fulfilled") {
    // Base CFR from DORA data
    cfrValue = metric(
      calculateChangeFailureRatePct(totalDeployments, totalFailures),
      0
    );
  }

  if (correlationResult.status === "fulfilled") {
    const corrData = correlationResult.value;
    avgCorrelationConfidence = corrData.avgConfidence;
    lowConfidenceWarning = corrData.lowConfidenceWarning;
    confidenceLevel = avgCorrelationConfidence >= 0.8
      ? "alta"
      : avgCorrelationConfidence >= 0.5
        ? "media"
        : "baja";

    // If we have correlation data, use it for CFR
    if (corrData.totalCorrelated > 0 && doraResult.status === "fulfilled") {
      const cfrCurrent = corrData.totalCorrelated > 0
        ? (corrData.runtimeFailures / corrData.totalCorrelated) * 100
        : calculateChangeFailureRatePct(totalDeployments, totalFailures);
      cfrValue = metric(cfrCurrent, cfrValue.previous);
    }
  } else if (correlationResult.status === "rejected") {
    errors.push("changeFailureRate.correlation");
  }

  // --- MR Stats ---
  let mrStats: ExecutiveSummaryResponse["mrStats"] = {
    lifetime: { median: 0, mean: 0 },
    leadTime: { median: 0, mean: 0 },
    reviewTime: { median: 0, mean: 0 },
    summary: { totalMRs: 0, mergedMRs: 0, openMRs: 0, uniqueContributors: 0 },
  };

  if (mrStatsResult.status === "fulfilled") {
    mrStats = mrStatsResult.value;
  } else {
    errors.push("mrStats");
  }

  // --- Developers count ---
  let developers = 0;
  if (developersResult.status === "fulfilled") {
    developers = developersResult.value;
  } else {
    errors.push("developers");
  }

  // --- Audit Summary ---
  const confidenceScore = calculateConfidenceScore({
    leadTimeCoveragePct,
    avgCorrelationConfidence,
    anomalyCount,
  });

  const checks: AuditCheck[] = [
    createAuditCheck(
      "lead_time_coverage",
      "Cobertura de Lead Time",
      leadTimeCoveragePct >= 70 ? "pass" : leadTimeCoveragePct >= 40 ? "warn" : "fail",
      `${leadTimeCoveragePct.toFixed(1)}%`,
      "Porcentaje de despliegues con lead time trazable."
    ),
    createAuditCheck(
      "correlation_confidence",
      "Confianza de Correlación",
      avgCorrelationConfidence >= 0.8 ? "pass" : avgCorrelationConfidence >= 0.5 ? "warn" : "fail",
      avgCorrelationConfidence.toFixed(2),
      "Confianza promedio de las correlaciones GitLab ↔ ArgoCD."
    ),
    createAuditCheck(
      "anomalies",
      "Anomalías Detectadas",
      anomalyCount === 0 ? "pass" : "warn",
      String(anomalyCount),
      "Número de anomalías de deployment frequency detectadas en el período."
    ),
    createAuditCheck(
      "dropped_deployments",
      "Despliegues Descartados",
      droppedDeployments === 0 ? "pass" : droppedDeployments <= 5 ? "warn" : "fail",
      String(droppedDeployments),
      `Despliegues excluidos por exceder el umbral de lead time (${LEAD_TIME_GUARD_HOURS}h).`
    ),
  ];

  const audit = buildAuditSummary({
    methodologyVersion: "executive-summary-v1.0",
    sourceOfTruth: "Endpoint unificado: DORA canónico + correlación runtime + gitlab_mr_analytics.",
    note: errors.length > 0
      ? `Resultados parciales: ${errors.join(", ")} no disponibles.`
      : "Todas las fuentes de datos respondieron correctamente.",
    coverageLabel: `${leadTimeCoveragePct.toFixed(0)}% despliegues con lead time`,
    coveragePct: leadTimeCoveragePct,
    checks,
  });

  return {
    deploymentFrequency,
    leadTime: {
      value: leadTimeValue,
      variant: leadTimeVariant,
      variantCoverage,
    },
    changeFailureRate: {
      value: cfrValue,
      confidenceLevel,
      avgCorrelationConfidence,
      lowConfidenceWarning,
    },
    pipelineRecoveryTime,
    totals: {
      deployments: totalDeployments,
      failures: totalFailures,
      developers,
    },
    mrStats,
    audit,
    errors,
  };
}

/* ------------------------------------------------------------------ */
/*  Executive Summary — Sub-queries                                     */
/* ------------------------------------------------------------------ */

type DoraQueryResult = {
  deploymentFrequency: TrendMetric;
  leadTime: TrendMetric;
  variant: LeadTimeVariant;
  variantCoverage: Record<LeadTimeVariant, number>;
  pipelineRecoveryTime: TrendMetric;
  totalDeployments: number;
  totalFailures: number;
  anomalyCount: number;
  droppedDeployments: number;
  leadTimeCoveragePct: number;
};

async function _queryDoraMetrics(filters: DashboardFilters): Promise<DoraQueryResult> {
  const endDate = new Date();
  const startDate = subDays(endDate, filters.days);
  const previousStartDate = subDays(startDate, filters.days);
  const startStr = format(previousStartDate, "yyyy-MM-dd");
  const endStr = format(endDate, "yyyy-MM-dd");
  const cutoffDate = format(startDate, "yyyy-MM-dd");

  const doraScopeFilters = { ...filters, developers: [] };
  const { clause: filterClause, params: filterParams } = buildWhereClause(doraScopeFilters, 3);

  const query = `
    SELECT
      snapshot_date,
      SUM(deployment_count) AS deployments,
      SUM(COALESCE(lead_time_first_commit_sum_hours, 0)) AS lead_time_first_commit_sum,
      SUM(COALESCE(lead_time_first_commit_count, 0)) AS lead_time_first_commit_count,
      SUM(COALESCE(lead_time_mr_sum_hours, 0)) AS lead_time_mr_sum,
      SUM(COALESCE(lead_time_mr_count, 0)) AS lead_time_mr_count,
      SUM(COALESCE(lead_time_sum_hours, 0)) AS lead_time_sum,
      SUM(COALESCE(lead_time_count, 0)) AS lead_time_count,
      SUM(COALESCE(mttr_sum_hours, 0)) AS mttr_sum,
      SUM(COALESCE(mttr_count, 0)) AS mttr_count,
      SUM(COALESCE(deployment_failures, 0)) AS failures,
      COUNT(DISTINCT project_id) FILTER (
        WHERE deployment_count > 0 OR COALESCE(deployment_failures, 0) > 0
      ) AS project_count
    FROM dora_metrics_daily
    WHERE snapshot_date >= $1 AND snapshot_date <= $2
    ${filterClause}
    GROUP BY snapshot_date
    ORDER BY snapshot_date ASC
  `;

  const result = await pool.query<DoraDailyRow>(query, [startStr, endStr, ...filterParams]);
  const rows = result.rows;

  const toDateStr = (d: unknown) => normalizeSnapshotDate(d);
  const currentRows = rows.filter((row) => toDateStr(row.snapshot_date) >= cutoffDate);
  const previousRows = rows.filter((row) => toDateStr(row.snapshot_date) < cutoffDate);

  const sum = (r: DoraDailyRow[], field: keyof DoraDailyRow) =>
    r.reduce((total, row) => total + toNumber(row[field]), 0);

  const currentDeployments = sum(currentRows, "deployments");
  const previousDeployments = sum(previousRows, "deployments");
  const currentProjectDays = sum(currentRows, "project_count");
  const previousProjectDays = sum(previousRows, "project_count");
  const currentFailures = sum(currentRows, "failures");

  // Deployment Frequency
  const currentFrequency = calculateDeploymentFrequencyPerProjectDay(currentDeployments, currentProjectDays);
  const previousFrequency = calculateDeploymentFrequencyPerProjectDay(previousDeployments, previousProjectDays);

  // Lead Time — use selectLeadTimeWithVariant for canonical selection
  const currentLeadFirstCommit = aggregateLeadTimeFromDailyRows(currentRows, "lead_time_first_commit_sum", "lead_time_first_commit_count");
  const previousLeadFirstCommit = aggregateLeadTimeFromDailyRows(previousRows, "lead_time_first_commit_sum", "lead_time_first_commit_count");
  const currentLeadMr = aggregateLeadTimeFromDailyRows(currentRows, "lead_time_mr_sum", "lead_time_mr_count");
  const previousLeadMr = aggregateLeadTimeFromDailyRows(previousRows, "lead_time_mr_sum", "lead_time_mr_count");
  const currentLeadCommit = aggregateLeadTimeFromDailyRows(currentRows, "lead_time_sum", "lead_time_count");
  const previousLeadCommit = aggregateLeadTimeFromDailyRows(previousRows, "lead_time_sum", "lead_time_count");

  // Use canonical selection for current and previous lead time
  const currentSelection = selectLeadTimeWithVariant(
    currentLeadFirstCommit.average > 0 ? currentLeadFirstCommit.average : null,
    currentLeadMr.average > 0 ? currentLeadMr.average : null,
    currentLeadCommit.average > 0 ? currentLeadCommit.average : null
  );
  const previousSelection = selectLeadTimeWithVariant(
    previousLeadFirstCommit.average > 0 ? previousLeadFirstCommit.average : null,
    previousLeadMr.average > 0 ? previousLeadMr.average : null,
    previousLeadCommit.average > 0 ? previousLeadCommit.average : null
  );

  const leadTimeVariant: LeadTimeVariant = currentSelection?.variant ?? "first_commit";
  const leadTimeCurrent = currentSelection?.hours ?? 0;
  const leadTimePrevious = previousSelection?.hours ?? 0;

  // Variant coverage: percentage of deployments that used each variant
  const totalLeadTimeSamples = currentLeadFirstCommit.count + currentLeadMr.count + currentLeadCommit.count;
  const variantCoverage: Record<LeadTimeVariant, number> = {
    first_commit: totalLeadTimeSamples > 0 ? (currentLeadFirstCommit.count / totalLeadTimeSamples) * 100 : 0,
    mr_created: totalLeadTimeSamples > 0 ? (currentLeadMr.count / totalLeadTimeSamples) * 100 : 0,
    last_commit: totalLeadTimeSamples > 0 ? (currentLeadCommit.count / totalLeadTimeSamples) * 100 : 0,
  };

  // Lead time coverage: percentage of deployments with any lead time data
  const leadTimeCoveragePct = currentDeployments > 0
    ? Math.min(100, (Math.max(currentLeadFirstCommit.count, currentLeadMr.count, currentLeadCommit.count) / currentDeployments) * 100)
    : 0;

  // Pipeline Recovery Time (formerly MTTR)
  const currentMttr = averageFromSums(currentRows, "mttr_sum", "mttr_count");
  const previousMttr = averageFromSums(previousRows, "mttr_sum", "mttr_count");

  // Anomalies
  const anomalyCount = isAnomalousDeploymentFrequency(currentFrequency) ? 1 : 0;

  // Dropped deployments: count deployments that exceeded the lead time guard
  // We approximate this from the difference between total deployments and those with valid lead time
  const droppedDeployments = 0; // Exact count requires trace-level data; set to 0 for now

  return {
    deploymentFrequency: metric(currentFrequency, previousFrequency),
    leadTime: metric(leadTimeCurrent, leadTimePrevious),
    variant: leadTimeVariant,
    variantCoverage,
    pipelineRecoveryTime: metric(currentMttr, previousMttr),
    totalDeployments: Math.round(currentDeployments),
    totalFailures: Math.round(currentFailures),
    anomalyCount,
    droppedDeployments,
    leadTimeCoveragePct,
  };
}

type CorrelationQueryResult = {
  avgConfidence: number;
  lowConfidenceWarning: boolean;
  totalCorrelated: number;
  runtimeFailures: number;
};

async function _queryCorrelationData(filters: DashboardFilters): Promise<CorrelationQueryResult> {
  const endDate = new Date();
  const startDate = subDays(endDate, filters.days);
  const startStr = format(startDate, "yyyy-MM-dd");
  const endStr = format(endDate, "yyyy-MM-dd");

  const params: unknown[] = [startStr, endStr];
  const conditions = [
    "correlation_date >= $1",
    "correlation_date <= $2",
  ];

  if (filters.teams.length > 0) {
    conditions.push(`gitlab_project_id IN (
      SELECT DISTINCT project_id FROM dora_metrics_daily WHERE team = ANY($${params.length + 1})
    )`);
    params.push(filters.teams);
  }
  if (filters.projectIds.length > 0) {
    conditions.push(`gitlab_project_id = ANY($${params.length + 1})`);
    params.push(filters.projectIds);
  }

  const result = await pool.query<{
    total_correlations: string | number | null;
    avg_confidence: string | number | null;
    runtime_failures: string | number | null;
  }>(
    `
      SELECT
        COUNT(*) AS total_correlations,
        AVG(COALESCE(correlation_confidence, 0)) AS avg_confidence,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(argocd_sync_status, '')) IN ('failed', 'error')
            OR LOWER(COALESCE(argocd_health_status, '')) = 'degraded'
        ) AS runtime_failures
      FROM deployment_correlation
      WHERE ${conditions.join(" AND ")}
    `,
    params
  );

  const row = result.rows[0];
  const totalCorrelations = toNumber(row?.total_correlations);
  const avgConfidence = toNumber(row?.avg_confidence);
  const runtimeFailures = toNumber(row?.runtime_failures);

  // Build a minimal correlation array to check low confidence warning
  // We use the count of correlations below threshold vs total
  const belowThresholdResult = await pool.query<{ below_count: string | number | null }>(
    `
      SELECT COUNT(*) AS below_count
      FROM deployment_correlation
      WHERE ${conditions.join(" AND ")}
        AND COALESCE(correlation_confidence, 0) < $${params.length + 1}
    `,
    [...params, MIN_CORRELATION_CONFIDENCE]
  );

  const belowCount = toNumber(belowThresholdResult.rows[0]?.below_count);
  const lowConfidenceWarning = totalCorrelations > 0 && (belowCount / totalCorrelations) > 0.3;

  // Filter by confidence: only count high-confidence correlations for CFR
  const highConfResult = await pool.query<{
    high_conf_total: string | number | null;
    high_conf_failures: string | number | null;
  }>(
    `
      SELECT
        COUNT(*) AS high_conf_total,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(argocd_sync_status, '')) IN ('failed', 'error')
            OR LOWER(COALESCE(argocd_health_status, '')) = 'degraded'
        ) AS high_conf_failures
      FROM deployment_correlation
      WHERE ${conditions.join(" AND ")}
        AND COALESCE(correlation_confidence, 0) >= $${params.length + 1}
    `,
    [...params, MIN_CORRELATION_CONFIDENCE]
  );

  const totalCorrelated = toNumber(highConfResult.rows[0]?.high_conf_total);
  const highConfFailures = toNumber(highConfResult.rows[0]?.high_conf_failures);

  return {
    avgConfidence,
    lowConfidenceWarning,
    totalCorrelated,
    runtimeFailures: highConfFailures,
  };
}

async function _queryMrStats(
  filters: DashboardFilters
): Promise<ExecutiveSummaryResponse["mrStats"]> {
  const endDate = new Date();
  const startDate = subDays(endDate, filters.days);

  // Canonical semantics (same as latestMrCte / the manager dashboard):
  // deduplicate to the latest snapshot per (project_id, mr_iid) and window by
  // reference_at (merged_at for merged, created_at otherwise), NOT by
  // snapshot_date. Filtering raw rows by snapshot_date counted each MR once per
  // daily snapshot and widened the window to the full 90-day backlog.
  const { clause: scopeClause, params: scopeParams } = buildWhereClause(filters, 1, {
    teamColumn: "team",
    projectColumn: "project_id",
  });
  const startParam = scopeParams.length + 1;
  const endParam = scopeParams.length + 2;

  const result = await pool.query<{
    lifetime_hours: string | number | null;
    lead_time_hours: string | number | null;
    review_time_hours: string | number | null;
    state: string;
    author_username: string;
  }>(
    `
      WITH latest AS (
        SELECT DISTINCT ON (project_id, mr_iid)
          lifetime_hours,
          lead_time_hours,
          review_time_hours,
          state,
          author_username,
          CASE
            WHEN state = 'merged' AND merged_at IS NOT NULL THEN merged_at
            ELSE created_at
          END AS reference_at,
          snapshot_date
        FROM gitlab_mr_analytics
        WHERE 1 = 1
        ${scopeClause}
        ORDER BY project_id, mr_iid, snapshot_date DESC
      )
      SELECT
        lifetime_hours,
        lead_time_hours,
        review_time_hours,
        state,
        author_username
      FROM latest
      WHERE reference_at >= $${startParam} AND reference_at <= $${endParam}
    `,
    [...scopeParams, startDate.toISOString(), endDate.toISOString()]
  );

  const allMRs = result.rows;
  const mergedMRs = allMRs.filter((mr) => mr.state === "merged");
  const openMRs = allMRs.filter((mr) => mr.state === "opened");

  const lifetimeValues = mergedMRs.map((mr) => toNumber(mr.lifetime_hours));
  const leadTimeValues = allMRs.map((mr) => toNumber(mr.lead_time_hours));
  const reviewTimeValues = mergedMRs
    .map((mr) => toNumber(mr.review_time_hours))
    .filter((v) => v > 0);

  const uniqueContributors = new Set(allMRs.map((mr) => mr.author_username)).size;

  return {
    lifetime: {
      median: lifetimeValues.length > 0 ? median(lifetimeValues) : 0,
      mean: lifetimeValues.length > 0 ? average(lifetimeValues) : 0,
    },
    leadTime: {
      median: leadTimeValues.length > 0 ? median(leadTimeValues) : 0,
      mean: leadTimeValues.length > 0 ? average(leadTimeValues) : 0,
    },
    reviewTime: {
      median: reviewTimeValues.length > 0 ? median(reviewTimeValues, true) : 0,
      mean: reviewTimeValues.length > 0 ? average(reviewTimeValues) : 0,
    },
    summary: {
      totalMRs: allMRs.length,
      mergedMRs: mergedMRs.length,
      openMRs: openMRs.length,
      uniqueContributors,
    },
  };
}

async function _queryDeveloperCount(filters: DashboardFilters): Promise<number> {
  const endDate = new Date();
  const startDate = subDays(endDate, filters.days);
  const startStr = format(startDate, "yyyy-MM-dd");
  const endStr = format(endDate, "yyyy-MM-dd");

  const params: unknown[] = [startStr, endStr];
  const conditions = [
    "snapshot_date >= $1",
    "snapshot_date <= $2",
  ];

  if (filters.teams.length > 0) {
    conditions.push(`team = ANY($${params.length + 1})`);
    params.push(filters.teams);
  }
  if (filters.projectIds.length > 0) {
    conditions.push(`project_id = ANY($${params.length + 1})`);
    params.push(filters.projectIds);
  }

  const result = await pool.query<{ developer_count: string | number | null }>(
    `
      SELECT COUNT(DISTINCT author_email) AS developer_count
      FROM developer_activity_daily
      WHERE ${conditions.join(" AND ")}
        AND author_email IS NOT NULL
        AND author_email != ''
    `,
    params
  );

  return toNumber(result.rows[0]?.developer_count);
}
