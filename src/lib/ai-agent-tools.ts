// AI Agent Tools - Definitions and executors for the multi-agent system

export interface ToolDefinition {
  name: string;
  description: string;
  category: 'aws' | 'kubernetes' | 'gitlab' | 'grafana' | 'general';
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

// Tool definitions that Claude will use to decide what to call
export const AGENT_TOOLS: ToolDefinition[] = [
  // === AWS Tools ===
  {
    name: 'aws_list_accounts',
    description: 'Lista todas las cuentas AWS disponibles con su nombre e ID',
    category: 'aws',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'aws_list_ec2_instances',
    description: 'Lista instancias EC2 en una cuenta AWS con su estado, tipo y uso de CPU',
    category: 'aws',
    input_schema: {
      type: 'object',
      properties: {
        account_name: { type: 'string', description: 'Nombre de la cuenta AWS (ej: "EKS Prod", "Digital Ecommerce")' },
        state: { type: 'string', description: 'Filtrar por estado', enum: ['running', 'stopped', 'all'] },
      },
      required: ['account_name'],
    },
  },
  {
    name: 'aws_list_rds_instances',
    description: 'Lista bases de datos RDS en una cuenta AWS',
    category: 'aws',
    input_schema: {
      type: 'object',
      properties: {
        account_name: { type: 'string', description: 'Nombre de la cuenta AWS' },
      },
      required: ['account_name'],
    },
  },
  {
    name: 'aws_get_costs',
    description: 'Obtiene costes AWS por servicio o cuenta en un periodo',
    category: 'aws',
    input_schema: {
      type: 'object',
      properties: {
        account_name: { type: 'string', description: 'Nombre de la cuenta (opcional, si no se especifica devuelve todas)' },
        days: { type: 'string', description: 'Número de días hacia atrás (default: 30)' },
      },
    },
  },
  {
    name: 'aws_get_resource_metrics',
    description: 'Obtiene métricas CloudWatch de un recurso específico (CPU, memoria, conexiones)',
    category: 'aws',
    input_schema: {
      type: 'object',
      properties: {
        resource_type: { type: 'string', description: 'Tipo de recurso', enum: ['ec2', 'rds', 'elasticache', 'elb'] },
        resource_id: { type: 'string', description: 'ID del recurso (instance-id, db-identifier, etc)' },
        account_name: { type: 'string', description: 'Nombre de la cuenta AWS' },
      },
      required: ['resource_type', 'resource_id', 'account_name'],
    },
  },

  // === Kubernetes Tools ===
  {
    name: 'k8s_list_pods',
    description: 'Lista pods en un namespace de un cluster Kubernetes',
    category: 'kubernetes',
    input_schema: {
      type: 'object',
      properties: {
        cluster: { type: 'string', description: 'Nombre del cluster', enum: ['dp-dev', 'dp-uat', 'dp-prod', 'dp-tooling'] },
        namespace: { type: 'string', description: 'Namespace (default: todos)' },
        status: { type: 'string', description: 'Filtrar por estado', enum: ['Running', 'Pending', 'Failed', 'CrashLoopBackOff', 'all'] },
      },
      required: ['cluster'],
    },
  },
  {
    name: 'k8s_get_pod_logs',
    description: 'Obtiene los logs de un pod específico',
    category: 'kubernetes',
    input_schema: {
      type: 'object',
      properties: {
        cluster: { type: 'string', description: 'Nombre del cluster' },
        namespace: { type: 'string', description: 'Namespace del pod' },
        pod_name: { type: 'string', description: 'Nombre del pod' },
        lines: { type: 'string', description: 'Número de líneas (default: 100)' },
      },
      required: ['cluster', 'namespace', 'pod_name'],
    },
  },
  {
    name: 'k8s_describe_resource',
    description: 'Describe un recurso Kubernetes (pod, deployment, service, etc)',
    category: 'kubernetes',
    input_schema: {
      type: 'object',
      properties: {
        cluster: { type: 'string', description: 'Nombre del cluster' },
        namespace: { type: 'string', description: 'Namespace' },
        resource_type: { type: 'string', description: 'Tipo de recurso', enum: ['pod', 'deployment', 'service', 'ingress', 'configmap', 'secret', 'pvc'] },
        resource_name: { type: 'string', description: 'Nombre del recurso' },
      },
      required: ['cluster', 'namespace', 'resource_type', 'resource_name'],
    },
  },
  {
    name: 'k8s_get_events',
    description: 'Obtiene eventos recientes de un namespace (útil para debugging)',
    category: 'kubernetes',
    input_schema: {
      type: 'object',
      properties: {
        cluster: { type: 'string', description: 'Nombre del cluster' },
        namespace: { type: 'string', description: 'Namespace' },
      },
      required: ['cluster', 'namespace'],
    },
  },

  // === GitLab Tools ===
  {
    name: 'gitlab_list_pipelines',
    description: 'Lista pipelines de un proyecto GitLab',
    category: 'gitlab',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Nombre del proyecto (ej: "platform/backend-api")' },
        status: { type: 'string', description: 'Filtrar por estado', enum: ['failed', 'success', 'running', 'pending', 'all'] },
        limit: { type: 'string', description: 'Número máximo de resultados (default: 10)' },
      },
      required: ['project'],
    },
  },
  {
    name: 'gitlab_get_pipeline_jobs',
    description: 'Obtiene los jobs de un pipeline específico',
    category: 'gitlab',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Nombre del proyecto' },
        pipeline_id: { type: 'string', description: 'ID del pipeline' },
      },
      required: ['project', 'pipeline_id'],
    },
  },
  {
    name: 'gitlab_get_job_log',
    description: 'Obtiene el log de un job específico de GitLab CI',
    category: 'gitlab',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Nombre del proyecto' },
        job_id: { type: 'string', description: 'ID del job' },
      },
      required: ['project', 'job_id'],
    },
  },
  {
    name: 'gitlab_list_merge_requests',
    description: 'Lista merge requests de un proyecto',
    category: 'gitlab',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Nombre del proyecto' },
        state: { type: 'string', description: 'Estado del MR', enum: ['opened', 'merged', 'closed', 'all'] },
      },
      required: ['project'],
    },
  },
  {
    name: 'gitlab_search_projects',
    description: 'Busca proyectos en GitLab por nombre',
    category: 'gitlab',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Término de búsqueda' },
      },
      required: ['query'],
    },
  },

  // === Grafana / Prometheus Tools ===
  {
    name: 'grafana_query_prometheus',
    description: 'Ejecuta una query PromQL contra Grafana Cloud Metrics (Prometheus/Mimir). Útil para métricas de K8s, ArgoCD, etc. Las métricas de K8s deben filtrar por k8s_cluster_name="dp-prod".',
    category: 'grafana',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Query PromQL (ej: \'up{k8s_cluster_name="dp-prod"}\')' },
      },
      required: ['query'],
    },
  },
  {
    name: 'grafana_query_range',
    description: 'Ejecuta una query PromQL de rango temporal. Devuelve series temporales.',
    category: 'grafana',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Query PromQL' },
        hours: { type: 'string', description: 'Horas hacia atrás (default: 24)' },
        step: { type: 'string', description: 'Resolución (default: "1h")' },
      },
      required: ['query'],
    },
  },

  // === DORA / DB Tools ===
  {
    name: 'dora_get_metrics_summary',
    description: 'Obtiene resumen de métricas DORA de la base de datos: deployment frequency, lead time, CFR, MTTR. Puede filtrar por proyecto o equipo.',
    category: 'general',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'string', description: 'Días hacia atrás (default: 30)' },
        project_name: { type: 'string', description: 'Filtrar por nombre de proyecto (opcional)' },
      },
    },
  },
  {
    name: 'dora_get_project_ranking',
    description: 'Ranking de proyectos por una métrica DORA específica',
    category: 'general',
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', description: 'Métrica para ordenar', enum: ['deployment_frequency', 'lead_time', 'cfr', 'mttr'] },
        days: { type: 'string', description: 'Días hacia atrás (default: 30)' },
        limit: { type: 'string', description: 'Número de proyectos (default: 10)' },
      },
      required: ['metric'],
    },
  },
];

// Categories to exclude — these tools are stubs or unreliable from the pod
const EXCLUDED_CATEGORIES: Set<string> = new Set(['kubernetes']);

// Specific tools to exclude (stubs, not working from pod, etc.)
const EXCLUDED_TOOLS: Set<string> = new Set([
  'aws_get_costs',           // Not implemented yet (returns stub)
  'aws_get_resource_metrics', // Unreliable from pod
]);

// Format tools for Claude API — filters out stubs and non-operational tools
export function getToolsForClaude() {
  return AGENT_TOOLS
    .filter(tool => !EXCLUDED_CATEGORIES.has(tool.category))
    .filter(tool => !EXCLUDED_TOOLS.has(tool.name))
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));
}
