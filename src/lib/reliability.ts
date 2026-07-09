import { format, subDays } from "date-fns";
import type { PoolClient } from "pg";
import { z } from "zod";
import pool from "@/lib/db";
import { parseMetricFilters, type MetricFilters } from "@/lib/query-filters";

export interface ReliabilityFilters extends MetricFilters {
  serviceKeys: string[];
  environments: string[];
  severities: string[];
  classifications: string[];
  sources: string[];
}

type SummaryRow = {
  total_incidents: string | number | null;
  open_incidents: string | number | null;
  resolved_incidents: string | number | null;
  linked_incidents: string | number | null;
  primary_linked_incidents: string | number | null;
  avg_mttr_hours: string | number | null;
  services_impacted: string | number | null;
  source_count: string | number | null;
  critical_incidents: string | number | null;
  high_incidents: string | number | null;
  medium_incidents: string | number | null;
  low_incidents: string | number | null;
  info_incidents: string | number | null;
  app_incidents: string | number | null;
  infra_incidents: string | number | null;
  dependency_incidents: string | number | null;
  security_incidents: string | number | null;
  unknown_incidents: string | number | null;
};

type TrendRow = {
  date_bucket: string;
  incidents: string | number | null;
  resolved: string | number | null;
  linked: string | number | null;
  severe: string | number | null;
  avg_mttr_hours: string | number | null;
};

type TopServiceRow = {
  service_key: string | null;
  service_name: string | null;
  team: string | null;
  incidents: string | number | null;
  severe_incidents: string | number | null;
  avg_mttr_hours: string | number | null;
  last_opened_at: string | null;
};

type RelationCheckRow = {
  services: string | null;
  production_incidents: string | null;
  production_deployments: string | null;
  deployment_incident_links: string | null;
};

const EVENT_STATUS_VALUES = ["open", "acknowledged", "investigating", "mitigating", "resolved", "closed"] as const;
const INCIDENT_SEVERITY_VALUES = ["critical", "high", "medium", "low", "info"] as const;
const INCIDENT_CLASSIFICATION_VALUES = ["app", "infra", "dependency", "security", "unknown"] as const;

const incidentEventSchema = z.object({
  eventType: z.string().min(1),
  status: z.enum(EVENT_STATUS_VALUES).optional(),
  message: z.string().optional(),
  happenedAt: z.coerce.date(),
  metadata: z.record(z.any()).optional(),
});

const rawIncidentSchema = z.object({
  source: z.string().min(1).optional(),
  sourceIncidentId: z.string().min(1),
  serviceKey: z.string().min(1).optional(),
  serviceName: z.string().min(1).optional(),
  team: z.string().optional(),
  gitlabProjectId: z.number().int().optional(),
  gitlabProjectPath: z.string().optional(),
  environment: z.string().min(1).default("production"),
  severity: z.enum(INCIDENT_SEVERITY_VALUES).default("medium"),
  status: z.enum(EVENT_STATUS_VALUES).default("open"),
  classification: z.enum(INCIDENT_CLASSIFICATION_VALUES).default("unknown"),
  title: z.string().min(1),
  summary: z.string().optional(),
  openedAt: z.coerce.date(),
  detectedAt: z.coerce.date().optional(),
  acknowledgedAt: z.coerce.date().optional(),
  resolvedAt: z.coerce.date().optional(),
  sourceUrl: z.string().optional(),
  namespace: z.string().optional(),
  workloadKind: z.string().optional(),
  workloadName: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  events: z.array(incidentEventSchema).optional(),
});

const incidentIngestSchema = z.object({
  source: z.string().min(1).optional(),
  incidents: z.array(rawIncidentSchema).min(1),
});

export type IncidentIngestPayload = z.infer<typeof incidentIngestSchema>;

type NormalizedIncident = Omit<z.infer<typeof rawIncidentSchema>, "source"> & {
  source: string;
  serviceKey: string;
  serviceName: string;
};

function parseCsv(value: string | null): string[] {
  if (!value || value === "all") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }
  return 0;
}

function getReliabilityIntegrationStatus() {
  const configuredSources = parseCsv(process.env.INCIDENT_SOURCES_ENABLED || null);
  return {
    intakeEnabled: Boolean(process.env.INCIDENTS_INGEST_TOKEN),
    configuredSources,
  };
}

async function getReliabilitySchemaStatus() {
  const result = await pool.query<RelationCheckRow>(`
    SELECT
      to_regclass('public.services')::text AS services,
      to_regclass('public.production_incidents')::text AS production_incidents,
      to_regclass('public.production_deployments')::text AS production_deployments,
      to_regclass('public.deployment_incident_links')::text AS deployment_incident_links
  `);

  const row = result.rows[0];
  const schemaReady = Boolean(
    row?.services &&
      row?.production_incidents &&
      row?.production_deployments &&
      row?.deployment_incident_links
  );

  return {
    schemaReady,
    relations: {
      services: row?.services || null,
      productionIncidents: row?.production_incidents || null,
      productionDeployments: row?.production_deployments || null,
      deploymentIncidentLinks: row?.deployment_incident_links || null,
    },
  };
}

function buildReliabilityWhereClause(
  filters: ReliabilityFilters,
  startParamIndex: number = 3
): { clause: string; params: Array<string[] | number[]> } {
  const conditions: string[] = [];
  const params: Array<string[] | number[]> = [];
  let paramIndex = startParamIndex;

  if (filters.teams.length > 0) {
    conditions.push(`COALESCE(s.team, i.team) = ANY($${paramIndex})`);
    params.push(filters.teams);
    paramIndex += 1;
  }

  if (filters.projectIds.length > 0) {
    conditions.push(`COALESCE(s.gitlab_project_id, i.gitlab_project_id) = ANY($${paramIndex})`);
    params.push(filters.projectIds);
    paramIndex += 1;
  }

  if (filters.serviceKeys.length > 0) {
    conditions.push(`s.service_key = ANY($${paramIndex})`);
    params.push(filters.serviceKeys);
    paramIndex += 1;
  }

  if (filters.environments.length > 0) {
    conditions.push(`i.environment = ANY($${paramIndex})`);
    params.push(filters.environments);
    paramIndex += 1;
  }

  if (filters.severities.length > 0) {
    conditions.push(`i.severity = ANY($${paramIndex})`);
    params.push(filters.severities);
    paramIndex += 1;
  }

  if (filters.classifications.length > 0) {
    conditions.push(`i.classification = ANY($${paramIndex})`);
    params.push(filters.classifications);
    paramIndex += 1;
  }

  if (filters.sources.length > 0) {
    conditions.push(`i.source = ANY($${paramIndex})`);
    params.push(filters.sources);
    paramIndex += 1;
  }

  return {
    clause: conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "",
    params,
  };
}

function emptyReliabilityDashboard(filters: ReliabilityFilters, schemaReady: boolean) {
  const integration = getReliabilityIntegrationStatus();

  return {
    summary: {
      totalIncidents: 0,
      openIncidents: 0,
      resolvedIncidents: 0,
      linkedIncidents: 0,
      primaryLinkedIncidents: 0,
      linkedCoverageRate: 0,
      averageMttrHours: 0,
      servicesImpacted: 0,
      sourceCount: 0,
      severity: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        info: 0,
      },
      classification: {
        app: 0,
        infra: 0,
        dependency: 0,
        security: 0,
        unknown: 0,
      },
    },
    trend: [],
    topServices: [],
    meta: {
      daysRequested: filters.days,
      schemaReady,
      hasData: false,
      ...integration,
      filters: {
        teams: filters.teams,
        projectIds: filters.projectIds,
        serviceKeys: filters.serviceKeys,
        environments: filters.environments,
        severities: filters.severities,
        classifications: filters.classifications,
        sources: filters.sources,
      },
    },
  };
}

export function parseReliabilityFilters(searchParams: URLSearchParams): ReliabilityFilters {
  const base = parseMetricFilters(searchParams);

  return {
    ...base,
    serviceKeys: parseCsv(searchParams.get("serviceKeys") || searchParams.get("serviceKey")),
    environments: parseCsv(searchParams.get("environments") || searchParams.get("environment")),
    severities: parseCsv(searchParams.get("severities") || searchParams.get("severity")),
    classifications: parseCsv(searchParams.get("classifications") || searchParams.get("classification")),
    sources: parseCsv(searchParams.get("sources") || searchParams.get("source")),
  };
}

export async function getReliabilityDashboard(filters: ReliabilityFilters) {
  const schema = await getReliabilitySchemaStatus();
  if (!schema.schemaReady) {
    return emptyReliabilityDashboard(filters, false);
  }

  const endDate = new Date();
  const startDate = subDays(endDate, filters.days);
  const baseParams = [format(startDate, "yyyy-MM-dd"), format(endDate, "yyyy-MM-dd")];
  const { clause: filterClause, params: filterParams } = buildReliabilityWhereClause(filters, 3);

  const summaryResult = await pool.query<SummaryRow>(
    `
      SELECT
        COUNT(DISTINCT i.id) AS total_incidents,
        COUNT(DISTINCT i.id) FILTER (
          WHERE i.status IN ('open', 'acknowledged', 'investigating', 'mitigating')
        ) AS open_incidents,
        COUNT(DISTINCT i.id) FILTER (
          WHERE i.status IN ('resolved', 'closed')
        ) AS resolved_incidents,
        COUNT(DISTINCT i.id) FILTER (
          WHERE dil.incident_id IS NOT NULL
        ) AS linked_incidents,
        COUNT(DISTINCT i.id) FILTER (
          WHERE dil.is_primary = TRUE
        ) AS primary_linked_incidents,
        AVG(EXTRACT(EPOCH FROM (i.resolved_at - i.opened_at)) / 3600.0) FILTER (
          WHERE i.resolved_at IS NOT NULL AND i.resolved_at >= i.opened_at
        ) AS avg_mttr_hours,
        COUNT(DISTINCT COALESCE(s.service_key, i.service_name)) AS services_impacted,
        COUNT(DISTINCT i.source) AS source_count,
        COUNT(DISTINCT i.id) FILTER (WHERE i.severity = 'critical') AS critical_incidents,
        COUNT(DISTINCT i.id) FILTER (WHERE i.severity = 'high') AS high_incidents,
        COUNT(DISTINCT i.id) FILTER (WHERE i.severity = 'medium') AS medium_incidents,
        COUNT(DISTINCT i.id) FILTER (WHERE i.severity = 'low') AS low_incidents,
        COUNT(DISTINCT i.id) FILTER (WHERE i.severity = 'info') AS info_incidents,
        COUNT(DISTINCT i.id) FILTER (WHERE i.classification = 'app') AS app_incidents,
        COUNT(DISTINCT i.id) FILTER (WHERE i.classification = 'infra') AS infra_incidents,
        COUNT(DISTINCT i.id) FILTER (WHERE i.classification = 'dependency') AS dependency_incidents,
        COUNT(DISTINCT i.id) FILTER (WHERE i.classification = 'security') AS security_incidents,
        COUNT(DISTINCT i.id) FILTER (WHERE i.classification = 'unknown') AS unknown_incidents
      FROM production_incidents i
      LEFT JOIN services s ON s.id = i.service_id
      LEFT JOIN deployment_incident_links dil ON dil.incident_id = i.id
      WHERE i.opened_at >= $1::date
        AND i.opened_at < ($2::date + INTERVAL '1 day')
      ${filterClause}
    `,
    [...baseParams, ...filterParams]
  );

  const trendResult = await pool.query<TrendRow>(
    `
      SELECT
        TO_CHAR(DATE(i.opened_at), 'YYYY-MM-DD') AS date_bucket,
        COUNT(DISTINCT i.id) AS incidents,
        COUNT(DISTINCT i.id) FILTER (
          WHERE i.status IN ('resolved', 'closed')
        ) AS resolved,
        COUNT(DISTINCT i.id) FILTER (
          WHERE dil.incident_id IS NOT NULL
        ) AS linked,
        COUNT(DISTINCT i.id) FILTER (
          WHERE i.severity IN ('critical', 'high')
        ) AS severe,
        AVG(EXTRACT(EPOCH FROM (i.resolved_at - i.opened_at)) / 3600.0) FILTER (
          WHERE i.resolved_at IS NOT NULL AND i.resolved_at >= i.opened_at
        ) AS avg_mttr_hours
      FROM production_incidents i
      LEFT JOIN services s ON s.id = i.service_id
      LEFT JOIN deployment_incident_links dil ON dil.incident_id = i.id
      WHERE i.opened_at >= $1::date
        AND i.opened_at < ($2::date + INTERVAL '1 day')
      ${filterClause}
      GROUP BY DATE(i.opened_at)
      ORDER BY DATE(i.opened_at) ASC
    `,
    [...baseParams, ...filterParams]
  );

  const topServicesResult = await pool.query<TopServiceRow>(
    `
      SELECT
        COALESCE(s.service_key, i.slug) AS service_key,
        COALESCE(s.service_name, i.service_name, 'Unknown service') AS service_name,
        COALESCE(s.team, i.team) AS team,
        COUNT(DISTINCT i.id) AS incidents,
        COUNT(DISTINCT i.id) FILTER (
          WHERE i.severity IN ('critical', 'high')
        ) AS severe_incidents,
        AVG(EXTRACT(EPOCH FROM (i.resolved_at - i.opened_at)) / 3600.0) FILTER (
          WHERE i.resolved_at IS NOT NULL AND i.resolved_at >= i.opened_at
        ) AS avg_mttr_hours,
        MAX(i.opened_at)::text AS last_opened_at
      FROM (
        SELECT
          *,
          regexp_replace(lower(COALESCE(service_name, 'unknown-service')), '[^a-z0-9]+', '-', 'g') AS slug
        FROM production_incidents
      ) i
      LEFT JOIN services s ON s.id = i.service_id
      WHERE i.opened_at >= $1::date
        AND i.opened_at < ($2::date + INTERVAL '1 day')
      ${filterClause}
      GROUP BY COALESCE(s.service_key, i.slug), COALESCE(s.service_name, i.service_name, 'Unknown service'), COALESCE(s.team, i.team)
      ORDER BY incidents DESC, severe_incidents DESC, service_name ASC
      LIMIT 10
    `,
    [...baseParams, ...filterParams]
  );

  const summary = summaryResult.rows[0];
  const totalIncidents = toNumber(summary?.total_incidents);
  const linkedIncidents = toNumber(summary?.linked_incidents);
  const integration = getReliabilityIntegrationStatus();

  return {
    summary: {
      totalIncidents,
      openIncidents: toNumber(summary?.open_incidents),
      resolvedIncidents: toNumber(summary?.resolved_incidents),
      linkedIncidents,
      primaryLinkedIncidents: toNumber(summary?.primary_linked_incidents),
      linkedCoverageRate: totalIncidents > 0 ? (linkedIncidents / totalIncidents) * 100 : 0,
      averageMttrHours: toNumber(summary?.avg_mttr_hours),
      servicesImpacted: toNumber(summary?.services_impacted),
      sourceCount: toNumber(summary?.source_count),
      severity: {
        critical: toNumber(summary?.critical_incidents),
        high: toNumber(summary?.high_incidents),
        medium: toNumber(summary?.medium_incidents),
        low: toNumber(summary?.low_incidents),
        info: toNumber(summary?.info_incidents),
      },
      classification: {
        app: toNumber(summary?.app_incidents),
        infra: toNumber(summary?.infra_incidents),
        dependency: toNumber(summary?.dependency_incidents),
        security: toNumber(summary?.security_incidents),
        unknown: toNumber(summary?.unknown_incidents),
      },
    },
    trend: trendResult.rows.map((row) => ({
      date: row.date_bucket,
      incidents: toNumber(row.incidents),
      resolved: toNumber(row.resolved),
      linked: toNumber(row.linked),
      severe: toNumber(row.severe),
      averageMttrHours: toNumber(row.avg_mttr_hours),
    })),
    topServices: topServicesResult.rows.map((row) => ({
      serviceKey: row.service_key || "unknown-service",
      serviceName: row.service_name || "Unknown service",
      team: row.team,
      incidents: toNumber(row.incidents),
      severeIncidents: toNumber(row.severe_incidents),
      averageMttrHours: toNumber(row.avg_mttr_hours),
      lastOpenedAt: row.last_opened_at,
    })),
    meta: {
      daysRequested: filters.days,
      schemaReady: true,
      hasData: totalIncidents > 0,
      ...integration,
      filters: {
        teams: filters.teams,
        projectIds: filters.projectIds,
        serviceKeys: filters.serviceKeys,
        environments: filters.environments,
        severities: filters.severities,
        classifications: filters.classifications,
        sources: filters.sources,
      },
    },
  };
}

function resolveNormalizedIncident(raw: z.infer<typeof rawIncidentSchema>, defaultSource?: string): NormalizedIncident {
  const source = (raw.source || defaultSource || "").trim();
  if (!source) {
    throw new Error(`Incident ${raw.sourceIncidentId} is missing source`);
  }

  const serviceName = (raw.serviceName || raw.serviceKey || "unknown-service").trim();
  const serviceKey = (raw.serviceKey || slugify(serviceName || raw.sourceIncidentId)).trim().toLowerCase();

  return {
    ...raw,
    source,
    serviceKey,
    serviceName,
  };
}

async function upsertService(client: PoolClient, incident: NormalizedIncident): Promise<number> {
  const result = await client.query<{ id: number }>(
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
        service_name = COALESCE(EXCLUDED.service_name, services.service_name),
        team = COALESCE(EXCLUDED.team, services.team),
        gitlab_project_id = COALESCE(EXCLUDED.gitlab_project_id, services.gitlab_project_id),
        gitlab_project_path = COALESCE(EXCLUDED.gitlab_project_path, services.gitlab_project_path),
        updated_at = NOW()
      RETURNING id
    `,
    [
      incident.serviceKey,
      incident.serviceName,
      incident.team || null,
      incident.gitlabProjectId || null,
      incident.gitlabProjectPath || null,
    ]
  );

  return result.rows[0].id;
}

async function upsertIncident(client: PoolClient, incident: NormalizedIncident, serviceId: number) {
  const result = await client.query<{ id: number }>(
    `
      INSERT INTO production_incidents (
        source,
        source_incident_id,
        service_id,
        service_name,
        team,
        gitlab_project_id,
        environment,
        severity,
        status,
        classification,
        title,
        summary,
        opened_at,
        detected_at,
        acknowledged_at,
        resolved_at,
        source_url,
        namespace,
        workload_kind,
        workload_name,
        metadata,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18, $19, $20, $21, NOW()
      )
      ON CONFLICT (source, source_incident_id) DO UPDATE SET
        service_id = COALESCE(EXCLUDED.service_id, production_incidents.service_id),
        service_name = COALESCE(EXCLUDED.service_name, production_incidents.service_name),
        team = COALESCE(EXCLUDED.team, production_incidents.team),
        gitlab_project_id = COALESCE(EXCLUDED.gitlab_project_id, production_incidents.gitlab_project_id),
        environment = EXCLUDED.environment,
        severity = EXCLUDED.severity,
        status = EXCLUDED.status,
        classification = EXCLUDED.classification,
        title = EXCLUDED.title,
        summary = COALESCE(EXCLUDED.summary, production_incidents.summary),
        opened_at = EXCLUDED.opened_at,
        detected_at = COALESCE(EXCLUDED.detected_at, production_incidents.detected_at),
        acknowledged_at = COALESCE(EXCLUDED.acknowledged_at, production_incidents.acknowledged_at),
        resolved_at = COALESCE(EXCLUDED.resolved_at, production_incidents.resolved_at),
        source_url = COALESCE(EXCLUDED.source_url, production_incidents.source_url),
        namespace = COALESCE(EXCLUDED.namespace, production_incidents.namespace),
        workload_kind = COALESCE(EXCLUDED.workload_kind, production_incidents.workload_kind),
        workload_name = COALESCE(EXCLUDED.workload_name, production_incidents.workload_name),
        metadata = COALESCE(EXCLUDED.metadata, production_incidents.metadata),
        updated_at = NOW()
      RETURNING id
    `,
    [
      incident.source,
      incident.sourceIncidentId,
      serviceId,
      incident.serviceName,
      incident.team || null,
      incident.gitlabProjectId || null,
      incident.environment,
      incident.severity,
      incident.status,
      incident.classification,
      incident.title,
      incident.summary || null,
      incident.openedAt,
      incident.detectedAt || null,
      incident.acknowledgedAt || null,
      incident.resolvedAt || null,
      incident.sourceUrl || null,
      incident.namespace || null,
      incident.workloadKind || null,
      incident.workloadName || null,
      incident.metadata ? JSON.stringify(incident.metadata) : JSON.stringify({}),
    ]
  );

  return result.rows[0].id;
}

async function upsertIncidentEvents(client: PoolClient, incidentId: number, incident: NormalizedIncident) {
  for (const event of incident.events || []) {
    await client.query(
      `
        INSERT INTO incident_events (
          incident_id,
          event_type,
          status,
          message,
          happened_at,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (incident_id, event_type, happened_at) DO NOTHING
      `,
      [
        incidentId,
        event.eventType,
        event.status || null,
        event.message || null,
        event.happenedAt,
        event.metadata ? JSON.stringify(event.metadata) : JSON.stringify({}),
      ]
    );
  }
}

export async function ingestIncidents(payload: unknown) {
  const parsed = incidentIngestSchema.parse(payload);
  const schema = await getReliabilitySchemaStatus();

  if (!schema.schemaReady) {
    throw new Error("Reliability schema is not ready. Apply the reliability migration first.");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const normalizedIncidents = parsed.incidents.map((incident) =>
      resolveNormalizedIncident(incident, parsed.source)
    );

    const processedIds: number[] = [];
    const serviceKeys = new Set<string>();

    for (const incident of normalizedIncidents) {
      const serviceId = await upsertService(client, incident);
      const incidentId = await upsertIncident(client, incident, serviceId);
      await upsertIncidentEvents(client, incidentId, incident);

      processedIds.push(incidentId);
      serviceKeys.add(incident.serviceKey);
    }

    await client.query("COMMIT");

    return {
      processed: normalizedIncidents.length,
      incidentIds: processedIds,
      serviceKeys: Array.from(serviceKeys).sort(),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
