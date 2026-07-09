import pool from "@/lib/db";
import { getK8sDailySnapshot } from "@/lib/k8s-metrics";
import {
  findK8sWorkloadMapping,
  getK8sWorkloadMappings,
  type K8sWorkloadMapping,
} from "@/lib/k8s-workload-mapping";

const MAX_BACKFILL_DAYS = 30;
const DEFAULT_CLUSTER = "dp-prod";

export function parseK8sSnapshotDay(dateStr: string | null): Date | null {
  if (!dateStr) return null;
  const parsed = new Date(`${dateStr}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function previewK8sSnapshot(date: Date) {
  return getK8sDailySnapshot(date);
}

async function persistSnapshot(
  snapshot: Awaited<ReturnType<typeof getK8sDailySnapshot>>,
  mappings: Map<string, K8sWorkloadMapping>
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let mappedRollouts = 0;
    let mappedFailures = 0;

    for (const rollout of snapshot.rollouts) {
      const mapping = findK8sWorkloadMapping(mappings, {
        cluster: DEFAULT_CLUSTER,
        namespace: rollout.namespace,
        deployment: rollout.deployment,
      });
      if (mapping) mappedRollouts += 1;

      await client.query(
        `INSERT INTO k8s_rollouts_daily (
          snapshot_date, cluster, namespace, deployment, rollout_hour, rollout_count,
          project_id, team, mapping_source, mapping_confidence
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (snapshot_date, namespace, deployment, rollout_hour) 
        DO UPDATE SET
          cluster = EXCLUDED.cluster,
          rollout_count = EXCLUDED.rollout_count,
          project_id = EXCLUDED.project_id,
          team = EXCLUDED.team,
          mapping_source = EXCLUDED.mapping_source,
          mapping_confidence = EXCLUDED.mapping_confidence`,
        [
          snapshot.date,
          DEFAULT_CLUSTER,
          rollout.namespace,
          rollout.deployment,
          rollout.timestamp.toISOString(),
          rollout.rolloutCount,
          mapping?.projectId || null,
          mapping?.team || null,
          mapping?.source || null,
          mapping?.confidence || null,
        ]
      );
    }

    for (const failure of snapshot.failures) {
      const mapping = findK8sWorkloadMapping(mappings, {
        cluster: DEFAULT_CLUSTER,
        namespace: failure.namespace,
        deployment: failure.deployment,
      });
      if (mapping) mappedFailures += 1;

      await client.query(
        `INSERT INTO k8s_failures_daily (
          snapshot_date, cluster, namespace, deployment, unavailable_replicas, container_restarts,
          project_id, team, mapping_source, mapping_confidence
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (snapshot_date, namespace, deployment)
        DO UPDATE SET 
          cluster = EXCLUDED.cluster,
          unavailable_replicas = EXCLUDED.unavailable_replicas,
          container_restarts = EXCLUDED.container_restarts,
          project_id = EXCLUDED.project_id,
          team = EXCLUDED.team,
          mapping_source = EXCLUDED.mapping_source,
          mapping_confidence = EXCLUDED.mapping_confidence`,
        [
          snapshot.date,
          DEFAULT_CLUSTER,
          failure.namespace,
          failure.deployment,
          failure.unavailableReplicas,
          failure.containerRestarts,
          mapping?.projectId || null,
          mapping?.team || null,
          mapping?.source || null,
          mapping?.confidence || null,
        ]
      );
    }

    for (const app of snapshot.argoHealth) {
      await client.query(
        `INSERT INTO argocd_health_daily (
          snapshot_date, app_name, namespace, health_status, sync_status, repo
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (snapshot_date, app_name)
        DO UPDATE SET 
          health_status = EXCLUDED.health_status,
          sync_status = EXCLUDED.sync_status,
          namespace = EXCLUDED.namespace`,
        [
          snapshot.date,
          app.appName,
          app.namespace,
          app.healthStatus,
          app.syncStatus,
          app.repo,
        ]
      );
    }

    await client.query("COMMIT");
    return { mappedRollouts, mappedFailures };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function generateK8sSnapshots(anchorDate: Date, requestedDays = 1) {
  if (!Number.isFinite(requestedDays) || requestedDays < 1) {
    throw new Error("Invalid days value. Use a positive integer.");
  }

  const days = Math.min(requestedDays, MAX_BACKFILL_DAYS);
  const warning = requestedDays > MAX_BACKFILL_DAYS
    ? `Days capped to ${MAX_BACKFILL_DAYS} to protect snapshot performance.`
    : null;

  let mappings = new Map<string, K8sWorkloadMapping>();
  let mappingWarning: string | null = null;
  try {
    mappings = await getK8sWorkloadMappings(DEFAULT_CLUSTER);
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown error";
    mappingWarning = /relation .* does not exist/i.test(details)
      ? "k8s_workload_mapping table missing. Apply migration 2026-03-05_k8s_workload_mapping.sql."
      : `Unable to load k8s mappings: ${details}`;
  }

  const results: Array<{ date: string; success: boolean; summary?: unknown; error?: string }> = [];

  for (let i = 0; i < days; i++) {
    const date = new Date(anchorDate);
    date.setDate(anchorDate.getDate() - i);

    try {
      const snapshot = await getK8sDailySnapshot(date);
      const persisted = await persistSnapshot(snapshot, mappings);
      const rolloutCoverage = snapshot.rollouts.length > 0
        ? (persisted.mappedRollouts / snapshot.rollouts.length) * 100
        : 0;
      const failureCoverage = snapshot.failures.length > 0
        ? (persisted.mappedFailures / snapshot.failures.length) * 100
        : 0;

      results.push({
        date: snapshot.date,
        success: true,
        summary: {
          ...snapshot.summary,
          mapping: {
            mappedRollouts: persisted.mappedRollouts,
            totalRollouts: snapshot.rollouts.length,
            rolloutCoveragePct: Number(rolloutCoverage.toFixed(1)),
            mappedFailures: persisted.mappedFailures,
            totalFailures: snapshot.failures.length,
            failureCoveragePct: Number(failureCoverage.toFixed(1)),
          },
        },
      });
    } catch (dayError) {
      results.push({
        date: date.toISOString().split("T")[0],
        success: false,
        error: String(dayError),
      });
    }
  }

  const success = results.every((row) => row.success);
  return {
    success,
    requestedDays,
    processedDays: days,
    warning,
    mappingWarning,
    results,
  };
}
