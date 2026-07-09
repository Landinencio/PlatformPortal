import pool from "@/lib/db";
import { grafanaMetricsClient } from "@/lib/grafana-metrics";
import { getK8sWorkloadMappings } from "@/lib/k8s-workload-mapping";
import { addDays, format, subDays, differenceInMinutes, parseISO, startOfDay } from "date-fns";

/* ------------------------------------------------------------------ */
/*  Environment helpers & confidence filtering                         */
/* ------------------------------------------------------------------ */

/**
 * Parses a positive float from an environment variable.
 * Returns null if the variable is not set, empty, or not a valid positive number.
 */
export function parsePositiveEnvFloat(envKey: string): number | null {
  const raw = process.env[envKey];
  if (raw == null || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[deployment-correlation] Invalid value for ${envKey}: "${raw}" — must be a positive number. Using default.`
    );
    return null;
  }
  return parsed;
}

/**
 * Confianza mínima para incluir correlaciones en cálculos de métricas.
 * Configurable via DORA_MIN_CORRELATION_CONFIDENCE. Default: 0.7
 */
export const MIN_CORRELATION_CONFIDENCE: number =
  parsePositiveEnvFloat("DORA_MIN_CORRELATION_CONFIDENCE") ?? 0.7;

/**
 * Filtra correlaciones por confianza mínima.
 * Retorna solo las que superan el umbral configurado.
 * @param correlations - Array de correlaciones a filtrar
 * @param minConfidence - Umbral mínimo (default: MIN_CORRELATION_CONFIDENCE)
 */
export function filterByConfidence(
  correlations: Correlation[],
  minConfidence: number = MIN_CORRELATION_CONFIDENCE
): Correlation[] {
  return correlations.filter((c) => c.confidence >= minConfidence);
}

/**
 * Determina si se debe mostrar una advertencia de baja confianza.
 * Retorna true si más del 30% de las correlaciones están por debajo del umbral.
 * @param correlations - Array de correlaciones a evaluar
 * @param minConfidence - Umbral mínimo (default: MIN_CORRELATION_CONFIDENCE)
 */
export function shouldShowLowConfidenceWarning(
  correlations: Correlation[],
  minConfidence: number = MIN_CORRELATION_CONFIDENCE
): boolean {
  if (correlations.length === 0) return false;
  const belowThreshold = correlations.filter((c) => c.confidence < minConfidence).length;
  return belowThreshold / correlations.length > 0.3;
}

/**
 * Para un conjunto de correlaciones, agrupa por (pipeline_id, app_key)
 * y selecciona la de mayor confianza por grupo.
 * @param correlations - Array de correlaciones a agrupar
 * @returns Map con clave "pipelineId::appKey" y valor la correlación de mayor confianza
 */
export function selectBestCorrelationPerPipeline(
  correlations: Correlation[]
): Map<string, Correlation> {
  const groups = new Map<string, Correlation[]>();

  for (const corr of correlations) {
    const key = `${corr.gitlab.pipelineId}::${corr.argocd.appKey}`;
    const group = groups.get(key);
    if (group) {
      group.push(corr);
    } else {
      groups.set(key, [corr]);
    }
  }

  const result = new Map<string, Correlation>();
  for (const [key, group] of groups) {
    let best = group[0];
    for (let i = 1; i < group.length; i++) {
      if (group[i].confidence > best.confidence) {
        best = group[i];
      }
    }
    result.set(key, best);
  }

  return result;
}

export type GitLabDeploy = {
  projectId: number;
  projectName: string;
  pipelineId: string;
  jobId: number | null;
  commitSha: string;
  commitTimestamp: Date | null;
  pipelineStatus: string;
  pipelineTimestamp: Date;
};

export type ArgocdSync = {
  appName: string;
  appKey: string;
  project: string | null;
  namespace: string | null;
  cluster: string | null;
  repo: string | null;
  syncTimestamp: Date;
  syncStatus: string;
  healthStatus: string | null;
  operation: string | null;
};

export type Correlation = {
  gitlab: GitLabDeploy;
  argocd: ArgocdSync;
  method: "repo-match" | "workload-mapping" | "name-match" | "timestamp-proximity";
  confidence: number;
  timeDiffMinutes: number;
};

type WorkloadProjectIndex = Map<string, Set<number>>;

/**
 * Normalizes a string for comparison (lowercase, remove special chars)
 */
function normalizeKey(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Extracts GitLab project ID from ArgoCD repo URL
 * Example: https://gitlab.com/api/v4/projects/12345/repository/files
 */
function extractProjectIdFromRepo(repo: string | null): number | null {
  if (!repo) return null;
  const match = repo.match(/\/projects\/(\d+)\//i);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : null;
}

/**
 * Derives logical service name from ArgoCD app name
 * Removes common suffixes like -helm, namespace prefixes, etc.
 */
function deriveServiceName(appName: string, namespace: string | null): string {
  let name = normalizeKey(appName);
  
  // Remove -helm suffix
  if (name.endsWith("-helm")) {
    name = name.slice(0, -"-helm".length);
  }
  
  // Remove namespace prefix if present
  const ns = normalizeKey(namespace);
  if (ns && name.startsWith(`${ns}-`)) {
    name = name.slice(ns.length + 1);
  }
  
  return name || normalizeKey(appName);
}

function buildWorkloadProjectKey(namespace: string | null, deployment: string | null): string {
  return `${normalizeKey(namespace)}::${normalizeKey(deployment)}`;
}

async function loadWorkloadProjectIndex(): Promise<WorkloadProjectIndex> {
  const mappings = await getK8sWorkloadMappings("dp-prod");
  const index: WorkloadProjectIndex = new Map();

  for (const mapping of mappings.values()) {
    const key = buildWorkloadProjectKey(mapping.namespace, mapping.deployment);
    if (!key || key === "::") continue;
    if (!index.has(key)) {
      index.set(key, new Set());
    }
    index.get(key)!.add(mapping.projectId);
  }

  return index;
}

/**
 * Fetches GitLab deploys for a specific date
 */
async function fetchGitLabDeploys(date: Date): Promise<GitLabDeploy[]> {
  const dateStr = format(date, "yyyy-MM-dd");
  
  // Use deployment_traces table which has detailed deployment data
  const result = await pool.query<{
    project_id: number;
    project_name: string;
    deploy_id: string;
    commit_sha: string;
    commit_created_at: string | null;
    deploy_created_at: string;
  }>(`
    SELECT DISTINCT
      project_id,
      project_name,
      deploy_id,
      commit_sha,
      commit_created_at,
      deploy_created_at
    FROM deployment_traces
    WHERE snapshot_date = $1
      AND deploy_type IN ('feature', 'hotfix', 'rollback')
    ORDER BY deploy_created_at ASC
  `, [dateStr]);
  
  return result.rows.map(row => ({
    projectId: row.project_id,
    projectName: row.project_name,
    pipelineId: row.deploy_id,
    jobId: null, // Not available in deployment_traces
    commitSha: row.commit_sha,
    commitTimestamp: row.commit_created_at ? parseISO(row.commit_created_at) : null,
    pipelineStatus: 'success', // All deploys in traces are successful
    pipelineTimestamp: parseISO(row.deploy_created_at),
  }));
}

/**
 * Fetches ArgoCD syncs for a specific date from Grafana
 */
async function fetchArgocdSyncs(date: Date): Promise<ArgocdSync[]> {
  const startDate = startOfDay(date);
  const endDate = addDays(startDate, 1);
  
  // Reconstruct sync events from counter increments instead of rolling 24h increases.
  const syncQuery = `
    max by (name, project, dest_namespace, repo, k8s_cluster_name, cluster, phase, operation)
    (argocd_app_sync_total{k8s_cluster_name="dp-prod"})
  `;
  
  const syncResult = await grafanaMetricsClient.queryRange<{
    name?: string;
    project?: string;
    dest_namespace?: string;
    repo?: string;
    k8s_cluster_name?: string;
    cluster?: string;
    phase?: string;
    operation?: string;
  }>(syncQuery, {
    start: startDate,
    end: endDate,
    step: "900",
  });
  
  // Query for health status
  const healthQuery = `max by (name, project, health_status) (argocd_app_info{k8s_cluster_name="dp-prod"})`;
  const healthResult = await grafanaMetricsClient.query<{
    name?: string;
    project?: string;
    health_status?: string;
  }>(healthQuery, { time: endDate });
  
  const healthMap = new Map<string, string>();
  for (const item of healthResult.result) {
    const key = `${item.metric.project || "default"}::${item.metric.name || "unknown"}`;
    healthMap.set(key, item.metric.health_status || "Unknown");
  }
  
  const syncs: ArgocdSync[] = [];
  
  for (const item of syncResult.result) {
    const appName = item.metric.name || "unknown";
    const project = item.metric.project || "default";
    const appKey = `${project}::${appName}`;
    
    let previousCount: number | null = null;

    for (const value of item.values) {
      const timestamp = new Date(Number(value[0]) * 1000);
      const currentCount = Number(value[1]);
      if (!Number.isFinite(currentCount)) continue;

      if (previousCount === null) {
        previousCount = currentCount;
        continue;
      }

      const delta = currentCount - previousCount;
      previousCount = currentCount;

      if (delta <= 0) continue;

      const increments = Math.max(0, Math.round(delta));
      for (let index = 0; index < increments; index++) {
        syncs.push({
          appName,
          appKey,
          project,
          namespace: item.metric.dest_namespace || null,
          cluster: item.metric.k8s_cluster_name || item.metric.cluster || null,
          repo: item.metric.repo || null,
          syncTimestamp: timestamp,
          syncStatus: item.metric.phase || "Unknown",
          healthStatus: healthMap.get(appKey) || null,
          operation: item.metric.operation || null,
        });
      }
    }
  }
  
  return syncs;
}

function syncStatusPriority(status: string): number {
  const normalized = status.toLowerCase();
  if (normalized === "succeeded") return 3;
  if (normalized === "running") return 2;
  if (normalized === "failed") return 1;
  return 0;
}

/**
 * Correlates a GitLab deploy with ArgoCD syncs
 */
function correlateDeployWithSyncs(
  deploy: GitLabDeploy,
  syncs: ArgocdSync[],
  workloadProjectIndex: WorkloadProjectIndex
): Correlation | null {
  const candidates: Array<{ sync: ArgocdSync; method: Correlation["method"]; confidence: number }> = [];
  
  // Method 1: Repo match (highest confidence)
  for (const sync of syncs) {
    const repoProjectId = extractProjectIdFromRepo(sync.repo);
    if (repoProjectId === deploy.projectId) {
      const timeDiff = Math.abs(differenceInMinutes(sync.syncTimestamp, deploy.pipelineTimestamp));
      
      // Only consider syncs within 60 minutes of pipeline
      if (timeDiff <= 60) {
        candidates.push({
          sync,
          method: "repo-match",
          confidence: 1.0 - (timeDiff / 120), // Decay confidence with time
        });
      }
    }
  }
  
  // Method 2: Workload mapping (strong confidence)
  if (candidates.length === 0 && workloadProjectIndex.size > 0) {
    for (const sync of syncs) {
      const serviceName = deriveServiceName(sync.appName, sync.namespace);
      const key = buildWorkloadProjectKey(sync.namespace, serviceName);
      const mappedProjects = workloadProjectIndex.get(key);
      if (!mappedProjects || !mappedProjects.has(deploy.projectId)) continue;

      const timeDiff = Math.abs(differenceInMinutes(sync.syncTimestamp, deploy.pipelineTimestamp));
      if (timeDiff <= 120) {
        candidates.push({
          sync,
          method: "workload-mapping",
          confidence: 0.9 - (timeDiff / 300),
        });
      }
    }
  }

  // Method 3: Name match (good confidence)
  if (candidates.length === 0) {
    const projectKey = normalizeKey(deploy.projectName);
    
    for (const sync of syncs) {
      const serviceName = deriveServiceName(sync.appName, sync.namespace);
      
      if (serviceName === projectKey) {
        const timeDiff = Math.abs(differenceInMinutes(sync.syncTimestamp, deploy.pipelineTimestamp));
        
        if (timeDiff <= 90) {
          candidates.push({
            sync,
            method: "name-match",
            confidence: 0.8 - (timeDiff / 180),
          });
        }
      }
    }
  }
  
  // Method 4: Timestamp proximity (fallback, low confidence)
  if (candidates.length === 0) {
    for (const sync of syncs) {
      const timeDiff = Math.abs(differenceInMinutes(sync.syncTimestamp, deploy.pipelineTimestamp));
      
      // Only consider very close syncs (within 30 minutes)
      if (timeDiff <= 30) {
        candidates.push({
          sync,
          method: "timestamp-proximity",
          confidence: 0.5 - (timeDiff / 60),
        });
      }
    }
  }
  
  // Select best candidate
  if (candidates.length === 0) return null;
  
  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const statusDiff = syncStatusPriority(b.sync.syncStatus) - syncStatusPriority(a.sync.syncStatus);
    if (statusDiff !== 0) return statusDiff;
    return Math.abs(differenceInMinutes(a.sync.syncTimestamp, deploy.pipelineTimestamp))
      - Math.abs(differenceInMinutes(b.sync.syncTimestamp, deploy.pipelineTimestamp));
  });
  const best = candidates[0];
  
  return {
    gitlab: deploy,
    argocd: best.sync,
    method: best.method,
    confidence: Math.max(0, Math.min(1, best.confidence)),
    timeDiffMinutes: differenceInMinutes(best.sync.syncTimestamp, deploy.pipelineTimestamp),
  };
}

/**
 * Saves correlations to database
 */
async function saveCorrelations(date: Date, correlations: Correlation[]): Promise<void> {
  const dateStr = format(date, "yyyy-MM-dd");
  
  for (const corr of correlations) {
    await pool.query(`
      INSERT INTO deployment_correlation (
        correlation_date,
        gitlab_project_id,
        gitlab_project_name,
        gitlab_pipeline_id,
        gitlab_job_id,
        gitlab_commit_sha,
        gitlab_commit_timestamp,
        gitlab_pipeline_status,
        gitlab_pipeline_timestamp,
        argocd_app_name,
        argocd_app_key,
        argocd_project,
        argocd_namespace,
        argocd_cluster,
        argocd_repo,
        argocd_sync_timestamp,
        argocd_sync_status,
        argocd_health_status,
        argocd_operation,
        correlation_method,
        correlation_confidence,
        time_diff_minutes
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22
      )
      ON CONFLICT (correlation_date, gitlab_project_id, gitlab_pipeline_id, argocd_app_key)
      DO UPDATE SET
        correlation_method = EXCLUDED.correlation_method,
        correlation_confidence = EXCLUDED.correlation_confidence,
        time_diff_minutes = EXCLUDED.time_diff_minutes,
        argocd_sync_timestamp = EXCLUDED.argocd_sync_timestamp,
        argocd_sync_status = EXCLUDED.argocd_sync_status,
        argocd_health_status = EXCLUDED.argocd_health_status,
        updated_at = NOW()
    `, [
      dateStr,
      corr.gitlab.projectId,
      corr.gitlab.projectName,
      corr.gitlab.pipelineId,
      corr.gitlab.jobId,
      corr.gitlab.commitSha,
      corr.gitlab.commitTimestamp,
      corr.gitlab.pipelineStatus,
      corr.gitlab.pipelineTimestamp,
      corr.argocd.appName,
      corr.argocd.appKey,
      corr.argocd.project,
      corr.argocd.namespace,
      corr.argocd.cluster,
      corr.argocd.repo,
      corr.argocd.syncTimestamp,
      corr.argocd.syncStatus,
      corr.argocd.healthStatus,
      corr.argocd.operation,
      corr.method,
      corr.confidence,
      corr.timeDiffMinutes,
    ]);
  }
}

/**
 * Main function to correlate GitLab deploys with ArgoCD syncs for a specific date
 */
export async function correlateDeployments(date: Date): Promise<{
  success: boolean;
  date: string;
  gitlabDeploys: number;
  argocdSyncs: number;
  correlations: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  uncorrelated: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const dateStr = format(date, "yyyy-MM-dd");
  
  try {
    console.log(`[Correlation] Starting for ${dateStr}...`);
    
    // Fetch data from both sources
    const [gitlabDeploys, argocdSyncs, workloadProjectIndex] = await Promise.all([
      fetchGitLabDeploys(date),
      fetchArgocdSyncs(date).catch(error => {
        errors.push(`Failed to fetch ArgoCD syncs: ${error instanceof Error ? error.message : "Unknown error"}`);
        return [];
      }),
      loadWorkloadProjectIndex().catch(error => {
        const message = error instanceof Error ? error.message : "Unknown error";
        if (/relation .* does not exist/i.test(message)) {
          errors.push("k8s_workload_mapping table missing. Correlation continues without mapping boost.");
        } else {
          errors.push(`Failed to load k8s workload mapping: ${message}`);
        }
        return new Map<string, Set<number>>();
      }),
    ]);
    
    console.log(`[Correlation] Found ${gitlabDeploys.length} GitLab deploys, ${argocdSyncs.length} ArgoCD syncs`);
    
    // Correlate each deploy
    const correlations: Correlation[] = [];
    let uncorrelated = 0;
    
    for (const deploy of gitlabDeploys) {
      const correlation = correlateDeployWithSyncs(deploy, argocdSyncs, workloadProjectIndex);
      
      if (correlation) {
        correlations.push(correlation);
      } else {
        uncorrelated++;
      }
    }
    
    // Save to database
    if (correlations.length > 0) {
      await saveCorrelations(date, correlations);
    }
    
    // Calculate confidence distribution
    const highConfidence = correlations.filter(c => c.confidence >= 0.8).length;
    const mediumConfidence = correlations.filter(c => c.confidence >= 0.5 && c.confidence < 0.8).length;
    const lowConfidence = correlations.filter(c => c.confidence < 0.5).length;
    
    console.log(`[Correlation] Completed: ${correlations.length} correlations (${highConfidence} high, ${mediumConfidence} medium, ${lowConfidence} low), ${uncorrelated} uncorrelated`);
    
    return {
      success: true,
      date: dateStr,
      gitlabDeploys: gitlabDeploys.length,
      argocdSyncs: argocdSyncs.length,
      correlations: correlations.length,
      highConfidence,
      mediumConfidence,
      lowConfidence,
      uncorrelated,
      errors,
    };
  } catch (error) {
    console.error(`[Correlation] Error for ${dateStr}:`, error);
    errors.push(error instanceof Error ? error.message : "Unknown error");
    
    return {
      success: false,
      date: dateStr,
      gitlabDeploys: 0,
      argocdSyncs: 0,
      correlations: 0,
      highConfidence: 0,
      mediumConfidence: 0,
      lowConfidence: 0,
      uncorrelated: 0,
      errors,
    };
  }
}

/**
 * Correlate multiple days
 */
export async function correlateDeploymentsRange(days: number): Promise<{
  success: boolean;
  totalDays: number;
  results: Awaited<ReturnType<typeof correlateDeployments>>[];
}> {
  const results: Awaited<ReturnType<typeof correlateDeployments>>[] = [];
  
  for (let i = 1; i <= days; i++) {
    const date = subDays(new Date(), i);
    const result = await correlateDeployments(date);
    results.push(result);
    
    // Small delay to avoid overwhelming Grafana
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  const allSuccess = results.every(r => r.success);
  
  return {
    success: allSuccess,
    totalDays: days,
    results,
  };
}
