import { subDays } from "date-fns";
import pool from "@/lib/db";
import { grafanaMetricsClient, type GrafanaMetricsStatus, type PrometheusMatrixResult, type PrometheusVectorResult } from "@/lib/grafana-metrics";

type AppInfoLabels = Record<string, string> & {
  name?: string;
  namespace?: string;
  dest_namespace?: string;
  dest_server?: string;
  cluster?: string;
  k8s_cluster_name?: string;
  project?: string;
  repo?: string;
  operation?: string;
  service?: string;
  sync_status?: string;
  health_status?: string;
};

type SyncMetricLabels = Record<string, string> & {
  name?: string;
  namespace?: string;
  dest_namespace?: string;
  project?: string;
  phase?: string;
};

type ArgocdRuntimeConfig = {
  infoMetric: string;
  labelsMetric: string;
  syncMetric: string;
  phaseLabel: string;
  namespaceLabel: string;
  repoLabel: string | null;
  clusterLabel: string | null;
  clusterFallbackLabel: string | null;
  teamLabel: string | null;
  serviceLabel: string | null;
  environmentLabel: string | null;
  productionValues: string[];
  productionClusterRegex: string | null;
  productionOnly: boolean;
  appNameRegex: string | null;
  projectRegex: string | null;
  namespaceRegex: string | null;
  successPhases: string[];
  failurePhases: string[];
};

export type ArgocdRuntimeFilters = {
  days: number;
  teams?: string[];
  serviceKeys?: string[];
  projectIds?: number[];
};

type RuntimeApp = {
  key: string;
  name: string;
  sourceNamespace: string | null;
  destinationNamespace: string | null;
  project: string | null;
  repo: string | null;
  cluster: string | null;
  operation: string | null;
  syncStatus: string | null;
  healthStatus: string | null;
  team: string | null;
  service: string | null;
  environment: string | null;
  gitlabProjectId: number | null;
  gitlabProjectName: string | null;
  gitlabProjectPath: string | null;
  mappingReason: string | null;
  labelContext: boolean;
  totalSyncs: number;
  successfulSyncs: number;
  failedSyncs: number;
  unclassifiedSyncs: number;
  lastSyncDate: string | null;
};

type RuntimeTrendRow = {
  date: string;
  totalSyncs: number;
  successfulSyncs: number;
  failedSyncs: number;
  unclassifiedSyncs: number;
};

export type ArgocdRuntimeResponse = {
  status: GrafanaMetricsStatus & {
    source: "grafana-cloud-prometheus";
    scope: "production-labeled" | "regex-filtered" | "all-apps-fallback";
    labelContextAvailable: boolean;
    productionFilterApplied: boolean;
  };
  summary: {
    activeApplications: number;
    healthyApplications: number;
    degradedApplications: number;
    outOfSyncApplications: number;
    labelledApplications: number;
    totalSyncs: number;
    successfulSyncs: number;
    failedSyncs: number;
    unclassifiedSyncs: number;
    healthRate: number;
  };
  trend: RuntimeTrendRow[];
  applications: RuntimeApp[];
  warnings: string[];
  meta: {
    daysRequested: number;
    latestDate: string | null;
    filtersApplied: {
      teams: string[];
      serviceKeys: string[];
      projectIds: number[];
    };
    configuredLabels: {
      team: string | null;
      service: string | null;
      environment: string | null;
    };
    productionValues: string[];
  };
};

type ProjectCatalogRow = {
  project_id: number;
  project_name: string;
  project_path: string | null;
  team: string | null;
};

function parseCsv(value: string | null | undefined, fallback: string[] = []) {
  if (!value) return fallback;
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  return values.length > 0 ? values : fallback;
}

function resolveRuntimeConfig(): ArgocdRuntimeConfig {
  return {
    infoMetric: process.env.GRAFANA_ARGO_INFO_METRIC?.trim() || "argocd_app_info",
    labelsMetric: process.env.GRAFANA_ARGO_LABELS_METRIC?.trim() || "argocd_app_labels",
    syncMetric: process.env.GRAFANA_ARGO_SYNC_METRIC?.trim() || "argocd_app_sync_total",
    phaseLabel: process.env.GRAFANA_ARGO_SYNC_PHASE_LABEL?.trim() || "phase",
    namespaceLabel: process.env.GRAFANA_ARGO_DEST_NAMESPACE_LABEL?.trim() || "dest_namespace",
    repoLabel: process.env.GRAFANA_ARGO_REPO_LABEL?.trim() || "repo",
    clusterLabel: process.env.GRAFANA_ARGO_CLUSTER_LABEL?.trim() || "k8s_cluster_name",
    clusterFallbackLabel: process.env.GRAFANA_ARGO_CLUSTER_FALLBACK_LABEL?.trim() || "cluster",
    teamLabel: process.env.GRAFANA_ARGO_TEAM_LABEL?.trim() || null,
    serviceLabel: process.env.GRAFANA_ARGO_SERVICE_LABEL?.trim() || null,
    environmentLabel: process.env.GRAFANA_ARGO_ENVIRONMENT_LABEL?.trim() || null,
    productionValues: parseCsv(process.env.GRAFANA_ARGO_PRODUCTION_VALUES, ["production", "prod"]),
    productionClusterRegex: process.env.GRAFANA_ARGO_PRODUCTION_CLUSTER_REGEX?.trim() || "prod",
    productionOnly: (process.env.GRAFANA_ARGO_PRODUCTION_ONLY || "true").toLowerCase() !== "false",
    appNameRegex: process.env.GRAFANA_ARGO_APP_INCLUDE_REGEX?.trim() || null,
    projectRegex: process.env.GRAFANA_ARGO_PROJECT_INCLUDE_REGEX?.trim() || null,
    namespaceRegex: process.env.GRAFANA_ARGO_NAMESPACE_INCLUDE_REGEX?.trim() || null,
    successPhases: parseCsv(process.env.GRAFANA_ARGO_SUCCESS_PHASES, ["Succeeded"]),
    failurePhases: parseCsv(process.env.GRAFANA_ARGO_FAILURE_PHASES, ["Failed", "Error"]),
  };
}

function buildAppKey(labels: { name?: string; project?: string }) {
  return [
    labels.project || "default",
    labels.name || "unknown-app",
  ].join("::");
}

function safeNumber(value: string | number | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }
  return 0;
}

function formatDay(timestampSeconds: string | number) {
  const value = typeof timestampSeconds === "string" ? Number(timestampSeconds) : timestampSeconds;
  return new Date(value * 1000).toISOString().slice(0, 10);
}

function matchesRegex(value: string | null | undefined, expression: string | null) {
  if (!expression) return true;
  if (!value) return false;
  try {
    return new RegExp(expression, "i").test(value);
  } catch {
    return true;
  }
}

function normalizeRuntimeLabel(value: string | null | undefined) {
  return value?.trim().toLowerCase() || null;
}

function normalizeKey(value: string | null | undefined) {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function basename(path: string | null | undefined) {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function deriveLogicalServiceName(name: string | null | undefined, destinationNamespace: string | null | undefined) {
  if (!name) return null;
  const namespace = normalizeKey(destinationNamespace);
  let candidate = normalizeKey(name);

  if (candidate.endsWith("-helm")) {
    candidate = candidate.slice(0, -"-helm".length);
  }

  if (namespace && candidate.startsWith(`${namespace}-`)) {
    candidate = candidate.slice(namespace.length + 1);
  }

  return candidate || normalizeKey(name);
}

function parseGitLabProjectIdFromRepo(repo: string | null | undefined) {
  if (!repo) return null;
  const match = repo.match(/\/projects\/(\d+)\//i);
  if (!match) return null;
  const numeric = Number(match[1]);
  return Number.isFinite(numeric) ? numeric : null;
}

async function loadProjectCatalog() {
  const result = await pool.query<ProjectCatalogRow>(`
    SELECT DISTINCT ON (project_id)
      project_id,
      project_name,
      project_path,
      team
    FROM dora_metrics_daily
    WHERE snapshot_date >= NOW() - INTERVAL '365 days'
    ORDER BY project_id, snapshot_date DESC
  `);

  return result.rows.map((row) => ({
    id: row.project_id,
    name: row.project_name,
    path: row.project_path,
    team: normalizeKey(row.team),
    normalizedName: normalizeKey(row.project_name),
    normalizedPath: normalizeKey(basename(row.project_path)),
  }));
}

function resolveProjectMapping(
  app: RuntimeApp,
  catalog: Awaited<ReturnType<typeof loadProjectCatalog>>
) {
  const repoProjectId = parseGitLabProjectIdFromRepo(app.repo);
  if (repoProjectId) {
    const direct = catalog.find((entry) => entry.id === repoProjectId);
    if (direct) {
      return {
        gitlabProjectId: direct.id,
        gitlabProjectName: direct.name,
        gitlabProjectPath: direct.path,
        mappingReason: "repo-project-id",
      };
    }
  }

  const appKey = deriveLogicalServiceName(app.name, app.destinationNamespace);
  const scopedCatalog = catalog.filter((entry) => !app.team || entry.team === normalizeKey(app.team));

  if (appKey) {
    const exact = scopedCatalog.find((entry) => entry.normalizedName === appKey || entry.normalizedPath === appKey);
    if (exact) {
      return {
        gitlabProjectId: exact.id,
        gitlabProjectName: exact.name,
        gitlabProjectPath: exact.path,
        mappingReason: "derived-app-name",
      };
    }
  }

  return {
    gitlabProjectId: null,
    gitlabProjectName: null,
    gitlabProjectPath: null,
    mappingReason: null,
  };
}

function deriveCluster(metric: Record<string, string>, config: ArgocdRuntimeConfig) {
  if (config.clusterLabel && metric[config.clusterLabel]) return metric[config.clusterLabel];
  if (config.clusterFallbackLabel && metric[config.clusterFallbackLabel]) return metric[config.clusterFallbackLabel];
  return null;
}

function deriveEnvironment(metric: Record<string, string>, config: ArgocdRuntimeConfig) {
  if (config.environmentLabel && metric[config.environmentLabel]) {
    return metric[config.environmentLabel];
  }

  const cluster = deriveCluster(metric, config);
  if (!cluster) return null;

  if (config.productionClusterRegex) {
    try {
      if (new RegExp(config.productionClusterRegex, "i").test(cluster)) {
        return "production";
      }
    } catch {
      if (cluster.toLowerCase().includes(config.productionClusterRegex.toLowerCase())) {
        return "production";
      }
    }
  }

  return cluster;
}

function isProductionApp(app: RuntimeApp, config: ArgocdRuntimeConfig) {
  if (!config.productionOnly) return true;

  const environment = normalizeRuntimeLabel(app.environment);
  if (environment && (config.productionValues.includes(environment) || environment === "production")) {
    return true;
  }

  if (app.cluster && config.productionClusterRegex) {
    try {
      return new RegExp(config.productionClusterRegex, "i").test(app.cluster);
    } catch {
      return app.cluster.toLowerCase().includes(config.productionClusterRegex.toLowerCase());
    }
  }

  return false;
}

function emptyRuntimeResponse(status: GrafanaMetricsStatus, days: number, warnings: string[]): ArgocdRuntimeResponse {
  return {
    status: {
      ...status,
      source: "grafana-cloud-prometheus",
      scope: "all-apps-fallback",
      labelContextAvailable: false,
      productionFilterApplied: false,
    },
    summary: {
      activeApplications: 0,
      healthyApplications: 0,
      degradedApplications: 0,
      outOfSyncApplications: 0,
      labelledApplications: 0,
      totalSyncs: 0,
      successfulSyncs: 0,
      failedSyncs: 0,
      unclassifiedSyncs: 0,
      healthRate: 0,
    },
    trend: [],
    applications: [],
    warnings,
    meta: {
      daysRequested: days,
      latestDate: null,
      filtersApplied: {
        teams: [],
        serviceKeys: [],
        projectIds: [],
      },
      configuredLabels: {
        team: null,
        service: null,
        environment: null,
      },
      productionValues: [],
    },
  };
}

export async function getArgocdRuntimeOverview(filters: ArgocdRuntimeFilters): Promise<ArgocdRuntimeResponse> {
  const status = grafanaMetricsClient.getStatus();
  const config = resolveRuntimeConfig();
  const warnings: string[] = [];

  if (!status.ready) {
    return emptyRuntimeResponse(status, filters.days, [
      ...status.notes,
      `Faltan variables para runtime delivery: ${status.missing.join(", ")}`,
    ]);
  }

  const endDate = new Date();
  const startDate = subDays(endDate, Math.max(filters.days, 1));

  const appInfoDimensions = [
    "name",
    "namespace",
    config.namespaceLabel,
    "project",
    config.repoLabel || "repo",
    config.clusterLabel || "k8s_cluster_name",
    config.clusterFallbackLabel || "cluster",
    "operation",
    "sync_status",
    "health_status",
  ].filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);
  const appInfoQuery = `max by (${appInfoDimensions.join(", ")}) (${config.infoMetric})`;
  const labelDimensions = [
    "name",
    "project",
    config.namespaceLabel,
    config.repoLabel,
    config.clusterLabel,
    config.clusterFallbackLabel,
    config.teamLabel,
    config.serviceLabel,
    config.environmentLabel,
  ]
    .filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);
  const appLabelsQuery = labelDimensions.length > 3
    ? `max by (${labelDimensions.join(", ")}) (${config.labelsMetric})`
    : null;
  const syncQuery = `sum by (name, project, ${config.phaseLabel}) (increase(${config.syncMetric}[1d]))`;
  const totalSyncFallbackQuery = `sum by (name, project) (increase(${config.syncMetric}[1d]))`;

  const [infoResult, labelsResult, syncResult] = await Promise.all([
    grafanaMetricsClient.query<AppInfoLabels>(appInfoQuery),
    appLabelsQuery
      ? grafanaMetricsClient.query<Record<string, string>>(appLabelsQuery).catch((error) => {
          warnings.push(`No se pudo leer ${config.labelsMetric}: ${error instanceof Error ? error.message : "unknown error"}`);
          return { result: [], warnings: [] };
        })
      : Promise.resolve({ result: [], warnings: [] }),
    grafanaMetricsClient.queryRange<SyncMetricLabels>(syncQuery, {
      start: startDate,
      end: endDate,
      step: "86400",
    }).catch(async (error) => {
      warnings.push(`No se pudo separar syncs por fase: ${error instanceof Error ? error.message : "unknown error"}`);
      const fallback = await grafanaMetricsClient.queryRange<Record<string, string>>(totalSyncFallbackQuery, {
        start: startDate,
        end: endDate,
        step: "86400",
      });
      return fallback as { result: PrometheusMatrixResult<SyncMetricLabels>[]; warnings: string[] };
    }),
  ]);

  warnings.push(...infoResult.warnings, ...labelsResult.warnings, ...syncResult.warnings);

  if (appLabelsQuery && labelsResult.result.length === 0) {
    warnings.push(`No hay series utilizables en ${config.labelsMetric}. El filtrado por produccion, team y service puede quedar degradado.`);
  }

  const projectCatalog = await loadProjectCatalog().catch((error) => {
    warnings.push(`No se pudo cargar el catalogo GitLab local para mapear apps runtime: ${error instanceof Error ? error.message : "unknown error"}`);
    return [];
  });

  const apps = new Map<string, RuntimeApp>();

  for (const item of infoResult.result) {
    const key = buildAppKey(item.metric);
    apps.set(key, {
      key,
      name: item.metric.name || "unknown-app",
      sourceNamespace: item.metric.namespace || null,
      destinationNamespace: item.metric[config.namespaceLabel] || item.metric.dest_namespace || null,
      project: item.metric.project || null,
      repo: config.repoLabel ? item.metric[config.repoLabel] || item.metric.repo || null : item.metric.repo || null,
      cluster: deriveCluster(item.metric, config),
      operation: item.metric.operation || null,
      syncStatus: item.metric.sync_status || null,
      healthStatus: item.metric.health_status || null,
      team: item.metric[config.namespaceLabel] || item.metric.dest_namespace || null,
      service: config.serviceLabel
        ? item.metric[config.serviceLabel] || null
        : deriveLogicalServiceName(item.metric.name, item.metric[config.namespaceLabel] || item.metric.dest_namespace || null),
      environment: deriveEnvironment(item.metric, config),
      gitlabProjectId: null,
      gitlabProjectName: null,
      gitlabProjectPath: null,
      mappingReason: null,
      labelContext: false,
      totalSyncs: 0,
      successfulSyncs: 0,
      failedSyncs: 0,
      unclassifiedSyncs: 0,
      lastSyncDate: null,
    });
  }

  for (const item of labelsResult.result) {
    const key = buildAppKey(item.metric);
    const current = apps.get(key);
    if (!current) continue;
    current.team = config.teamLabel ? item.metric[config.teamLabel] || current.team : current.team;
    current.service = config.serviceLabel
      ? item.metric[config.serviceLabel] || current.service
      : current.service;
    current.environment = deriveEnvironment(item.metric, config) || current.environment;
    current.repo = config.repoLabel ? item.metric[config.repoLabel] || current.repo : current.repo;
    current.cluster = deriveCluster(item.metric, config) || current.cluster;
    current.destinationNamespace = item.metric[config.namespaceLabel] || current.destinationNamespace;
    current.labelContext = Boolean(
      current.team || current.service || current.environment || current.destinationNamespace || current.cluster || current.repo
    );
  }

  for (const app of apps.values()) {
    const mapping = resolveProjectMapping(app, projectCatalog);
    app.gitlabProjectId = mapping.gitlabProjectId;
    app.gitlabProjectName = mapping.gitlabProjectName;
    app.gitlabProjectPath = mapping.gitlabProjectPath;
    app.mappingReason = mapping.mappingReason;
  }

  const trendByDate = new Map<string, RuntimeTrendRow>();
  const successSet = new Set(config.successPhases.map((phase) => phase.toLowerCase()));
  const failureSet = new Set(config.failurePhases.map((phase) => phase.toLowerCase()));
  let splitByPhaseAvailable = true;

  for (const item of syncResult.result) {
    const key = buildAppKey(item.metric);
    const current = apps.get(key);
    if (!current) continue;

    const phase = normalizeRuntimeLabel(item.metric[config.phaseLabel]);
    if (!phase) splitByPhaseAvailable = false;

    for (const value of item.values) {
      const day = formatDay(value[0]);
      const count = safeNumber(value[1]);
      if (count <= 0) continue;

      const trend = trendByDate.get(day) || {
        date: day,
        totalSyncs: 0,
        successfulSyncs: 0,
        failedSyncs: 0,
        unclassifiedSyncs: 0,
      };

      trend.totalSyncs += count;
      current.totalSyncs += count;
      current.lastSyncDate = day;

      if (phase && successSet.has(phase)) {
        trend.successfulSyncs += count;
        current.successfulSyncs += count;
      } else if (phase && failureSet.has(phase)) {
        trend.failedSyncs += count;
        current.failedSyncs += count;
      } else {
        trend.unclassifiedSyncs += count;
        current.unclassifiedSyncs += count;
      }

      trendByDate.set(day, trend);
    }
  }

  if (!splitByPhaseAvailable) {
    warnings.push(`La métrica ${config.syncMetric} no expone claramente la label ${config.phaseLabel}; los syncs quedan parcialmente sin clasificar.`);
  }

  const fallbackToAllApps = config.productionOnly
    && !config.environmentLabel
    && !config.productionClusterRegex
    && !config.appNameRegex
    && !config.projectRegex
    && !config.namespaceRegex;
  if (fallbackToAllApps) {
    warnings.push("No hay label o regex de producción configurado. Runtime delivery está leyendo todas las apps de ArgoCD.");
  }

  const filteredApps = Array.from(apps.values()).filter((app) => {
    const environmentMatch = config.productionOnly
      ? isProductionApp(app, config)
      : true;

    const regexMatch = matchesRegex(app.name, config.appNameRegex)
      && matchesRegex(app.project, config.projectRegex)
      && matchesRegex(app.destinationNamespace, config.namespaceRegex);

    const teamMatch = filters.teams && filters.teams.length > 0
      ? app.team
        ? filters.teams.includes(app.team)
        : true
      : true;

    const serviceMatch = filters.serviceKeys && filters.serviceKeys.length > 0
      ? app.service
        ? filters.serviceKeys.includes(app.service)
        : true
      : true;

    const projectMatch = filters.projectIds && filters.projectIds.length > 0
      ? app.gitlabProjectId
        ? filters.projectIds.includes(app.gitlabProjectId)
        : false
      : true;

    return environmentMatch && regexMatch && teamMatch && serviceMatch && projectMatch;
  });

  if ((filters.teams?.length || 0) > 0 && !config.teamLabel) {
    warnings.push("Se han pedido filtros de team, pero no hay label runtime de team configurada. El filtro de team no se aplica a Argo.");
  }

  const filteredKeys = new Set(filteredApps.map((app) => app.key));
  const filteredTrend = Array.from(trendByDate.values())
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((row) => ({ ...row, totalSyncs: 0, successfulSyncs: 0, failedSyncs: 0, unclassifiedSyncs: 0 }));

  const trendIndex = new Map(filteredTrend.map((row) => [row.date, row]));

  for (const item of syncResult.result) {
    const key = buildAppKey(item.metric);
    if (!filteredKeys.has(key)) continue;

    const phase = normalizeRuntimeLabel(item.metric[config.phaseLabel]);
    for (const value of item.values) {
      const day = formatDay(value[0]);
      const count = safeNumber(value[1]);
      if (count <= 0) continue;
      const current = trendIndex.get(day);
      if (!current) continue;
      current.totalSyncs += count;
      if (phase && successSet.has(phase)) current.successfulSyncs += count;
      else if (phase && failureSet.has(phase)) current.failedSyncs += count;
      else current.unclassifiedSyncs += count;
    }
  }

  const summary = filteredApps.reduce(
    (accumulator, app) => {
      accumulator.activeApplications += 1;
      if ((app.healthStatus || "").toLowerCase() === "healthy") accumulator.healthyApplications += 1;
      if ((app.healthStatus || "").toLowerCase() === "degraded") accumulator.degradedApplications += 1;
      if ((app.syncStatus || "").toLowerCase() === "outofsync") accumulator.outOfSyncApplications += 1;
      if (app.labelContext) accumulator.labelledApplications += 1;
      accumulator.totalSyncs += app.totalSyncs;
      accumulator.successfulSyncs += app.successfulSyncs;
      accumulator.failedSyncs += app.failedSyncs;
      accumulator.unclassifiedSyncs += app.unclassifiedSyncs;
      return accumulator;
    },
    {
      activeApplications: 0,
      healthyApplications: 0,
      degradedApplications: 0,
      outOfSyncApplications: 0,
      labelledApplications: 0,
      totalSyncs: 0,
      successfulSyncs: 0,
      failedSyncs: 0,
      unclassifiedSyncs: 0,
    }
  );

  const scope = config.productionOnly
    ? config.environmentLabel
      ? "production-labeled"
      : config.appNameRegex || config.projectRegex || config.namespaceRegex
        ? "regex-filtered"
        : "all-apps-fallback"
    : "all-apps-fallback";

  return {
    status: {
      ...status,
      source: "grafana-cloud-prometheus",
      scope,
      labelContextAvailable: labelsResult.result.length > 0,
      productionFilterApplied: config.productionOnly && scope !== "all-apps-fallback",
    },
    summary: {
      ...summary,
      healthRate: summary.activeApplications > 0
        ? (summary.healthyApplications / summary.activeApplications) * 100
        : 0,
    },
    trend: filteredTrend,
    applications: filteredApps
      .sort((left, right) => {
        if (right.failedSyncs !== left.failedSyncs) return right.failedSyncs - left.failedSyncs;
        if (right.totalSyncs !== left.totalSyncs) return right.totalSyncs - left.totalSyncs;
        if ((left.syncStatus || "") !== (right.syncStatus || "")) {
          return (right.syncStatus || "").localeCompare(left.syncStatus || "");
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, 20),
    warnings,
    meta: {
      daysRequested: filters.days,
      latestDate: filteredTrend.length > 0 ? filteredTrend[filteredTrend.length - 1].date : null,
      filtersApplied: {
        teams: filters.teams || [],
        serviceKeys: filters.serviceKeys || [],
        projectIds: filters.projectIds || [],
      },
      configuredLabels: {
        team: config.teamLabel,
        service: config.serviceLabel,
        environment: config.environmentLabel,
      },
      productionValues: config.productionValues,
    },
  };
}
