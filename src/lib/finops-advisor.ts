import type { ResourceMetrics } from './aws-cloudwatch-metrics';
import type { FinOpsAdvisorInsights } from './finops-advisor-insights';

type ResourceMetadata = Record<string, string | number | boolean | null | undefined>;

interface InventoryResourceDetail {
  id: string;
  name: string;
  type: string;
  state: string;
  terraform: boolean;
  metadata?: ResourceMetadata;
}

export interface FinOpsAdvisorInput {
  inventory: {
    totalResources: number;
    accounts: {
      accountId: string;
      accountName: string;
      totalResources: number;
      services: { name: string; resourceCount: number; details: InventoryResourceDetail[] }[];
    }[];
    byService: {
      service: string;
      resourceCount: number;
      regions: string[];
      details: InventoryResourceDetail[];
    }[];
  };
  metrics: ResourceMetrics[];
  costs?: {
    totalCost: number;
    byAccount: { accountId: string; accountName: string; cost: number }[];
    byService: { service: string; cost: number }[];
  } | null;
}

// AWS pricing estimates (eu-west-1, on-demand, USD/month)
const EC2_PRICING: Record<string, number> = {
  't3.nano': 3.8, 't3.micro': 7.6, 't3.small': 15.2, 't3.medium': 30.4, 't3.large': 60.7, 't3.xlarge': 121.5, 't3.2xlarge': 243,
  't3a.nano': 3.4, 't3a.micro': 6.8, 't3a.small': 13.7, 't3a.medium': 27.4, 't3a.large': 54.7, 't3a.xlarge': 109.5,
  't4g.nano': 3.1, 't4g.micro': 6.1, 't4g.small': 12.3, 't4g.medium': 24.5, 't4g.large': 49.1, 't4g.xlarge': 98.1, 't4g.2xlarge': 196.2,
  't2.micro': 8.5, 't2.small': 16.9, 't2.medium': 33.9, 't2.large': 67.7, 't2.xlarge': 135.4,
  'm5.large': 70.1, 'm5.xlarge': 140.2, 'm5.2xlarge': 280.3, 'm5.4xlarge': 560.6,
  'm6i.large': 70.1, 'm6i.xlarge': 140.2, 'm6i.2xlarge': 280.3, 'm6i.4xlarge': 560.6,
  'm6g.large': 56.2, 'm6g.xlarge': 112.4, 'm6g.2xlarge': 224.7, 'm6g.4xlarge': 449.4,
  'm7g.large': 59.5, 'm7g.xlarge': 119, 'm7g.2xlarge': 238, 'm7g.4xlarge': 476,
  'r5.large': 91.3, 'r5.xlarge': 182.5, 'r5.2xlarge': 365, 'r5.4xlarge': 730,
  'r6i.large': 91.3, 'r6i.xlarge': 182.5, 'r6i.2xlarge': 365,
  'r6g.large': 73, 'r6g.xlarge': 146.1, 'r6g.2xlarge': 292.2,
  'r7g.large': 77.4, 'r7g.xlarge': 154.8, 'r7g.2xlarge': 309.6,
  'c5.large': 62, 'c5.xlarge': 124, 'c5.2xlarge': 248, 'c5.4xlarge': 496,
  'c6i.large': 62, 'c6i.xlarge': 124, 'c6i.2xlarge': 248,
  'c6g.large': 49.6, 'c6g.xlarge': 99.3, 'c6g.2xlarge': 198.6,
  'c7g.large': 52.6, 'c7g.xlarge': 105.1, 'c7g.2xlarge': 210.2,
};

const RDS_PRICING: Record<string, number> = {
  'db.t3.micro': 12.4, 'db.t3.small': 24.8, 'db.t3.medium': 49.6, 'db.t3.large': 99.3,
  'db.t4g.micro': 11.8, 'db.t4g.small': 23.7, 'db.t4g.medium': 47.3, 'db.t4g.large': 94.6,
  'db.m5.large': 125, 'db.m5.xlarge': 250, 'db.m5.2xlarge': 500,
  'db.m6i.large': 125, 'db.m6i.xlarge': 250, 'db.m6i.2xlarge': 500,
  'db.m6g.large': 100, 'db.m6g.xlarge': 200, 'db.m6g.2xlarge': 400,
  'db.m7g.large': 106, 'db.m7g.xlarge': 212, 'db.m7g.2xlarge': 424,
  'db.r5.large': 166, 'db.r5.xlarge': 332, 'db.r5.2xlarge': 664,
  'db.r6i.large': 166, 'db.r6i.xlarge': 332, 'db.r6i.2xlarge': 664,
  'db.r6g.large': 133, 'db.r6g.xlarge': 266, 'db.r6g.2xlarge': 532,
  'db.r7g.large': 141, 'db.r7g.xlarge': 282, 'db.r7g.2xlarge': 564,
};

const ELASTICACHE_PRICING: Record<string, number> = {
  'cache.t3.micro': 12, 'cache.t3.small': 24, 'cache.t3.medium': 48,
  'cache.m5.large': 112, 'cache.r5.large': 148,
};

function getEc2Price(type: string): number {
  return EC2_PRICING[type.toLowerCase()] || 50;
}

function getRdsPrice(type: string): number {
  const normalized = type.split('/')[0].trim().toLowerCase();
  return RDS_PRICING[normalized] || 100;
}

function getCachePrice(type: string): number {
  const normalized = type.split('/')[0].trim().toLowerCase();
  return ELASTICACHE_PRICING[normalized] || 50;
}

function parseVolumeSizeGb(type: string): number {
  const match = type.match(/(\d+)\s*GiB/i);
  return match ? Number(match[1]) : 50;
}

function suggestDownsize(type: string, cpuAvg: number): { suggested: string; savings: number } | null {
  const sizes = ['nano', 'micro', 'small', 'medium', 'large', 'xlarge', '2xlarge', '4xlarge'];
  const parts = type.toLowerCase().split('.');
  if (parts.length < 2) return null;
  const family = parts[0];
  const currentSize = parts.slice(1).join('.');
  const currentIdx = sizes.findIndex(s => currentSize.includes(s));
  if (currentIdx <= 0) return null;

  const currentPrice = EC2_PRICING[type.toLowerCase()] || RDS_PRICING[type.toLowerCase()] || 50;

  // First: try Graviton migration (same size, ~20% cheaper)
  const gravitonMap: Record<string, string> = {
    'm5': 'm6g', 'm6i': 'm6g', 'c5': 'c6g', 'c6i': 'c6g', 'r5': 'r6g', 'r6i': 'r6g',
    't3': 't4g', 't3a': 't4g',
  };
  const gravitonFamily = gravitonMap[family];
  if (gravitonFamily) {
    const gravitonType = `${gravitonFamily}.${currentSize}`;
    const gravitonPrice = EC2_PRICING[gravitonType];
    if (gravitonPrice && gravitonPrice < currentPrice) {
      return { suggested: gravitonType, savings: Math.round(currentPrice - gravitonPrice) };
    }
  }

  // Second: downsize within same family
  const stepsDown = cpuAvg < 10 ? 2 : 1;
  const newIdx = Math.max(0, currentIdx - stepsDown);
  if (newIdx === currentIdx) return null;
  const newSize = sizes[newIdx];
  const suggested = `${family}.${newSize}`;
  const newPrice = EC2_PRICING[suggested] || RDS_PRICING[`db.${suggested}`] || currentPrice * 0.5;
  return { suggested, savings: Math.round(currentPrice - newPrice) };
}

function getMetaString(detail: InventoryResourceDetail, key: string): string | null {
  const value = detail.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getMetaNumber(detail: InventoryResourceDetail, key: string): number | null {
  const value = detail.metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getMetaBoolean(detail: InventoryResourceDetail, key: string): boolean | null {
  const value = detail.metadata?.[key];
  return typeof value === 'boolean' ? value : null;
}

function getAccountLabel(detail: InventoryResourceDetail): string {
  return getMetaString(detail, 'accountName') || getMetaString(detail, 'accountId') || '-';
}

function getRegionLabel(detail: InventoryResourceDetail): string {
  return getMetaString(detail, 'region') || '-';
}

function formatFlag(value: boolean | null): string {
  if (value === null) return '-';
  return value ? 'Sí' : 'No';
}

function formatMetric(value: number | null | undefined, suffix = ''): string {
  return value === null || value === undefined ? '-' : `${value}${suffix}`;
}

function getRdsClass(detail: InventoryResourceDetail): string {
  return getMetaString(detail, 'instanceClass') || detail.type.split('/')[0].trim();
}

function getRdsEngine(detail: InventoryResourceDetail): string {
  const engine = getMetaString(detail, 'engine');
  const version = getMetaString(detail, 'engineVersion');
  if (engine && version) return `${engine} ${version}`;
  if (engine) return engine;
  return detail.type.split('/')[1]?.trim() || detail.type;
}

function getRdsStorageLabel(detail: InventoryResourceDetail): string {
  const storageType = getMetaString(detail, 'storageType');
  const allocatedStorageGb = getMetaNumber(detail, 'allocatedStorageGb');
  if (storageType && allocatedStorageGb !== null) return `${storageType} / ${allocatedStorageGb} GiB`;
  if (allocatedStorageGb !== null) return `${allocatedStorageGb} GiB`;
  return storageType || '-';
}

function getRdsClusterCapacity(detail: InventoryResourceDetail): string {
  const min = getMetaNumber(detail, 'serverlessV2MinCapacity');
  const max = getMetaNumber(detail, 'serverlessV2MaxCapacity');
  if (min !== null && max !== null) return `${min}-${max} ACU`;
  return '-';
}

// Language names for the system prompt
const LOCALE_NAMES: Record<string, string> = {
  es: "español",
  en: "English",
  fr: "français",
  pt: "português",
};

// System prompt for the FinOps AI advisor
export function getFinOpsSystemPrompt(locale = "es"): string {
  const langName = LOCALE_NAMES[locale] || LOCALE_NAMES.es;
  const langDirective = locale === "es"
    ? ""
    : `\n\nIMPORTANTE: Genera TODO el informe en ${langName}. Todos los títulos, descripciones, recomendaciones, categorías y texto libre deben estar en ${langName}. Los nombres técnicos de servicios AWS, IDs de recursos y métricas se mantienen en inglés.\n`;

  return `Eres un consultor FinOps senior certificado (FinOps Certified Practitioner) con más de 10 años de experiencia optimizando infraestructura AWS para empresas enterprise.

Tu rol es generar informes de optimización de costes AWS profesionales, detallados y accionables.
${langDirective}
REGLAS CRÍTICAS:
- Responde SIEMPRE en Markdown bien estructurado con tablas, headers, emojis y listas
- Incluye SIEMPRE cifras concretas en USD/mes — nunca dejes un recurso sin estimación de coste
- Sé ESPECÍFICO: nombra cada recurso con su ID, cuenta, tipo y coste
- Para rightsizing: tipo actual → tipo recomendado con ahorro calculado
- Prioriza SIEMPRE por impacto económico (mayor ahorro primero)
- Usa SOLO los datos proporcionados, no inventes recursos
- Si hay métricas P95, úsalas para validar que el rightsizing es seguro (P95 bajo = seguro bajar)
- Si hay Performance Insights con top waits, úsalos para distinguir CPU vs I/O vs locking
- Si hay costes CUR, cruza coste real vs uso para encontrar las mayores ineficiencias
- Si NO hay métricas, indícalo claramente y basa las recomendaciones en tipos de instancia

FORMATO DE EMOJIS:
💰 ahorro, 📊 datos, ⚠️ alertas, 🔴 crítico, 🟡 medio, 🟢 ok, 📉 rightsizing, 🗑️ eliminar, 🏗️ arquitectura, 📋 resumen

ESTRUCTURA OBLIGATORIA DEL INFORME:
1. 📋 Resumen Ejecutivo (ahorro total, estado general, top 3 acciones)
2. 💰 Quick Wins — recursos eliminables hoy (tabla con nombre, ID, cuenta, coste, acción)
3. 📉 Rightsizing — sobredimensionados (tabla con métricas CPU/mem, tipo actual → sugerido, ahorro)
4. 🦾 Migración a Graviton — instancias x86 que pueden migrar a ARM (m5→m6g, r5→r6g, c5→c6g, t3→t4g) con ~20% ahorro
5. 🔍 Correlación coste-uso (dónde se gasta mucho sin uso proporcional)
6. 💾 Storage (EBS sin adjuntar, gp2→gp3, S3 lifecycle)
7. 🌐 Red (NAT Gateways, ELBs sin tráfico, EIPs libres)
8. 🗄️ Bases de Datos (RDS rightsizing con PI data, ElastiCache, Multi-AZ innecesario en dev)
9. ⚡ Serverless (Lambda: memory optimization, invocaciones bajas, timeout excesivo)
10. 🏗️ Recomendaciones Arquitectónicas (Savings Plans, Spot, consolidación)
11. 🏷️ Gobernanza de Tags (cobertura actual, plan de mejora, impacto en visibilidad)
12. 📊 Plan de Acción Top 5 (tabla: acción, recurso, ahorro, esfuerzo, riesgo)

CONTEXTO:
- Región principal: eu-west-1 (Irlanda), multi-cuenta AWS con Organizations
- Infraestructura parcialmente con Terraform — el % de cobertura IaC es un indicador de madurez
- Clusters EKS para workloads containerizados
- Precios: estimaciones on-demand eu-west-1 en USD/mes
- Tags disponibles en CUR: user_domain (equipo/microservicio), user_department, user_environment (pro/dev/uat)
- IMPORTANTE: Solo ~10% del coste está taggeado. Recomienda SIEMPRE mejorar la cobertura de tags como acción prioritaria.
- Savings Plans: 1 Compute SP activo (expira abril 2028) con ~51% de ahorro. Evalúa si hay oportunidad de ampliar cobertura.
- Dominios principales: oms, helios, identifiers, marketplace, lastmilesservices, products, loyalty, mobile, animalis, core
- Cuentas más caras: EKS Tooling (Fee SP), Iskaypet Data, Digital Ecommerce, Retail Prod, Infraestructura, SAP, Digital Prod
`;
}

export function buildFinOpsPrompt(input: FinOpsAdvisorInput, insights?: FinOpsAdvisorInsights, locale = "es"): string {
  const { inventory, metrics, costs } = input;

  // Extract detailed resource info
  const ec2Instances = inventory.byService.find(s => s.service === 'EC2 - Instances')?.details || [];
  const ebsVolumes = inventory.byService.find(s => s.service === 'EC2 - EBS Volumes')?.details || [];
  const elasticIps = inventory.byService.find(s => s.service === 'EC2 - Elastic IPs')?.details || [];
  const rdsInstances = inventory.byService.find(s => s.service === 'RDS - DB Instances')?.details || [];
  const rdsClusters = inventory.byService.find(s => s.service === 'RDS - DB Clusters')?.details || [];
  const elasticache = inventory.byService.find(s => s.service === 'ElastiCache - Clusters')?.details || [];
  const loadBalancers = inventory.byService.find(s => s.service === 'ELB - Load Balancers')?.details || [];
  const targetGroups = inventory.byService.find(s => s.service === 'ELB - Target Groups')?.details || [];
  const natGateways = inventory.byService.find(s => s.service === 'VPC - NAT Gateways')?.details || [];
  const s3Buckets = inventory.byService.find(s => s.service === 'S3 - Buckets')?.details || [];
  const lambdaFunctions = inventory.byService.find(s => s.service === 'Lambda - Functions')?.details || [];
  const securityGroups = inventory.byService.find(s => s.service === 'EC2 - Security Groups')?.details || [];
  const networkInterfaces = inventory.byService.find(s => s.service === 'VPC - Network Interfaces')?.details || [];

  // Categorize resources
  const ec2Running = ec2Instances
    .filter(i => i.state === 'running')
    .sort((a, b) => getEc2Price(b.type) - getEc2Price(a.type));
  const ec2Stopped = ec2Instances.filter(i => i.state === 'stopped');
  const ebsAvailable = ebsVolumes
    .filter(v => v.state === 'available')
    .sort((a, b) => parseVolumeSizeGb(b.type) - parseVolumeSizeGb(a.type));
  const eipsUnassociated = elasticIps.filter(e => e.state === 'available');

  // Calculate estimated costs
  const ec2RunningCost = ec2Running.reduce((sum, i) => sum + getEc2Price(i.type), 0);
  const ec2StoppedEbsCost = ec2Stopped.length * 20;
  const rdsSorted = [...rdsInstances].sort((a, b) => getRdsPrice(b.type) - getRdsPrice(a.type));
  const cacheSorted = [...elasticache].sort((a, b) => getCachePrice(b.type) - getCachePrice(a.type));
  const rdsCost = rdsSorted.reduce((sum, r) => sum + getRdsPrice(r.type), 0);
  const cacheCost = cacheSorted.reduce((sum, c) => sum + getCachePrice(c.type), 0);
  const natCost = natGateways.length * 32;
  const lbCost = loadBalancers.length * 16;
  const eipFreeCost = eipsUnassociated.length * 3.6;
  const totalEstimatedMonthlyCost = ec2RunningCost + rdsCost + cacheCost + natCost + lbCost;
  const totalTerraformManaged = inventory.byService.reduce((sum, service) =>
    sum + service.details.filter((detail) => detail.terraform).length, 0);
  const terraformCoverage = inventory.totalResources > 0
    ? (totalTerraformManaged / inventory.totalResources) * 100
    : 0;
  const rdsMultiAzCount = rdsInstances.filter((detail) => getMetaBoolean(detail, 'multiAz') === true).length;
  const rdsPiEnabledCount = rdsInstances.filter((detail) => getMetaBoolean(detail, 'performanceInsightsEnabled') === true).length;
  const rdsEnhancedMonitoringCount = rdsInstances.filter((detail) => {
    const interval = getMetaNumber(detail, 'monitoringIntervalSeconds');
    return interval !== null && interval > 0;
  }).length;
  const rdsByName = new Map(rdsInstances.map((detail) => [detail.name, detail]));
  const rdsPiLoadCoverageCount = metrics.filter((metric) => metric.service === 'RDS' && metric.metrics.piDbLoadAvg !== null).length;

  // EBS storage analysis
  let totalEbsGb = 0;
  let totalEbsAvailableGb = 0;
  const ebsByType: Record<string, { count: number; totalGb: number }> = {};
  for (const v of ebsVolumes) {
    const match = v.type.match(/(\w+)\s*\/\s*(\d+)\s*GiB/);
    const volType = match ? match[1] : 'unknown';
    const gb = match ? parseInt(match[2]) : 50;
    totalEbsGb += gb;
    if (v.state === 'available') totalEbsAvailableGb += gb;
    if (!ebsByType[volType]) ebsByType[volType] = { count: 0, totalGb: 0 };
    ebsByType[volType].count++;
    ebsByType[volType].totalGb += gb;
  }
  const ebsEstimatedCost = totalEbsGb * 0.10; // gp2/gp3 ~$0.10/GB/month
  const ebsWasteCost = totalEbsAvailableGb * 0.10;

  // Potential savings tracker
  let potentialSavings = 0;
  const savingsItems: { category: string; amount: number; details: string; priority: 'alta' | 'media' | 'baja' }[] = [];

  // --- Savings: Stopped EC2 ---
  if (ec2Stopped.length > 0) {
    potentialSavings += ec2StoppedEbsCost;
    savingsItems.push({ category: 'EC2 paradas (EBS)', amount: ec2StoppedEbsCost, details: `${ec2Stopped.length} instancias`, priority: 'alta' });
  }

  // --- Savings: Unattached EBS ---
  if (ebsAvailable.length > 0) {
    potentialSavings += ebsWasteCost;
    savingsItems.push({ category: 'EBS sin adjuntar', amount: ebsWasteCost, details: `${ebsAvailable.length} volúmenes (${totalEbsAvailableGb} GB)`, priority: 'alta' });
  }

  // --- Savings: Unassociated EIPs ---
  if (eipsUnassociated.length > 0) {
    potentialSavings += eipFreeCost;
    savingsItems.push({ category: 'Elastic IPs libres', amount: eipFreeCost, details: `${eipsUnassociated.length} IPs`, priority: 'media' });
  }

  // --- Build the data prompt ---
  let prompt = `# DATOS DE INFRAESTRUCTURA AWS PARA ANÁLISIS FINOPS

**Fecha del análisis:** ${new Date().toISOString().split('T')[0]}
**Cuentas analizadas:** ${inventory.accounts.length}
**Total recursos inventariados:** ${inventory.totalResources}
**Coste mensual estimado (on-demand):** ~$${Math.round(totalEstimatedMonthlyCost)}/mes (solo compute + DB + red, sin storage ni data transfer)
**Madurez IaC (Terraform):** ${terraformCoverage.toFixed(1)}% (${totalTerraformManaged}/${inventory.totalResources} recursos)
${insights ? `**Solidez del análisis:** ${insights.summary.qualityLevel.toUpperCase()} (${insights.summary.qualityScore}%)` : ''}

${insights ? `## COBERTURA Y CALIDAD DEL DATASET

- Cobertura de cuentas: ${insights.coverage.accountCoveragePct}%
- Recursos con coste estimado: ${insights.coverage.estimatedCostCoveragePct}%
- Coste real enlazado a recurso: ${insights.coverage.actualResourceSpendCoveragePct === null ? 'No disponible' : `${insights.coverage.actualResourceSpendCoveragePct}% del spend visible`} (${insights.summary.matchedResourceCosts}/${insights.summary.totalResources} recursos)
- Visibilidad de tags / Terraform: ${insights.coverage.tagVisibilityPct}%
- Recursos etiquetados: ${insights.coverage.taggedResourcesPct}%
- Terraform gestionado detectado: ${insights.coverage.terraformManagedPct}%
- Cobertura de métricas sobre muestra objetivo: ${insights.coverage.metricsSampleCoveragePct === null ? 'No solicitada' : `${insights.coverage.metricsSampleCoveragePct}%`}
- Cobertura de métricas sobre recursos elegibles: ${insights.coverage.metricsEligibleCoveragePct === null ? 'No solicitada' : `${insights.coverage.metricsEligibleCoveragePct}%`}
- Coste real CUR disponible: ${insights.coverage.actualCostAvailable ? 'Sí' : 'No'}
${insights.summary.actualWindowCost !== null ? `- Coste real ventana: $${insights.summary.actualWindowCost.toFixed(2)}` : ''}
${insights.summary.estimatedWindowCost !== null ? `- Coste estimado equivalente para la ventana: ~$${insights.summary.estimatedWindowCost.toFixed(2)}` : ''}
${insights.summary.actualVsEstimatedDelta !== null ? `- Delta real vs estimado equivalente: $${insights.summary.actualVsEstimatedDelta.toFixed(2)}` : ''}
${insights.topUnmatchedServices.length > 0 ? `
- Servicios con más spend sin match: ${insights.topUnmatchedServices.map((item) => `${item.service} ($${item.unmatchedCost.toFixed(2)} sin match, cobertura ${item.coveragePct.toFixed(1)}%)`).join('; ')}
` : ''}

## HALLAZGOS DETERMINISTAS PREVIOS AL MODELO

**Ahorro potencial detectado automáticamente:** ~$${Math.round(insights.summary.totalOpportunitySavingsMonthly)}/mes

| Categoría | Recurso | Cuenta | Acción | Ahorro est. ($/mes) | Confianza | Evidencia |
|-----------|---------|--------|--------|---------------------|-----------|-----------|
${insights.topOpportunities.map((item) => `| ${item.category} | ${(item.resourceName && item.resourceName !== '-' ? item.resourceName : item.resourceId)} (${item.resourceId}) | ${item.accountName} | ${item.action} | $${item.estimatedMonthlySavings.toFixed(2)} | ${item.confidence} | ${item.evidence} |`).join('\n') || '| Sin oportunidades deterministas | - | - | - | $0.00 | - | - |'}

${insights.gaps.length > 0 ? `## LIMITACIONES Y GAPS DETECTADOS

${insights.gaps.map((gap) => `- **${gap.title}:** ${gap.description} Impacto: ${gap.impact} Recomendado: ${gap.recommendedActions.join(', ')}.`).join('\n')}

` : ''}` : ''}

## DISTRIBUCIÓN POR CUENTA

| Cuenta | ID | Recursos |
|--------|-----|----------|
${inventory.accounts.map(a => `| ${a.accountName} | ${a.accountId} | ${a.totalResources} |`).join('\n')}

---

## 1. COMPUTE — EC2 INSTANCES (${ec2Instances.length} total)

### Running (${ec2Running.length}) — Coste estimado: ~$${Math.round(ec2RunningCost)}/mes

| Cuenta | Región | Nombre | ID | Tipo | Coste est. ($/mes) | Terraform |
|--------|--------|--------|-----|------|---------------------|-----------|
${ec2Running.slice(0, 30).map(i => `| ${getAccountLabel(i)} | ${getRegionLabel(i)} | ${i.name} | ${i.id} | ${i.type} | $${getEc2Price(i.type)} | ${i.terraform ? '✅' : '❌'} |`).join('\n')}
${ec2Running.length > 30 ? `\n*... y ${ec2Running.length - 30} más*` : ''}

### Stopped (${ec2Stopped.length}) — EBS sigue costando ~$${Math.round(ec2StoppedEbsCost)}/mes

| Cuenta | Región | Nombre | ID | Tipo | Terraform |
|--------|--------|--------|-----|------|-----------|
${ec2Stopped.map(i => `| ${getAccountLabel(i)} | ${getRegionLabel(i)} | ${i.name} | ${i.id} | ${i.type} | ${i.terraform ? '✅' : '❌'} |`).join('\n') || '*Ninguna*'}

---

## 2. STORAGE — EBS VOLUMES (${ebsVolumes.length} total, ${totalEbsGb} GB)

**Coste estimado total EBS:** ~$${Math.round(ebsEstimatedCost)}/mes
**Volúmenes sin adjuntar:** ${ebsAvailable.length} (${totalEbsAvailableGb} GB) — **desperdicio: ~$${Math.round(ebsWasteCost)}/mes**

### Distribución por tipo de volumen

| Tipo | Cantidad | GB Total | Coste est. ($/mes) |
|------|----------|----------|---------------------|
${Object.entries(ebsByType).map(([t, d]) => `| ${t} | ${d.count} | ${d.totalGb} | $${Math.round(d.totalGb * (t === 'io1' || t === 'io2' ? 0.125 : 0.10))} |`).join('\n')}

### Volúmenes sin adjuntar (ELIMINAR)

| Cuenta | Región | Nombre | ID | Tipo/Tamaño | Terraform |
|--------|--------|--------|-----|-------------|-----------|
${ebsAvailable.slice(0, 20).map(v => `| ${getAccountLabel(v)} | ${getRegionLabel(v)} | ${v.name} | ${v.id} | ${v.type} | ${v.terraform ? '✅' : '❌'} |`).join('\n') || '*Ninguno*'}
${ebsAvailable.length > 20 ? `\n*... y ${ebsAvailable.length - 20} más*` : ''}

---

## 3. RED

### Elastic IPs (${elasticIps.length} total)
**No asociadas (${eipsUnassociated.length})** — $3.6/mes cada una = **$${Math.round(eipFreeCost)}/mes desperdiciados**

${eipsUnassociated.length > 0 ? eipsUnassociated.map(e => `- 🗑️ ${e.name} (${e.id})`).join('\n') : '*Todas asociadas ✅*'}

### NAT Gateways (${natGateways.length}) — ~$${natCost}/mes (base, sin data transfer)

${natGateways.map(n => `- ${n.name} (${n.id})`).join('\n') || '*Ninguno*'}

### Load Balancers (${loadBalancers.length}) — ~$${lbCost}/mes (base)

| Nombre | Tipo | Estado |
|--------|------|--------|
${loadBalancers.slice(0, 15).map(lb => `| ${lb.name} | ${lb.type} | ${lb.state} |`).join('\n') || '*Ninguno*'}

### Target Groups: ${targetGroups.length}

---

## 4. BASES DE DATOS

### RDS Instances (${rdsInstances.length}) — Coste estimado: ~$${Math.round(rdsCost)}/mes

- **Cobertura Multi-AZ:** ${rdsMultiAzCount}/${rdsInstances.length}
- **Performance Insights habilitado:** ${rdsPiEnabledCount}/${rdsInstances.length}
- **Performance Insights con datos recuperados:** ${rdsPiLoadCoverageCount}/${rdsInstances.length}
- **Enhanced Monitoring habilitado:** ${rdsEnhancedMonitoringCount}/${rdsInstances.length}

| Cuenta | Región | Nombre | Clase | Engine/Versión | Multi-AZ | Storage | PI | Estado | Coste est. ($/mes) | Terraform |
|--------|--------|--------|-------|----------------|----------|---------|----|--------|---------------------|-----------|
${rdsSorted.map(r => `| ${getAccountLabel(r)} | ${getRegionLabel(r)} | ${r.name} | ${getRdsClass(r)} | ${getRdsEngine(r)} | ${formatFlag(getMetaBoolean(r, 'multiAz'))} | ${getRdsStorageLabel(r)} | ${formatFlag(getMetaBoolean(r, 'performanceInsightsEnabled'))} | ${r.state} | $${getRdsPrice(r.type)} | ${r.terraform ? '✅' : '❌'} |`).join('\n') || '*Ninguna*'}

### RDS Clusters (${rdsClusters.length})

| Cuenta | Región | Nombre | Engine/Versión | Modo | Serverless v2 | Cifrado | Estado |
|--------|--------|--------|----------------|------|---------------|---------|--------|
${rdsClusters.map(c => `| ${getAccountLabel(c)} | ${getRegionLabel(c)} | ${c.name} | ${getRdsEngine(c)} | ${getMetaString(c, 'engineMode') || '-'} | ${getRdsClusterCapacity(c)} | ${formatFlag(getMetaBoolean(c, 'storageEncrypted'))} | ${c.state} |`).join('\n') || '*Ninguno*'}

### ElastiCache (${elasticache.length}) — Coste estimado: ~$${Math.round(cacheCost)}/mes

| Nombre | Tipo/Engine | Estado | Coste est. ($/mes) |
|--------|-------------|--------|---------------------|
${cacheSorted.map(c => `| ${c.name} | ${c.type} | ${c.state} | $${getCachePrice(c.type)} |`).join('\n') || '*Ninguno*'}

---

## 5. OTROS SERVICIOS

- **S3 Buckets:** ${s3Buckets.length} (revisar lifecycle policies y storage classes)
- **Lambda Functions:** ${lambdaFunctions.length}
- **Security Groups:** ${securityGroups.length}
- **Network Interfaces:** ${networkInterfaces.length}
`;

  // --- Add CloudWatch metrics section ---
  if (metrics.length > 0) {
    prompt += `\n---\n\n## 6. MÉTRICAS DE USO — CloudWatch (últimos 14 días)\n\n`;
    prompt += `**Total métricas recopiladas:** ${metrics.length}\n\n`;

    const ec2Metrics = metrics.filter(m => m.service === 'EC2');
    const rdsMetrics = metrics.filter(m => m.service === 'RDS');
    const cacheMetrics = metrics.filter(m => m.service === 'ElastiCache');
    const elbMetrics = metrics.filter(m => m.service === 'ELB');

    if (ec2Metrics.length > 0) {
      const ec2Idle = ec2Metrics.filter(m =>
        m.metrics.cpuAvg !== null &&
        m.metrics.cpuAvg < 5 &&
        (m.metrics.cpuP95 === null || m.metrics.cpuP95 < 10) &&
        (m.metrics.cpuMax === null || m.metrics.cpuMax < 20));
      const ec2Low = ec2Metrics.filter(m =>
        m.metrics.cpuAvg !== null &&
        m.metrics.cpuAvg >= 5 &&
        m.metrics.cpuAvg < 25 &&
        (m.metrics.cpuP95 === null || m.metrics.cpuP95 < 40));
      const ec2Normal = ec2Metrics.filter(m => m.metrics.cpuAvg !== null && m.metrics.cpuAvg >= 25 && m.metrics.cpuAvg < 70);
      const ec2High = ec2Metrics.filter(m => m.metrics.cpuAvg !== null && m.metrics.cpuAvg >= 70);

      prompt += `### EC2 — Utilización de CPU\n\n`;
      prompt += `| Categoría | Cantidad | Acción |\n|-----------|----------|--------|\n`;
      prompt += `| 🔴 Idle (CPU avg < 5%, P95 < 10%) | ${ec2Idle.length} | Eliminar o apagar |\n`;
      prompt += `| 🟡 Baja (CPU avg 5-25%) | ${ec2Low.length} | Rightsizing |\n`;
      prompt += `| 🟢 Normal (CPU 25-70%) | ${ec2Normal.length} | OK |\n`;
      prompt += `| 🔵 Alta (CPU > 70%) | ${ec2High.length} | Monitorizar |\n\n`;

      if (ec2Idle.length > 0) {
        prompt += `#### 🔴 EC2 IDLE — Candidatas a ELIMINAR\n\n`;
        prompt += `| Nombre | ID | CPU Avg | CPU P95 | CPU Max | Coste est. |\n|--------|-----|---------|---------|---------|------------|\n`;
        for (const m of ec2Idle) {
          const inst = ec2Running.find(i => i.id === m.resourceId);
          const price = inst ? getEc2Price(inst.type) : 50;
          prompt += `| ${m.resourceName} | ${m.resourceId} | ${m.metrics.cpuAvg}% | ${m.metrics.cpuP95 ?? '-'}% | ${m.metrics.cpuMax}% | $${price}/mes |\n`;
          potentialSavings += price * 0.9;
          savingsItems.push({ category: 'EC2 idle', amount: Math.round(price * 0.9), details: m.resourceName, priority: 'alta' });
        }
        prompt += '\n';
      }

      if (ec2Low.length > 0) {
        prompt += `#### 🟡 EC2 BAJA UTILIZACIÓN — Candidatas a RIGHTSIZING\n\n`;
        prompt += `| Nombre | Tipo Actual | CPU Avg | CPU P95 | CPU Max | Tipo Sugerido | Ahorro est. |\n|--------|-------------|---------|---------|---------|---------------|-------------|\n`;
        for (const m of ec2Low) {
          const inst = ec2Running.find(i => i.id === m.resourceId);
          if (inst) {
            const ds = suggestDownsize(inst.type, m.metrics.cpuAvg || 20);
            if (ds) {
              prompt += `| ${m.resourceName} | ${inst.type} | ${m.metrics.cpuAvg}% | ${m.metrics.cpuP95 ?? '-'}% | ${m.metrics.cpuMax}% | ${ds.suggested} | $${ds.savings}/mes |\n`;
              potentialSavings += ds.savings;
              savingsItems.push({ category: 'EC2 rightsizing', amount: ds.savings, details: m.resourceName, priority: 'media' });
            } else {
              prompt += `| ${m.resourceName} | ${inst.type} | ${m.metrics.cpuAvg}% | ${m.metrics.cpuP95 ?? '-'}% | ${m.metrics.cpuMax}% | Revisar | - |\n`;
            }
          }
        }
        prompt += '\n';
      }

      if (ec2High.length > 0) {
        prompt += `#### 🔵 EC2 ALTA UTILIZACIÓN — Posible upsizing necesario\n\n`;
        prompt += `| Nombre | Tipo | CPU Avg | CPU P95 | CPU Max |\n|--------|------|---------|---------|--------|\n`;
        for (const m of ec2High) {
          const inst = ec2Running.find(i => i.id === m.resourceId);
          prompt += `| ${m.resourceName} | ${inst?.type || '-'} | ${m.metrics.cpuAvg}% | ${m.metrics.cpuP95 ?? '-'}% | ${m.metrics.cpuMax}% |\n`;
        }
        prompt += '\n';
      }
    }

    if (rdsInstances.length > 0) {
      if (rdsMetrics.length > 0) {
        prompt += `### RDS — Utilización y señales de rendimiento\n\n`;
        prompt += `- Performance Insights habilitado: ${rdsPiEnabledCount}/${rdsInstances.length}\n`;
        prompt += `- Performance Insights con datos recuperados: ${rdsPiLoadCoverageCount}/${rdsInstances.length}\n\n`;
        prompt += `| Cuenta | Región | Nombre | CPU Avg | CPU P95 | DB Load | Conn Avg | Mem. libre avg (MB) | Storage libre avg (GB) | Read IOPS | Write IOPS | Read lat. (ms) | Write lat. (ms) | Queue | Top waits PI | Coste est. |\n|--------|--------|--------|---------|---------|---------|----------|----------------------|-------------------------|-----------|------------|----------------|-----------------|-------|--------------|------------|\n`;
        for (const m of rdsMetrics) {
          const rds = rdsByName.get(m.resourceName);
          const price = rds ? getRdsPrice(rds.type) : 100;
          const topWaits = m.insights?.topWaitEvents?.join(', ') || '-';
          prompt += `| ${rds ? getAccountLabel(rds) : '-'} | ${rds ? getRegionLabel(rds) : '-'} | ${m.resourceName} | ${formatMetric(m.metrics.cpuAvg, '%')} | ${formatMetric(m.metrics.cpuP95, '%')} | ${formatMetric(m.metrics.piDbLoadAvg)} | ${formatMetric(m.metrics.connectionsAvg)} | ${formatMetric(m.metrics.freeMemoryMB)} | ${formatMetric(m.metrics.freeStorageGB)} | ${formatMetric(m.metrics.readIopsAvg)} | ${formatMetric(m.metrics.writeIopsAvg)} | ${formatMetric(m.metrics.readLatencyMs)} | ${formatMetric(m.metrics.writeLatencyMs)} | ${formatMetric(m.metrics.diskQueueDepthAvg)} | ${topWaits} | $${price}/mes |\n`;
          if (
            m.metrics.cpuAvg !== null &&
            m.metrics.cpuAvg < 10 &&
            (m.metrics.piDbLoadAvg === null || m.metrics.piDbLoadAvg < 1) &&
            (m.metrics.cpuP95 === null || m.metrics.cpuP95 < 20) &&
            (m.metrics.connectionsAvg === null || m.metrics.connectionsAvg < 20) &&
            (m.metrics.readIopsAvg === null || m.metrics.readIopsAvg < 50) &&
            (m.metrics.writeIopsAvg === null || m.metrics.writeIopsAvg < 50)
          ) {
            potentialSavings += price * 0.5;
            savingsItems.push({ category: 'RDS infrautilizada', amount: Math.round(price * 0.5), details: m.resourceName, priority: 'media' });
          }
        }
        prompt += '\n';
      } else {
        prompt += `### RDS — Cobertura de observabilidad\n\n`;
        prompt += `- No se recuperaron métricas CloudWatch para RDS en este análisis.\n`;
        prompt += `- Instancias RDS inventariadas: ${rdsInstances.length}\n`;
        prompt += `- Performance Insights habilitado: ${rdsPiEnabledCount}/${rdsInstances.length}\n`;
        prompt += `- Performance Insights con datos recuperados: ${rdsPiLoadCoverageCount}/${rdsInstances.length}\n`;
        prompt += `- Enhanced Monitoring habilitado: ${rdsEnhancedMonitoringCount}/${rdsInstances.length}\n\n`;
      }
    }

    if (cacheMetrics.length > 0) {
      prompt += `### ElastiCache — Utilización\n\n`;
      prompt += `| Nombre | CPU Avg | CPU P95 | Memoria Avg % | Memoria P95 % |\n|--------|---------|---------|---------------|---------------|\n`;
      for (const m of cacheMetrics) {
        prompt += `| ${m.resourceName} | ${m.metrics.cpuAvg ?? '-'}% | ${m.metrics.cpuP95 ?? '-'}% | ${m.metrics.memoryPct ?? '-'}% | ${m.metrics.memoryP95 ?? '-'}% |\n`;
      }
      prompt += '\n';
    }

    if (elbMetrics.length > 0) {
      const elbIdle = elbMetrics.filter(m =>
        m.metrics.requestCountAvg !== null &&
        m.metrics.requestCountAvg < 100 &&
        (m.metrics.requestCountP95 === null || m.metrics.requestCountP95 < 200));
      if (elbIdle.length > 0) {
        prompt += `### Load Balancers SIN TRÁFICO\n\n`;
        prompt += `| Nombre | Requests Avg | Requests P95 | Conexiones Avg | Coste est. |\n|--------|-------------|--------------|----------------|------------|\n`;
        for (const m of elbIdle) {
          prompt += `| ${m.resourceName} | ${m.metrics.requestCountAvg} | ${m.metrics.requestCountP95 ?? '-'} | ${m.metrics.activeConnectionsAvg ?? '-'} | ~$16/mes |\n`;
          potentialSavings += 16;
          savingsItems.push({ category: 'ELB sin tráfico', amount: 16, details: m.resourceName, priority: 'media' });
        }
        prompt += '\n';
      }
    }
  }

  // --- Add CUR costs if available ---
  if (costs && costs.totalCost > 0) {
    prompt += `\n---\n\n## 7. COSTES REALES (CUR/Cost Explorer)\n\n`;
    prompt += `**Coste total del periodo:** $${costs.totalCost.toFixed(2)}\n`;
    prompt += `**Coste mensual estimado del inventario:** ~$${Math.round(totalEstimatedMonthlyCost)}\n`;
    if (insights?.summary.estimatedWindowCost !== null && insights?.summary.estimatedWindowCost !== undefined) {
      prompt += `**Coste estimado equivalente para la ventana:** ~$${insights.summary.estimatedWindowCost.toFixed(2)}\n`;
    }
    if (insights?.summary.actualVsEstimatedDelta !== null && insights?.summary.actualVsEstimatedDelta !== undefined) {
      prompt += `**Delta (real - estimado equivalente ventana):** $${insights.summary.actualVsEstimatedDelta.toFixed(2)}\n`;
    }
    prompt += `\n`;
    prompt += `### Por cuenta\n\n| Cuenta | Coste |\n|--------|-------|\n`;
    costs.byAccount.forEach(a => {
      prompt += `| ${a.accountName} | $${a.cost.toFixed(2)} |\n`;
    });
    prompt += `\n### Por servicio (top 15)\n\n| Servicio | Coste |\n|----------|-------|\n`;
    costs.byService.slice(0, 15).forEach(s => {
      prompt += `| ${s.service} | $${s.cost.toFixed(2)} |\n`;
    });
  }

  // --- Savings summary ---
  // Sort by amount descending
  savingsItems.sort((a, b) => b.amount - a.amount);

  prompt += `\n---\n\n## AHORRO IDENTIFICADO AUTOMÁTICAMENTE: ~$${Math.round(potentialSavings)}/mes\n\n`;
  prompt += `| Categoría | Ahorro est. ($/mes) | Detalle | Prioridad |\n|-----------|---------------------|---------|----------|\n`;
  for (const s of savingsItems) {
    prompt += `| ${s.category} | $${s.amount} | ${s.details} | ${s.priority} |\n`;
  }

  // ─── Executive CUR context (if available) ──────────────────────────────────
  const exec = costs?.executive;
  if (exec) {
    prompt += `\n---\n\n## ANÁLISIS FINANCIERO EJECUTIVO (datos reales del CUR)

### Desglose de costes reales
- **Equivalente On-Demand:** $${exec.netCost?.onDemandEquivalent?.toFixed(2) || '0'}
- **Coste bruto AWS (CUR):** $${exec.netCost?.grossCost?.toFixed(2) || '0'}
- **Net cost (post-partner):** $${exec.netCost?.netCost?.toFixed(2) || '0'}
- **Ahorro total vs On-Demand:** $${exec.netCost?.realSavings?.toFixed(2) || '0'} (${exec.netCost?.effectiveDiscountPct?.toFixed(1) || '0'}%)
- **Créditos aplicados:** $${exec.netCost?.creditsApplied?.toFixed(2) || '0'}
- **SPP Discount (reseller):** $${exec.netCost?.sppDiscount?.toFixed(2) || '0'}

### Modelo de pricing
- **On-Demand:** $${exec.pricingModel?.onDemandCost?.toFixed(2) || '0'} (${exec.pricingModel?.onDemandPct?.toFixed(1) || '0'}% del uso)
- **Savings Plans:** $${exec.pricingModel?.spCost?.toFixed(2) || '0'}
- **Reserved Instances:** $${exec.pricingModel?.riCost?.toFixed(2) || '0'}
- **Spot:** $${exec.pricingModel?.spotCost?.toFixed(2) || '0'}
- **Cobertura de compromisos (SP+RI):** ${exec.pricingModel?.commitmentCoverage?.toFixed(1) || '0'}%

### Savings Plans — utilización detallada
- **Ahorro por SP:** $${exec.savingsPlansDetail?.savingsAmount?.toFixed(2) || '0'} (${exec.savingsPlansDetail?.savingsPct?.toFixed(1) || '0'}% vs On-Demand)
${exec.savingsPlansDetail?.plans?.map((sp: any) => `  - ${sp.type} (${sp.paymentOption}): effective $${sp.effectiveCost?.toFixed(2)}, on-demand equiv $${sp.onDemandEquivalent?.toFixed(2)}, ${sp.accountsCovered} cuentas`).join('\n') || '  - Sin planes activos'}

### Anomalías de coste detectadas
- **Media diaria:** $${exec.anomalies?.mean?.toFixed(2) || '0'}
- **Umbral de anomalía (μ+2σ):** $${exec.anomalies?.threshold?.toFixed(2) || '0'}
${exec.anomalies?.flaggedDays?.length > 0 ? exec.anomalies.flaggedDays.map((a: any) => `  - ⚠️ ${a.day}: $${a.cost?.toFixed(2)} (${a.deviation?.toFixed(1)}σ por encima de la media)`).join('\n') : '  - Sin anomalías detectadas'}

### Top 10 recursos más caros (con tipo de instancia)
| Recurso | Servicio | Cuenta | Tipo instancia | Coste | On-Demand equiv. |
|---------|----------|--------|----------------|-------|------------------|
${exec.topResources?.slice(0, 10).map((r: any) => `| ${r.resourceId?.slice(-40) || '-'} | ${r.service || '-'} | ${r.accountName || '-'} | ${r.instanceType || '-'} | $${r.cost?.toFixed(2) || '0'} | $${r.onDemandCost?.toFixed(2) || '0'} |`).join('\n') || '| Sin datos | - | - | - | - | - |'}

`;
  }

  const langName = LOCALE_NAMES[locale] || LOCALE_NAMES.es;
  const langDirective = locale === "es"
    ? ""
    : `\n**IDIOMA: Genera TODO el informe en ${langName}. Títulos, descripciones, recomendaciones y texto libre en ${langName}. Nombres de servicios AWS, IDs y métricas se mantienen en inglés.**\n`;

  prompt += `\n---\n\n## INSTRUCCIONES FINALES
${langDirective}
Genera el informe FinOps completo siguiendo la estructura del system prompt.
${metrics.length === 0 ? '\n⚠️ No se recopilaron métricas CloudWatch. Basa el rightsizing en tipos de instancia y recomienda activar métricas.' : ''}
${metrics.length > 0 && rdsInstances.length > 0 ? '\nPara RDS, correlaciona coste con CPU, DB Load, IOPS, latencia y wait events antes de proponer rightsizing.' : ''}
- Si el dataset tiene gaps o permisos insuficientes, menciónalos explícitamente y ajusta el nivel de confianza de las recomendaciones.
- Diferencia con claridad lo que viene de métricas reales, lo que viene de inventario estático y lo que es una estimación económica.
- Usa SOLO los datos de arriba, no inventes recursos
- Sé específico con nombres e IDs
- Cifras en USD/mes
- Incluye cobertura Terraform (${terraformCoverage.toFixed(1)}%) como indicador de madurez IaC
- **NUEVO:** Incluye una sección de "Optimización de compromisos" con recomendaciones sobre Savings Plans basadas en la cobertura actual y el % On-Demand expuesto.
- **NUEVO:** Si hay anomalías de coste, analiza las causas probables y recomienda acciones.
- **NUEVO:** Para los top recursos, sugiere rightsizing basado en el tipo de instancia cuando sea aplicable.
`;

  return prompt;
}
