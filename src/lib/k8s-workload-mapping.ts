import pool from "@/lib/db";

export type K8sWorkloadMapping = {
  cluster: string;
  namespace: string;
  deployment: string;
  projectId: number;
  team: string | null;
  projectName: string | null;
  source: string;
  confidence: number;
  notes: string | null;
};

type MappingRow = {
  cluster: string;
  namespace: string;
  deployment: string;
  project_id: number;
  team: string | null;
  project_name: string | null;
  source: string | null;
  confidence: string | number | null;
  notes: string | null;
};

function normalize(value: string | null | undefined): string {
  return (value || "")
    .trim()
    .toLowerCase();
}

export function buildWorkloadMappingKey(cluster: string, namespace: string, deployment: string): string {
  return `${normalize(cluster)}::${normalize(namespace)}::${normalize(deployment)}`;
}

export async function getK8sWorkloadMappings(cluster?: string): Promise<Map<string, K8sWorkloadMapping>> {
  const params: unknown[] = [];
  const where = cluster ? "WHERE cluster = $1" : "";
  if (cluster) params.push(cluster);

  const result = await pool.query<MappingRow>(
    `
      SELECT
        cluster,
        namespace,
        deployment,
        project_id,
        team,
        project_name,
        source,
        confidence,
        notes
      FROM k8s_workload_mapping
      ${where}
    `,
    params
  );

  const mappings = new Map<string, K8sWorkloadMapping>();
  for (const row of result.rows) {
    const key = buildWorkloadMappingKey(row.cluster, row.namespace, row.deployment);
    mappings.set(key, {
      cluster: row.cluster,
      namespace: row.namespace,
      deployment: row.deployment,
      projectId: row.project_id,
      team: row.team,
      projectName: row.project_name,
      source: row.source || "manual",
      confidence: Number(row.confidence ?? 1),
      notes: row.notes,
    });
  }

  return mappings;
}

export function findK8sWorkloadMapping(
  mappings: Map<string, K8sWorkloadMapping>,
  workload: {
    cluster?: string | null;
    namespace: string;
    deployment: string;
  }
): K8sWorkloadMapping | null {
  const cluster = workload.cluster || "dp-prod";
  const key = buildWorkloadMappingKey(cluster, workload.namespace, workload.deployment);
  return mappings.get(key) || null;
}
