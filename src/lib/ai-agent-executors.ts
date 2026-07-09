// AI Agent Tool Executors - Actually execute the tools when Claude requests them

import { fetchInventory } from './aws-inventory';
import { collectMetricsForAccount } from './aws-cloudwatch-metrics';

// Account name to ID mapping
const ACCOUNT_MAP: Record<string, string> = {
  'eks dev': '111122223333', 'eks dev / default': '111122223333', 'default': '111122223333',
  'eks uat': '222233334444',
  'eks prod': '333344445555',
  'eks tooling': '444455556666', 'tooling': '444455556666',
  'helios dev': '555566667777',
  'helios uat': '666677778888',
  'helios prod': '777788889999',
  'digital ecommerce': '888899990000',
  'digital dev': '999900001111',
  'digital uat': '000011112222',
  'digital prod': '111222333444',
  'ecommerce tiendanimal': '222333444555',
  'iskaypet ecommerce': '333444555666',
  'retail dev': '444555666777',
  'retail uat': '555666777888',
  'retail prod': '666777888999',
  'animalis dev': '777888999000',
  'animalis prod': '888999000111',
  'clinicanimal': '999000111222',
  'data dev': '100200300400',
  'iskaypet data': '200300400500', 'data': '200300400500',
  'infra': '300400500600',
  'sap': '400500600700',
  'sistemas tiendanimal': '500600700800',
};

function resolveAccountId(name: string): string | null {
  const normalized = name.toLowerCase().trim();
  return ACCOUNT_MAP[normalized] || null;
}

// Cluster configs
const CLUSTER_CONFIGS: Record<string, { context: string; region: string; accountId: string }> = {
  'dp-dev': { context: 'arn:aws:eks:eu-west-1:111122223333:cluster/dp-dev', region: 'eu-west-1', accountId: '111122223333' },
  'dp-uat': { context: 'arn:aws:eks:eu-west-1:222233334444:cluster/dp-uat', region: 'eu-west-1', accountId: '222233334444' },
  'dp-prod': { context: 'arn:aws:eks:eu-west-1:333344445555:cluster/dp-prod', region: 'eu-west-1', accountId: '333344445555' },
  'dp-tooling': { context: 'arn:aws:eks:eu-west-1:444455556666:cluster/dp-tooling', region: 'eu-west-1', accountId: '444455556666' },
};

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// Main executor function
export async function executeTool(toolName: string, params: Record<string, string>): Promise<ToolResult> {
  try {
    switch (toolName) {
      // === AWS Tools ===
      case 'aws_list_accounts':
        return executeAwsListAccounts();
      case 'aws_list_ec2_instances':
        return await executeAwsListEc2(params);
      case 'aws_list_rds_instances':
        return await executeAwsListRds(params);
      case 'aws_get_costs':
        return await executeAwsGetCosts(params);
      case 'aws_get_resource_metrics':
        return await executeAwsGetMetrics(params);

      // === Kubernetes Tools ===
      case 'k8s_list_pods':
        return await executeK8sListPods(params);
      case 'k8s_get_pod_logs':
        return await executeK8sGetLogs(params);
      case 'k8s_describe_resource':
        return await executeK8sDescribe(params);
      case 'k8s_get_events':
        return await executeK8sGetEvents(params);

      // === GitLab Tools ===
      case 'gitlab_list_pipelines':
        return await executeGitlabListPipelines(params);
      case 'gitlab_get_pipeline_jobs':
        return await executeGitlabGetJobs(params);
      case 'gitlab_get_job_log':
        return await executeGitlabGetJobLog(params);
      case 'gitlab_list_merge_requests':
        return await executeGitlabListMRs(params);
      case 'gitlab_search_projects':
        return await executeGitlabSearchProjects(params);

      // === Grafana / Prometheus Tools ===
      case 'grafana_query_prometheus':
        return await executeGrafanaQuery(params);
      case 'grafana_query_range':
        return await executeGrafanaQueryRange(params);

      // === DORA / DB Tools ===
      case 'dora_get_metrics_summary':
        return await executeDoraMetricsSummary(params);
      case 'dora_get_project_ranking':
        return await executeDoraProjectRanking(params);

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// === AWS Executors ===

function executeAwsListAccounts(): ToolResult {
  const accounts = Object.entries(ACCOUNT_MAP)
    .filter(([name]) => !name.includes('/') && name !== 'default' && name !== 'tooling' && name !== 'data')
    .map(([name, id]) => ({
      name: name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      id,
    }))
    .filter((v, i, a) => a.findIndex(t => t.id === v.id) === i) // unique by id
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    success: true,
    data: {
      total: accounts.length,
      accounts,
    },
  };
}

async function executeAwsListEc2(params: Record<string, string>): Promise<ToolResult> {
  const accountId = resolveAccountId(params.account_name);
  if (!accountId) {
    return { success: false, error: `Cuenta no encontrada: ${params.account_name}. Cuentas disponibles: EKS Dev, EKS Prod, Digital Ecommerce, etc.` };
  }

  const inventory = await fetchInventory([accountId]);
  const ec2Service = inventory.byService.find(s => s.service === 'EC2 - Instances');
  
  if (!ec2Service) {
    return { success: true, data: { instances: [], message: 'No se encontraron instancias EC2' } };
  }

  let instances = ec2Service.details;
  if (params.state && params.state !== 'all') {
    instances = instances.filter(i => i.state === params.state);
  }

  return {
    success: true,
    data: {
      account: params.account_name,
      total: instances.length,
      instances: instances.map(i => ({
        id: i.id,
        name: i.name,
        type: i.type,
        state: i.state,
      })),
    },
  };
}

async function executeAwsListRds(params: Record<string, string>): Promise<ToolResult> {
  const accountId = resolveAccountId(params.account_name);
  if (!accountId) {
    return { success: false, error: `Cuenta no encontrada: ${params.account_name}` };
  }

  const inventory = await fetchInventory([accountId]);
  const rdsService = inventory.byService.find(s => s.service === 'RDS - DB Instances');

  return {
    success: true,
    data: {
      account: params.account_name,
      total: rdsService?.details.length || 0,
      databases: rdsService?.details.map(d => ({
        name: d.name,
        type: d.type,
        state: d.state,
      })) || [],
    },
  };
}

async function executeAwsGetCosts(_params: Record<string, string>): Promise<ToolResult> {
  // TODO: Implement CUR/Athena query
  return {
    success: true,
    data: {
      message: 'Función de costes pendiente de implementar. Usa el dashboard de FinOps Analytics por ahora.',
    },
  };
}

async function executeAwsGetMetrics(params: Record<string, string>): Promise<ToolResult> {
  const accountId = resolveAccountId(params.account_name);
  if (!accountId) {
    return { success: false, error: `Cuenta no encontrada: ${params.account_name}` };
  }

  // Get inventory first to build the service structure needed by collectMetricsForAccount
  const inventory = await fetchInventory([accountId]);
  const account = inventory.accounts[0];
  if (!account) {
    return { success: false, error: 'No se pudo obtener inventario de la cuenta' };
  }

  const metrics = await collectMetricsForAccount(accountId, account.services, 14);
  const resourceMetrics = metrics.find(m => 
    m.resourceId === params.resource_id || m.resourceName === params.resource_id
  );

  if (!resourceMetrics) {
    return { success: true, data: { message: `No se encontraron métricas para ${params.resource_id}` } };
  }

  return { success: true, data: resourceMetrics };
}

// === Kubernetes Executors ===
// Note: These require kubectl access from the pod. For now, return stubs.

async function executeK8sListPods(params: Record<string, string>): Promise<ToolResult> {
  const cluster = CLUSTER_CONFIGS[params.cluster];
  if (!cluster) {
    return { success: false, error: `Cluster no encontrado: ${params.cluster}. Disponibles: dp-dev, dp-uat, dp-prod, dp-tooling` };
  }

  // TODO: Execute kubectl via child_process or Kubernetes API
  return {
    success: true,
    data: {
      message: `[STUB] Listando pods en ${params.cluster}/${params.namespace || 'all namespaces'}`,
      note: 'Kubernetes integration pendiente. Necesita configurar kubectl en el pod.',
    },
  };
}

async function executeK8sGetLogs(params: Record<string, string>): Promise<ToolResult> {
  return {
    success: true,
    data: {
      message: `[STUB] Logs de ${params.pod_name} en ${params.cluster}/${params.namespace}`,
      note: 'Kubernetes integration pendiente.',
    },
  };
}

async function executeK8sDescribe(params: Record<string, string>): Promise<ToolResult> {
  return {
    success: true,
    data: {
      message: `[STUB] Describe ${params.resource_type}/${params.resource_name} en ${params.cluster}/${params.namespace}`,
      note: 'Kubernetes integration pendiente.',
    },
  };
}

async function executeK8sGetEvents(params: Record<string, string>): Promise<ToolResult> {
  return {
    success: true,
    data: {
      message: `[STUB] Eventos en ${params.cluster}/${params.namespace}`,
      note: 'Kubernetes integration pendiente.',
    },
  };
}

// === GitLab Executors ===

const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.iskaypet.com';
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;

async function gitlabFetch(endpoint: string): Promise<unknown> {
  if (!GITLAB_TOKEN) {
    throw new Error('GITLAB_TOKEN no configurado');
  }
  const res = await fetch(`${GITLAB_URL}/api/v4${endpoint}`, {
    headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN },
  });
  if (!res.ok) {
    throw new Error(`GitLab API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function executeGitlabListPipelines(params: Record<string, string>): Promise<ToolResult> {
  if (!GITLAB_TOKEN) {
    return { success: false, error: 'GITLAB_TOKEN no configurado en el servidor' };
  }

  const project = encodeURIComponent(params.project);
  const limit = params.limit || '10';
  let url = `/projects/${project}/pipelines?per_page=${limit}`;
  if (params.status && params.status !== 'all') {
    url += `&status=${params.status}`;
  }

  const pipelines = await gitlabFetch(url);
  return { success: true, data: pipelines };
}

async function executeGitlabGetJobs(params: Record<string, string>): Promise<ToolResult> {
  if (!GITLAB_TOKEN) {
    return { success: false, error: 'GITLAB_TOKEN no configurado' };
  }

  const project = encodeURIComponent(params.project);
  const jobs = await gitlabFetch(`/projects/${project}/pipelines/${params.pipeline_id}/jobs`);
  return { success: true, data: jobs };
}

async function executeGitlabGetJobLog(params: Record<string, string>): Promise<ToolResult> {
  if (!GITLAB_TOKEN) {
    return { success: false, error: 'GITLAB_TOKEN no configurado' };
  }

  const project = encodeURIComponent(params.project);
  const res = await fetch(`${GITLAB_URL}/api/v4/projects/${project}/jobs/${params.job_id}/trace`, {
    headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN },
  });
  
  if (!res.ok) {
    return { success: false, error: `Error obteniendo log: ${res.status}` };
  }

  const log = await res.text();
  // Truncate if too long
  const truncated = log.length > 5000 ? log.slice(-5000) + '\n...[truncated]' : log;
  return { success: true, data: { log: truncated } };
}

async function executeGitlabListMRs(params: Record<string, string>): Promise<ToolResult> {
  if (!GITLAB_TOKEN) {
    return { success: false, error: 'GITLAB_TOKEN no configurado' };
  }

  const project = encodeURIComponent(params.project);
  const state = params.state || 'opened';
  const mrs = await gitlabFetch(`/projects/${project}/merge_requests?state=${state}&per_page=10`);
  return { success: true, data: mrs };
}

async function executeGitlabSearchProjects(params: Record<string, string>): Promise<ToolResult> {
  if (!GITLAB_TOKEN) {
    return { success: false, error: 'GITLAB_TOKEN no configurado' };
  }

  const projects = await gitlabFetch(`/projects?search=${encodeURIComponent(params.query)}&per_page=10`);
  return { success: true, data: projects };
}

// === Grafana / Prometheus Executors ===

async function executeGrafanaQuery(params: Record<string, string>): Promise<ToolResult> {
  try {
    const { grafanaMetricsClient } = await import('./grafana-metrics');
    const status = grafanaMetricsClient.getStatus();
    if (!status.ready) {
      return { success: false, error: `Grafana Metrics no configurado. Faltan: ${status.missing.join(', ')}` };
    }
    const result = await grafanaMetricsClient.query(params.query);
    // Limit results to avoid huge payloads
    const trimmed = result.result.slice(0, 50).map((r: any) => ({
      metric: r.metric,
      value: r.value?.[1],
    }));
    return { success: true, data: { results: trimmed, total: result.result.length, warnings: result.warnings } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Error querying Grafana' };
  }
}

async function executeGrafanaQueryRange(params: Record<string, string>): Promise<ToolResult> {
  try {
    const { grafanaMetricsClient } = await import('./grafana-metrics');
    const status = grafanaMetricsClient.getStatus();
    if (!status.ready) {
      return { success: false, error: `Grafana Metrics no configurado. Faltan: ${status.missing.join(', ')}` };
    }
    const hours = parseInt(params.hours || '24');
    const step = params.step || '1h';
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3600 * 1000);

    const result = await grafanaMetricsClient.queryRange(params.query, { start, end, step });
    // Summarize: for each series, return metric labels + last value + min/max/avg
    const summary = result.result.slice(0, 30).map((r: any) => {
      const values = (r.values || []).map((v: any) => parseFloat(v[1])).filter((v: number) => !isNaN(v));
      return {
        metric: r.metric,
        points: values.length,
        last: values[values.length - 1],
        min: values.length ? Math.min(...values) : null,
        max: values.length ? Math.max(...values) : null,
        avg: values.length ? (values.reduce((a: number, b: number) => a + b, 0) / values.length) : null,
      };
    });
    return { success: true, data: { series: summary, total: result.result.length } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Error querying Grafana range' };
  }
}

// === DORA / DB Executors ===

async function executeDoraMetricsSummary(params: Record<string, string>): Promise<ToolResult> {
  try {
    const pool = (await import('./db')).default;
    const days = parseInt(params.days || '30');
    const { format, subDays } = await import('date-fns');
    const endDate = new Date();
    const startDate = subDays(endDate, days);

    let projectFilter = '';
    const queryParams: any[] = [format(startDate, 'yyyy-MM-dd'), format(endDate, 'yyyy-MM-dd')];
    if (params.project_name) {
      projectFilter = ` AND LOWER(project_name) LIKE $3`;
      queryParams.push(`%${params.project_name.toLowerCase()}%`);
    }

    const result = await pool.query(`
      SELECT 
        COUNT(DISTINCT project_id) as active_projects,
        SUM(deployment_count) as total_deploys,
        SUM(deployment_failures) as total_failures,
        CASE WHEN SUM(deployment_count) + SUM(deployment_failures) > 0
          THEN ROUND(SUM(deployment_failures)::numeric / (SUM(deployment_count) + SUM(deployment_failures)) * 100, 2)
          ELSE 0 END as cfr_pct,
        ROUND(AVG(CASE WHEN lead_time_count > 0 THEN lead_time_sum_hours / lead_time_count ELSE NULL END)::numeric, 2) as avg_lead_time_hours,
        ROUND(AVG(CASE WHEN mttr_count > 0 THEN mttr_sum_hours / mttr_count ELSE NULL END)::numeric, 2) as avg_mttr_hours,
        ROUND(SUM(deployment_count)::numeric / NULLIF(${days}, 0), 2) as deploys_per_day,
        COUNT(DISTINCT snapshot_date) as days_with_data
      FROM dora_metrics_daily
      WHERE snapshot_date >= $1 AND snapshot_date <= $2 ${projectFilter}
    `, queryParams);

    return { success: true, data: result.rows[0] };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Error querying DORA metrics' };
  }
}

async function executeDoraProjectRanking(params: Record<string, string>): Promise<ToolResult> {
  try {
    const pool = (await import('./db')).default;
    const days = parseInt(params.days || '30');
    const limit = parseInt(params.limit || '10');
    const { format, subDays } = await import('date-fns');
    const endDate = new Date();
    const startDate = subDays(endDate, days);

    let orderBy: string;
    switch (params.metric) {
      case 'deployment_frequency':
        orderBy = 'SUM(deployment_count) DESC';
        break;
      case 'lead_time':
        orderBy = 'AVG(CASE WHEN lead_time_count > 0 THEN lead_time_sum_hours / lead_time_count ELSE NULL END) ASC NULLS LAST';
        break;
      case 'cfr':
        orderBy = 'CASE WHEN SUM(deployment_count) + SUM(deployment_failures) > 0 THEN SUM(deployment_failures)::float / (SUM(deployment_count) + SUM(deployment_failures)) ELSE 0 END ASC';
        break;
      case 'mttr':
        orderBy = 'AVG(CASE WHEN mttr_count > 0 THEN mttr_sum_hours / mttr_count ELSE NULL END) ASC NULLS LAST';
        break;
      default:
        orderBy = 'SUM(deployment_count) DESC';
    }

    const result = await pool.query(`
      SELECT 
        project_name,
        SUM(deployment_count) as deploys,
        SUM(deployment_failures) as failures,
        ROUND(AVG(CASE WHEN lead_time_count > 0 THEN lead_time_sum_hours / lead_time_count ELSE NULL END)::numeric, 2) as avg_lead_time_h,
        ROUND(AVG(CASE WHEN mttr_count > 0 THEN mttr_sum_hours / mttr_count ELSE NULL END)::numeric, 2) as avg_mttr_h,
        CASE WHEN SUM(deployment_count) + SUM(deployment_failures) > 0
          THEN ROUND(SUM(deployment_failures)::numeric / (SUM(deployment_count) + SUM(deployment_failures)) * 100, 1)
          ELSE 0 END as cfr_pct
      FROM dora_metrics_daily
      WHERE snapshot_date >= $1 AND snapshot_date <= $2
        AND (deployment_count > 0 OR deployment_failures > 0)
      GROUP BY project_name
      ORDER BY ${orderBy}
      LIMIT $3
    `, [format(startDate, 'yyyy-MM-dd'), format(endDate, 'yyyy-MM-dd'), limit]);

    return { success: true, data: result.rows };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Error querying DORA ranking' };
  }
}
