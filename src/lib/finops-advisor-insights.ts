import type { ResourceMetrics } from "@/lib/aws-cloudwatch-metrics";
import {
  buildCurResourceCostKey,
  buildCurResourceCostIndex,
  buildServiceCostIndex,
  matchCurResourceCost,
  type CurResourceCost,
  type MatchedResourceCost,
} from "@/lib/finops-resource-costs";
import type { InventoryResponse, ResourceDetail } from "@/types/inventory";

export interface FinOpsAdvisorCosts {
  totalCost: number;
  byAccount: { accountId: string; accountName: string; cost: number }[];
  byService: { service: string; cost: number }[];
  resourceCosts?: CurResourceCost[];
}

export interface FinOpsAdvisorOpportunity {
  key: string;
  category: string;
  action: string;
  service: string;
  accountName: string;
  resourceName: string;
  resourceId: string;
  estimatedMonthlySavings: number;
  currentMonthlyCost?: number | null;
  currentWindowCost?: number | null;
  costBasis?: "actual" | "estimated";
  evidence: string;
  confidence: "high" | "medium" | "low";
  source: "inventory" | "metrics" | "costs";
}

export interface FinOpsAdvisorGap {
  key: string;
  type: "coverage" | "permissions" | "cost" | "metrics";
  title: string;
  description: string;
  impact: string;
  recommendedActions: string[];
}

export interface FinOpsAdvisorPermissionHint {
  key: string;
  service: string;
  reason: string;
  missingActions: string[];
}

export interface FinOpsAdvisorCollectionIssue {
  accountId: string;
  accountName: string;
  area: "metrics" | "costs" | "inventory";
  reason: string;
}

export interface FinOpsAdvisorCoverageSummary {
  accountCoveragePct: number;
  estimatedCostCoveragePct: number;
  modeledVsActualRunRatePct: number | null;
  actualResourceCostCoveragePct: number | null;
  actualResourceSpendCoveragePct: number | null;
  tagVisibilityPct: number;
  taggedResourcesPct: number;
  terraformManagedPct: number;
  terraformKnownPct: number;
  metricsSampleCoveragePct: number | null;
  metricsEligibleCoveragePct: number | null;
  actualCostAvailable: boolean;
}

export interface FinOpsAdvisorExecutiveSummary {
  qualityScore: number;
  qualityLevel: "high" | "medium" | "low";
  requestedAccounts: number;
  inventoryAccounts: number;
  totalResources: number;
  services: number;
  metricsCollected: number;
  metricsEligibleResources: number;
  metricsSampleTarget: number;
  estimatedMonthlyCost: number;
  actualMonthlyRunRate: number | null;
  estimatedWindowCost: number | null;
  actualWindowCost: number | null;
  resourceCostsAvailable: boolean;
  resourceCostRows: number;
  matchedResourceCosts: number;
  matchedResourceWindowCost: number | null;
  actualVsEstimatedDelta: number | null;
  totalOpportunitySavingsMonthly: number;
  opportunitiesCount: number;
  gapCount: number;
}

export interface FinOpsAdvisorUnmatchedService {
  service: string;
  totalCost: number;
  matchedCost: number;
  unmatchedCost: number;
  coveragePct: number;
  resourceRows: number;
  matchedRows: number;
  unmatchedRows: number;
}

export interface FinOpsAdvisorInsights {
  summary: FinOpsAdvisorExecutiveSummary;
  coverage: FinOpsAdvisorCoverageSummary;
  topOpportunities: FinOpsAdvisorOpportunity[];
  topUnmatchedServices: FinOpsAdvisorUnmatchedService[];
  gaps: FinOpsAdvisorGap[];
  permissionHints: FinOpsAdvisorPermissionHint[];
  collectionIssues: FinOpsAdvisorCollectionIssue[];
}

const METRICS_LIMITS: Record<string, number> = {
  "EC2 - Instances": 30,
  "RDS - DB Instances": 25,
  "ElastiCache - Clusters": 15,
  "ELB - Load Balancers": 15,
};

const TAG_PERMISSION_HINTS: Record<string, string[]> = {
  Lambda: ["lambda:ListTags"],
  S3: ["s3:GetBucketTagging"],
  ECS: ["ecs:DescribeClusters", "ecs:DescribeServices"],
  ELB: ["elasticloadbalancing:DescribeTags"],
  EKS: ["eks:DescribeCluster"],
  DynamoDB: ["dynamodb:DescribeTable", "dynamodb:ListTagsOfResource"],
  ElastiCache: ["elasticache:ListTagsForResource"],
  SNS: ["sns:ListTagsForResource"],
  SQS: ["sqs:ListQueueTags"],
  CloudFront: ["cloudfront:ListTagsForResource"],
};

const CLOUDWATCH_PERMISSION_HINTS = ["cloudwatch:GetMetricStatistics"];
const PERFORMANCE_INSIGHTS_HINTS = ["pi:GetResourceMetrics", "pi:DescribeDimensionKeys"];

const EC2_PRICING: Record<string, number> = {
  "t3.nano": 3.8, "t3.micro": 7.6, "t3.small": 15.2, "t3.medium": 30.4, "t3.large": 60.7, "t3.xlarge": 121.5, "t3.2xlarge": 243,
  "t3a.nano": 3.4, "t3a.micro": 6.8, "t3a.small": 13.7, "t3a.medium": 27.4, "t3a.large": 54.7, "t3a.xlarge": 109.5,
  "t2.micro": 8.5, "t2.small": 16.9, "t2.medium": 33.9, "t2.large": 67.7, "t2.xlarge": 135.4,
  "m5.large": 70.1, "m5.xlarge": 140.2, "m5.2xlarge": 280.3, "m5.4xlarge": 560.6,
  "m6i.large": 70.1, "m6i.xlarge": 140.2, "m6i.2xlarge": 280.3,
  "r5.large": 91.3, "r5.xlarge": 182.5, "r5.2xlarge": 365,
  "c5.large": 62, "c5.xlarge": 124, "c5.2xlarge": 248,
};

function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function toPct(part: number, total: number): number {
  if (total <= 0) return 0;
  return round((part / total) * 100, 1);
}

function getMetaNumber(detail: ResourceDetail, key: string): number | null {
  const value = detail.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getMetaBoolean(detail: ResourceDetail, key: string): boolean | null {
  const value = detail.metadata?.[key];
  return typeof value === "boolean" ? value : null;
}

function getMetaString(detail: ResourceDetail, key: string): string | null {
  const value = detail.metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getAccountLabel(detail: ResourceDetail): string {
  return getMetaString(detail, "accountName") || getMetaString(detail, "accountId") || "-";
}

function getEstimatedMonthlyCost(detail: ResourceDetail, fallback = 0): number {
  if (typeof detail.estimatedMonthlyCost === "number" && Number.isFinite(detail.estimatedMonthlyCost)) {
    return detail.estimatedMonthlyCost;
  }
  return fallback;
}

function parseWindowDays(startDate?: string, endDate?: string): number | null {
  if (!startDate || !endDate) return null;
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return null;
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
}

function estimateWindowCost(monthlyCost: number, windowDays: number | null): number | null {
  if (windowDays === null) return null;
  return round(monthlyCost * (windowDays / 30), 2);
}

function toMonthlyRunRate(windowCost: number | null, windowDays: number | null): number | null {
  if (windowCost === null || windowDays === null || windowDays <= 0) return null;
  return round(windowCost * (30 / windowDays), 2);
}

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `$${round(value, value >= 100 ? 0 : 2).toFixed(value >= 100 ? 0 : 2)}`;
}

function formatCoveragePct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${round(value, 1).toFixed(1)}%`;
}

function getEc2Price(type: string): number {
  return EC2_PRICING[type.toLowerCase()] || 50;
}

function suggestDownsize(type: string, cpuAvg: number): { suggested: string; savings: number } | null {
  const sizes = ["nano", "micro", "small", "medium", "large", "xlarge", "2xlarge", "4xlarge"];
  const parts = type.toLowerCase().split(".");
  if (parts.length < 2) return null;

  const family = parts[0];
  const currentSize = parts.slice(1).join(".");
  const currentIdx = sizes.findIndex((size) => currentSize.includes(size));
  if (currentIdx <= 0) return null;

  const stepsDown = cpuAvg < 10 ? 2 : 1;
  const newIdx = Math.max(0, currentIdx - stepsDown);
  if (newIdx === currentIdx) return null;

  const suggested = `${family}.${sizes[newIdx]}`;
  const currentPrice = EC2_PRICING[type.toLowerCase()] || 50;
  const suggestedPrice = EC2_PRICING[suggested] || currentPrice * 0.5;
  return { suggested, savings: Math.max(0, round(currentPrice - suggestedPrice, 0)) };
}

function buildMetricsLookup(metrics: ResourceMetrics[]) {
  const lookup = new Map<string, ResourceMetrics>();
  for (const metric of metrics) {
    lookup.set(metric.resourceId, metric);
  }
  return lookup;
}

function pushOpportunity(
  acc: FinOpsAdvisorOpportunity[],
  opportunity: FinOpsAdvisorOpportunity | null,
) {
  if (!opportunity || opportunity.estimatedMonthlySavings <= 0) return;
  acc.push({
    ...opportunity,
    estimatedMonthlySavings: round(opportunity.estimatedMonthlySavings, 2),
  });
}

export function buildFinOpsAdvisorInsights(params: {
  inventory: InventoryResponse;
  metrics: ResourceMetrics[];
  costs: FinOpsAdvisorCosts | null;
  requestedAccountIds: string[];
  includeMetrics: boolean;
  includeCosts: boolean;
  metricsDays: number;
  startDate?: string;
  endDate?: string;
  collectionIssues?: FinOpsAdvisorCollectionIssue[];
}): FinOpsAdvisorInsights {
  const {
    inventory,
    metrics,
    costs,
    requestedAccountIds,
    includeMetrics,
    includeCosts,
    metricsDays,
    startDate,
    endDate,
    collectionIssues = [],
  } = params;

  const allDetails = inventory.byService.flatMap((service) => service.details);
  const totalResources = inventory.totalResources;
  const estimatedMonthlyCost = round(
    inventory.byService.reduce((sum, service) => sum + (service.estimatedMonthlyCost || 0), 0),
    2,
  );

  const estimatedCostKnown = allDetails.filter((detail) => typeof detail.estimatedMonthlyCost === "number").length;
  const terraformKnown = allDetails.filter((detail) => detail.terraformStatus && detail.terraformStatus !== "unknown").length;
  const terraformManaged = allDetails.filter((detail) => detail.terraformStatus === "managed").length;
  const taggedResources = allDetails.filter((detail) => (getMetaNumber(detail, "tagCount") || 0) > 0).length;

  const metricsEligibleResources = inventory.accounts.reduce((sum, account) => {
    return sum + account.services.reduce((innerSum, service) => {
      if (!(service.name in METRICS_LIMITS)) return innerSum;
      const detailCount = service.name === "EC2 - Instances"
        ? service.details.filter((detail) => detail.state === "running").length
        : service.details.length;
      return innerSum + detailCount;
    }, 0);
  }, 0);

  const metricsSampleTarget = inventory.accounts.reduce((sum, account) => {
    return sum + account.services.reduce((innerSum, service) => {
      const limit = METRICS_LIMITS[service.name];
      if (!limit) return innerSum;
      const detailCount = service.name === "EC2 - Instances"
        ? service.details.filter((detail) => detail.state === "running").length
        : service.details.length;
      return innerSum + Math.min(detailCount, limit);
    }, 0);
  }, 0);

  const metricsLookup = buildMetricsLookup(metrics);
  const windowDays = parseWindowDays(startDate, endDate);
  const estimatedWindowCost = estimateWindowCost(estimatedMonthlyCost, windowDays);
  const actualWindowCost = costs?.totalCost ? round(costs.totalCost, 2) : null;
  const actualMonthlyRunRate = toMonthlyRunRate(actualWindowCost, windowDays);
  const actualVsEstimatedDelta = actualWindowCost !== null && estimatedWindowCost !== null
    ? round(actualWindowCost - estimatedWindowCost, 2)
    : null;
  const resourceCostIndex = costs?.resourceCosts?.length ? buildCurResourceCostIndex(costs.resourceCosts) : null;
  const resourceCostMatches = new Map<string, MatchedResourceCost>();

  for (const detail of allDetails) {
    if (!resourceCostIndex) break;
    const accountId = getMetaString(detail, "accountId");
    if (!accountId) continue;
    const match = matchCurResourceCost(detail, accountId, resourceCostIndex);
    if (!match) continue;
    resourceCostMatches.set(`${accountId}::${detail.id}`, match);
  }
  const matchedCurKeys = new Set<string>();
  for (const match of resourceCostMatches.values()) {
    const key = buildCurResourceCostKey(match.accountId, match.resourceId);
    if (key) matchedCurKeys.add(key);
  }

  // Service-level cost fallback: distribute unmatched CUR cost proportionally
  const serviceCostIndex = costs?.resourceCosts?.length
    ? buildServiceCostIndex(costs.resourceCosts, matchedCurKeys)
    : null;

  // Count resources per service+account for proportional distribution
  const resourceCountByServiceAccount = new Map<string, number>();
  for (const detail of allDetails) {
    const accountId = getMetaString(detail, "accountId");
    if (!accountId) continue;
    const serviceName = detail.metadata?.service || "";
    const key = `${accountId.toLowerCase()}::${serviceName.toLowerCase()}`;
    resourceCountByServiceAccount.set(key, (resourceCountByServiceAccount.get(key) || 0) + 1);
  }

  function getDetailMatch(detail: ResourceDetail) {
    const accountId = getMetaString(detail, "accountId");
    if (!accountId) return null;
    return resourceCostMatches.get(`${accountId}::${detail.id}`) || null;
  }

  function getServiceLevelCost(detail: ResourceDetail): number | null {
    if (!serviceCostIndex) return null;
    const accountId = getMetaString(detail, "accountId");
    const serviceName = detail.metadata?.service || "";
    if (!accountId || !serviceName) return null;

    const key = `${accountId.toLowerCase()}::${serviceName.toLowerCase()}`;
    const serviceData = serviceCostIndex.get(key);
    if (!serviceData || serviceData.unmatchedCost <= 0) return null;

    const resourceCount = resourceCountByServiceAccount.get(key) || 1;
    return round(serviceData.unmatchedCost / resourceCount, 2);
  }

  function getEffectiveCost(detail: ResourceDetail, fallback: number) {
    const match = getDetailMatch(detail);
    const actualWindow = match ? round(match.cost, 2) : null;
    const actualMonthly = toMonthlyRunRate(actualWindow, windowDays);
    if (actualMonthly !== null && actualMonthly > 0) {
      return {
        monthlyCost: actualMonthly,
        windowCost: actualWindow,
        matchedBy: match?.matchedBy || null,
        basis: "actual" as const,
      };
    }

    // Fallback: service-level proportional cost
    const serviceCost = getServiceLevelCost(detail);
    if (serviceCost !== null && serviceCost > 0) {
      const serviceMonthly = toMonthlyRunRate(serviceCost, windowDays);
      if (serviceMonthly !== null && serviceMonthly > 0) {
        return {
          monthlyCost: serviceMonthly,
          windowCost: serviceCost,
          matchedBy: "service-proportional" as const,
          basis: "actual" as const,
        };
      }
    }

    return {
      monthlyCost: getEstimatedMonthlyCost(detail, fallback),
      windowCost: null,
      matchedBy: null,
      basis: "estimated" as const,
    };
  }

  function appendCostEvidence(baseEvidence: string, detail: ResourceDetail, fallback: number) {
    const effective = getEffectiveCost(detail, fallback);
    if (effective.basis === "actual") {
      const suffix = effective.matchedBy ? `; match ${effective.matchedBy}` : "";
      return {
        evidence: `${baseEvidence} Coste real ventana ${formatUsd(effective.windowCost)} (run-rate ${formatUsd(effective.monthlyCost)}/mes${suffix}).`,
        ...effective,
      };
    }

    return {
      evidence: `${baseEvidence} Coste base estimado ${formatUsd(effective.monthlyCost)}/mes.`,
      ...effective,
    };
  }

  const matchedResourceWindowCostRaw = [...resourceCostMatches.values()].reduce((sum, match) => sum + match.cost, 0);
  const matchedResourceWindowCost = matchedResourceWindowCostRaw > 0 ? round(matchedResourceWindowCostRaw, 2) : null;
  const actualResourceCostCoveragePct = resourceCostMatches.size > 0
    ? toPct(resourceCostMatches.size, totalResources || 1)
    : (costs?.resourceCosts?.length ? 0 : null);
  const actualResourceSpendCoveragePct = actualWindowCost !== null && actualWindowCost > 0 && matchedResourceWindowCost !== null
    ? toPct(matchedResourceWindowCost, actualWindowCost)
    : null;
  const topUnmatchedServices: FinOpsAdvisorUnmatchedService[] = costs?.resourceCosts?.length
    ? Object.values(costs.resourceCosts.reduce<Record<string, FinOpsAdvisorUnmatchedService>>((acc, row) => {
        const service = row.service || "Unknown";
        const key = buildCurResourceCostKey(row.accountId, row.resourceId);
        const isMatched = key ? matchedCurKeys.has(key) : false;
        if (!acc[service]) {
          acc[service] = {
            service,
            totalCost: 0,
            matchedCost: 0,
            unmatchedCost: 0,
            coveragePct: 0,
            resourceRows: 0,
            matchedRows: 0,
            unmatchedRows: 0,
          };
        }
        const bucket = acc[service];
        bucket.totalCost += row.cost;
        bucket.resourceRows += 1;
        if (isMatched) {
          bucket.matchedCost += row.cost;
          bucket.matchedRows += 1;
        } else {
          bucket.unmatchedCost += row.cost;
          bucket.unmatchedRows += 1;
        }
        return acc;
      }, {}))
        .map((item) => ({
          ...item,
          totalCost: round(item.totalCost, 2),
          matchedCost: round(item.matchedCost, 2),
          unmatchedCost: round(item.unmatchedCost, 2),
          coveragePct: item.totalCost > 0 ? toPct(item.matchedCost, item.totalCost) : 0,
        }))
        .filter((item) => item.unmatchedCost > 0)
        .sort((a, b) => b.unmatchedCost - a.unmatchedCost)
        .slice(0, 6)
    : [];

  const opportunities: FinOpsAdvisorOpportunity[] = [];

  const ec2Instances = inventory.byService.find((service) => service.service === "EC2 - Instances")?.details || [];
  const ec2Running = ec2Instances.filter((detail) => detail.state === "running");
  const ec2Stopped = ec2Instances.filter((detail) => detail.state === "stopped");
  const ebsAvailable = inventory.byService.find((service) => service.service === "EC2 - EBS Volumes")?.details.filter((detail) => detail.state === "available") || [];
  const eipsAvailable = inventory.byService.find((service) => service.service === "EC2 - Elastic IPs")?.details.filter((detail) => detail.state === "available") || [];
  const rdsInstances = inventory.byService.find((service) => service.service === "RDS - DB Instances")?.details || [];
  const elbInstances = inventory.byService.find((service) => service.service === "ELB - Load Balancers")?.details || [];

  for (const detail of ec2Stopped) {
    pushOpportunity(opportunities, {
      key: `ec2-stopped-${detail.id}`,
      category: "Instancia parada",
      action: "Revisar y eliminar si ya no se usa",
      service: "EC2",
      accountName: getAccountLabel(detail),
      resourceName: detail.name,
      resourceId: detail.id,
      estimatedMonthlySavings: 20,
      evidence: "Instancia detenida; la computación no factura, pero suele mantener EBS asociado.",
      confidence: "medium",
      source: "inventory",
    });
  }

  for (const detail of ebsAvailable) {
    const effective = appendCostEvidence("EBS en estado available; no está adjunto a ninguna instancia.", detail, 5);
    pushOpportunity(opportunities, {
      key: `ebs-available-${detail.id}`,
      category: "Volumen sin adjuntar",
      action: "Eliminar o archivar snapshot",
      service: "EBS",
      accountName: getAccountLabel(detail),
      resourceName: detail.name,
      resourceId: detail.id,
      estimatedMonthlySavings: effective.monthlyCost,
      currentMonthlyCost: effective.monthlyCost,
      currentWindowCost: effective.windowCost,
      costBasis: effective.basis,
      evidence: effective.evidence,
      confidence: "high",
      source: "inventory",
    });
  }

  for (const detail of eipsAvailable) {
    const effective = appendCostEvidence("Elastic IP sin asociación activa.", detail, 3.6);
    pushOpportunity(opportunities, {
      key: `eip-available-${detail.id}`,
      category: "Elastic IP libre",
      action: "Liberar IP pública",
      service: "EC2",
      accountName: getAccountLabel(detail),
      resourceName: detail.name,
      resourceId: detail.id,
      estimatedMonthlySavings: effective.monthlyCost,
      currentMonthlyCost: effective.monthlyCost,
      currentWindowCost: effective.windowCost,
      costBasis: effective.basis,
      evidence: effective.evidence,
      confidence: "high",
      source: "inventory",
    });
  }

  for (const detail of ec2Running) {
    const metric = metricsLookup.get(detail.id);
    if (!metric) continue;
    const cpuAvg = metric.metrics.cpuAvg;
    const cpuP95 = metric.metrics.cpuP95;
    const cpuMax = metric.metrics.cpuMax;
    const effective = appendCostEvidence(
      `CPU avg ${cpuAvg}% / p95 ${cpuP95 ?? "-"}% / max ${cpuMax ?? "-" }%.`,
      detail,
      getEc2Price(detail.type),
    );
    const currentCost = effective.monthlyCost;

    if (cpuAvg !== null && cpuAvg < 5 && (cpuP95 === null || cpuP95 < 10) && (cpuMax === null || cpuMax < 20)) {
      pushOpportunity(opportunities, {
        key: `ec2-idle-${detail.id}`,
        category: "EC2 infrautilizada",
        action: "Apagar o retirar",
        service: "EC2",
        accountName: getAccountLabel(detail),
        resourceName: detail.name,
        resourceId: detail.id,
        estimatedMonthlySavings: currentCost * 0.9,
        currentMonthlyCost: currentCost,
        currentWindowCost: effective.windowCost,
        costBasis: effective.basis,
        evidence: effective.evidence,
        confidence: "high",
        source: "metrics",
      });
      continue;
    }

    if (cpuAvg !== null && cpuAvg >= 5 && cpuAvg < 25 && (cpuP95 === null || cpuP95 < 40)) {
      const downsized = suggestDownsize(detail.type, cpuAvg);
      if (!downsized) continue;
      const currentReferencePrice = getEc2Price(detail.type);
      const savingsRatio = currentReferencePrice > 0 ? Math.min(0.85, Math.max(0.05, downsized.savings / currentReferencePrice)) : 0.35;
      pushOpportunity(opportunities, {
        key: `ec2-rightsize-${detail.id}`,
        category: "Rightsizing EC2",
        action: `Bajar de ${detail.type} a ${downsized.suggested}`,
        service: "EC2",
        accountName: getAccountLabel(detail),
        resourceName: detail.name,
        resourceId: detail.id,
        estimatedMonthlySavings: effective.basis === "actual" ? currentCost * savingsRatio : downsized.savings,
        currentMonthlyCost: currentCost,
        currentWindowCost: effective.windowCost,
        costBasis: effective.basis,
        evidence: `${effective.evidence} Recomendación: ${downsized.suggested}.`,
        confidence: "medium",
        source: "metrics",
      });
    }
  }

  for (const detail of rdsInstances) {
    const metric = metricsLookup.get(detail.id);
    if (!metric) continue;
    const cpuAvg = metric.metrics.cpuAvg;
    const cpuP95 = metric.metrics.cpuP95;
    const dbLoad = metric.metrics.piDbLoadAvg;
    const connections = metric.metrics.connectionsAvg;
    const readIops = metric.metrics.readIopsAvg;
    const writeIops = metric.metrics.writeIopsAvg;
    const effective = appendCostEvidence(
      `CPU avg ${cpuAvg}% / DB Load ${dbLoad ?? "-"} / conexiones ${connections ?? "-"}.`,
      detail,
      100,
    );
    const currentCost = effective.monthlyCost;

    if (
      cpuAvg !== null &&
      cpuAvg < 10 &&
      (cpuP95 === null || cpuP95 < 20) &&
      (dbLoad === null || dbLoad < 1) &&
      (connections === null || connections < 20) &&
      (readIops === null || readIops < 50) &&
      (writeIops === null || writeIops < 50)
    ) {
      pushOpportunity(opportunities, {
        key: `rds-low-${detail.id}`,
        category: "RDS sobredimensionada",
        action: "Revisar rightsizing o downgrade de clase",
        service: "RDS",
        accountName: getAccountLabel(detail),
        resourceName: detail.name,
        resourceId: detail.id,
        estimatedMonthlySavings: currentCost * 0.5,
        currentMonthlyCost: currentCost,
        currentWindowCost: effective.windowCost,
        costBasis: effective.basis,
        evidence: effective.evidence,
        confidence: "medium",
        source: "metrics",
      });
    }
  }

  for (const detail of elbInstances) {
    const metric = metricsLookup.get(detail.id);
    if (!metric) continue;
    const requestsAvg = metric.metrics.requestCountAvg;
    const requestsP95 = metric.metrics.requestCountP95;
    if (requestsAvg !== null && requestsAvg < 100 && (requestsP95 === null || requestsP95 < 200)) {
      const effective = appendCostEvidence(`Request avg ${requestsAvg} / p95 ${requestsP95 ?? "-"}.`, detail, 16);
      pushOpportunity(opportunities, {
        key: `elb-idle-${detail.id}`,
        category: "Load balancer sin tráfico",
        action: "Eliminar o consolidar",
        service: "ELB",
        accountName: getAccountLabel(detail),
        resourceName: detail.name,
        resourceId: detail.id,
        estimatedMonthlySavings: effective.monthlyCost,
        currentMonthlyCost: effective.monthlyCost,
        currentWindowCost: effective.windowCost,
        costBasis: effective.basis,
        evidence: effective.evidence,
        confidence: "medium",
        source: "metrics",
      });
    }
  }

  opportunities.sort((a, b) => b.estimatedMonthlySavings - a.estimatedMonthlySavings);

  const unknownTagFamilies = new Map<string, number>();
  for (const service of inventory.byService) {
    const unknownCount = service.details.filter((detail) => detail.terraformStatus === "unknown").length;
    if (unknownCount > 0) {
      const key = service.serviceFamily || service.service;
      unknownTagFamilies.set(key, (unknownTagFamilies.get(key) || 0) + unknownCount);
    }
  }

  const permissionHints: FinOpsAdvisorPermissionHint[] = [];
  const smallTagServiceHints: string[] = [];
  for (const [service, unknownCount] of [...unknownTagFamilies.entries()].sort((a, b) => b[1] - a[1])) {
    const missingActions = TAG_PERMISSION_HINTS[service];
    if (!missingActions) continue;
    const affectedService = inventory.byService.filter((item) => (item.serviceFamily || item.service) === service);
    const estimatedAffectedCost = affectedService.reduce((sum, item) => sum + (item.estimatedMonthlyCost || 0), 0);
    if (unknownCount <= 2 && estimatedAffectedCost < 40) {
      smallTagServiceHints.push(`${service} (${unknownCount})`);
      continue;
    }
    permissionHints.push({
      key: `tags-${service}`,
      service,
      reason: `${unknownCount} recursos no exponen tags de forma fiable; la búsqueda por tags y Terraform queda degradada.`,
      missingActions,
    });
  }

  if (smallTagServiceHints.length > 0) {
    permissionHints.push({
      key: "tags-minor-services",
      service: "Tags parciales en servicios menores",
      reason: `Persisten gaps pequeños de tagging en ${smallTagServiceHints.join(", ")}.`,
      missingActions: ["tag:GetResources", "tag:GetTagKeys", "tag:GetTagValues"],
    });
  }

  const metricIssues = collectionIssues.filter((issue) => issue.area === "metrics");
  if (includeMetrics && metricIssues.length > 0) {
    permissionHints.push({
      key: "metrics-cloudwatch",
      service: "CloudWatch",
      reason: `Se detectaron ${metricIssues.length} cuentas con incidencias al recuperar métricas (${metricIssues.map((issue) => issue.accountName).join(", ")}).`,
      missingActions: CLOUDWATCH_PERMISSION_HINTS,
    });
  } else if (includeMetrics && metricsSampleTarget > 0 && metrics.length === 0) {
    permissionHints.push({
      key: "metrics-cloudwatch-no-data",
      service: "CloudWatch",
      reason: "Se pidió observabilidad, pero no se recuperó ninguna métrica. Puede ser un gap de permisos o ausencia real de datapoints.",
      missingActions: CLOUDWATCH_PERMISSION_HINTS,
    });
  }

  const rdsPiEnabled = rdsInstances.filter((detail) => getMetaBoolean(detail, "performanceInsightsEnabled") === true).length;
  const rdsPiWithData = metrics.filter((metric) => metric.service === "RDS" && metric.metrics.piDbLoadAvg !== null).length;
  if (includeMetrics && rdsPiEnabled > 0 && rdsPiWithData < rdsPiEnabled) {
    permissionHints.push({
      key: "metrics-performance-insights",
      service: "Performance Insights",
      reason: `Solo ${rdsPiWithData}/${rdsPiEnabled} instancias RDS con PI habilitado devolvieron carga real; puede faltar señal reciente o visibilidad PI.`,
      missingActions: PERFORMANCE_INSIGHTS_HINTS,
    });
  }

  if (unknownTagFamilies.size > 0) {
    permissionHints.push({
      key: "tagging-api",
      service: "Resource Groups Tagging API",
      reason: "Una API centralizada de tagging mejoraría búsqueda transversal por tags y detección IaC.",
      missingActions: ["tag:GetResources", "tag:GetTagKeys", "tag:GetTagValues"],
    });
  }

  const gaps: FinOpsAdvisorGap[] = [];

  if (inventory.accounts.length < requestedAccountIds.length) {
    gaps.push({
      key: "accounts-coverage",
      type: "coverage",
      title: "Cobertura parcial de cuentas",
      description: `El inventario ha cubierto ${inventory.accounts.length} de ${requestedAccountIds.length} cuentas solicitadas.`,
      impact: "El informe puede infravalorar gasto, recursos y oportunidades en cuentas no leídas.",
      recommendedActions: [
        "Validar trust policy y permisos de sts:AssumeRole sobre n8n-cost-reader-role.",
        "Revisar si hay cuentas nuevas sin el role desplegado.",
      ],
    });
  }

  if (includeCosts && costs?.resourceCosts?.length && (actualResourceSpendCoveragePct ?? 0) < 80) {
    gaps.push({
      key: "resource-cost-coverage",
      type: "cost",
      title: "Cobertura parcial de coste real por recurso",
      description: `Se enlazó CUR a ${resourceCostMatches.size}/${totalResources} recursos (${formatCoveragePct(actualResourceCostCoveragePct)}), cubriendo ${formatCoveragePct(actualResourceSpendCoveragePct)} del coste real visible en la ventana.${matchedResourceWindowCost !== null ? ` Coste real enlazado: ${formatUsd(matchedResourceWindowCost)}.` : ""}`,
      impact: "El priorizado ya es mucho más fiable en recursos con match CUR, pero aún puede infrarepresentar servicios cuyo CUR no expone un identificador enlazable.",
      recommendedActions: [
        topUnmatchedServices.length > 0
          ? `Priorizar matching en ${topUnmatchedServices.slice(0, 3).map((item) => item.service).join(", ")}.`
          : "Ampliar normalización ARN/ID y metadatos de matching para más familias AWS.",
        "Mantener heurísticas económicas como fallback donde line_item_resource_id no es reutilizable.",
      ],
    });
  } else if (estimatedCostKnown < totalResources * 0.6) {
    const modeledVsActualText = actualMonthlyRunRate !== null && actualMonthlyRunRate > 0
      ? ` El modelo actual explica aproximadamente ${toPct(estimatedMonthlyCost, actualMonthlyRunRate)}% del run-rate real extrapolado.`
      : "";
    gaps.push({
      key: "estimated-cost-coverage",
      type: "cost",
      title: "Cobertura limitada de coste por recurso",
      description: `Solo ${estimatedCostKnown}/${totalResources} recursos tienen coste estimado individual, pero ya concentran ~${round(estimatedMonthlyCost, 0)} USD/mes del perímetro modelado.${modeledVsActualText}`,
      impact: "El priorizado por ahorro es fuerte en compute/DB/red, pero más débil en servicios sin heurística económica.",
      recommendedActions: [
        "Extender heurísticas de coste estimado a más familias AWS.",
        "Planificar una unión futura entre CUR y recurso para obtener coste real por ARN/ID.",
      ],
    });
  }

  if (includeMetrics && metricsSampleTarget > 0 && metrics.length < Math.max(3, metricsSampleTarget * 0.5)) {
    const issueText = metricIssues.length > 0
      ? ` Además, ${metricIssues.length} cuentas devolvieron error al consultar métricas.`
      : "";
    gaps.push({
      key: "metrics-coverage",
      type: "metrics",
      title: "Cobertura de métricas por debajo de lo esperado",
      description: `Se recogieron ${metrics.length}/${metricsSampleTarget} muestras objetivo de CloudWatch.${issueText}`,
      impact: "Las recomendaciones de rightsizing pierden fiabilidad y pasan a depender más de inventario estático.",
      recommendedActions: [
        "Distinguir cuentas con error de las que simplemente no tienen datapoints recientes.",
        "Revisar límites de muestreo si el scope contiene muchas instancias.",
      ],
    });
  }

  if (includeCosts && !costs) {
    gaps.push({
      key: "cur-missing",
      type: "cost",
      title: "Sin coste real CUR en el informe",
      description: "No se pudo recuperar el dataset de costes reales desde Athena/Lambda para esta ejecución.",
      impact: "La IA trabaja con inventario y métricas, pero no puede contrastar gasto real frente a uso.",
      recommendedActions: [
        "Validar FINOPS_ATHENA_LAMBDA_URL y la salud de la lambda de Athena.",
        "Comprobar que el rango temporal seleccionado tiene datos CUR disponibles.",
      ],
    });
  }

  if (unknownTagFamilies.size > 0 && toPct(terraformKnown, totalResources || 1) < 95) {
    gaps.push({
      key: "tag-visibility",
      type: "coverage",
      title: "Visibilidad de tags mejorable",
      description: `La lectura fiable de tags/IaC cubre ${toPct(terraformKnown, totalResources || 1)}% del inventario visible.`,
      impact: "La búsqueda por tags, la detección Terraform y parte del ownership técnico pierden precisión.",
      recommendedActions: [
        "Mejorar la cobertura de tags en servicios con más peso operativo.",
        "Usar una vía centralizada de tagging para reducir huecos entre servicios.",
      ],
    });
  }

  const coverage: FinOpsAdvisorCoverageSummary = {
    accountCoveragePct: toPct(inventory.accounts.length, requestedAccountIds.length || inventory.accounts.length || 1),
    estimatedCostCoveragePct: toPct(estimatedCostKnown, totalResources || 1),
    modeledVsActualRunRatePct: actualMonthlyRunRate !== null && actualMonthlyRunRate > 0
      ? toPct(estimatedMonthlyCost, actualMonthlyRunRate)
      : null,
    actualResourceCostCoveragePct,
    actualResourceSpendCoveragePct,
    tagVisibilityPct: toPct(terraformKnown, totalResources || 1),
    taggedResourcesPct: toPct(taggedResources, totalResources || 1),
    terraformManagedPct: toPct(terraformManaged, totalResources || 1),
    terraformKnownPct: toPct(terraformKnown, totalResources || 1),
    metricsSampleCoveragePct: includeMetrics
      ? (metricsSampleTarget > 0 ? toPct(metrics.length, metricsSampleTarget) : 100)
      : null,
    metricsEligibleCoveragePct: includeMetrics
      ? (metricsEligibleResources > 0 ? toPct(metrics.length, metricsEligibleResources) : 100)
      : null,
    actualCostAvailable: Boolean(costs && costs.totalCost > 0),
  };

  const qualityComponents: Array<{ enabled: boolean; weight: number; value: number }> = [
    { enabled: true, weight: 30, value: coverage.accountCoveragePct },
    { enabled: true, weight: 20, value: coverage.actualResourceSpendCoveragePct ?? coverage.modeledVsActualRunRatePct ?? coverage.estimatedCostCoveragePct },
    { enabled: true, weight: 15, value: coverage.tagVisibilityPct },
    { enabled: true, weight: 10, value: coverage.taggedResourcesPct },
    { enabled: true, weight: 10, value: coverage.terraformKnownPct },
    {
      enabled: includeMetrics,
      weight: 15,
      value: coverage.metricsSampleCoveragePct ?? 0,
    },
    {
      enabled: includeCosts,
      weight: 20,
      value: coverage.actualCostAvailable ? 100 : 0,
    },
  ];

  const activeWeight = qualityComponents.reduce((sum, item) => sum + (item.enabled ? item.weight : 0), 0) || 1;
  const weightedScore = qualityComponents.reduce((sum, item) => {
    if (!item.enabled) return sum;
    return sum + item.value * item.weight;
  }, 0);
  const qualityScore = round(weightedScore / activeWeight, 1);
  const qualityLevel: "high" | "medium" | "low" = qualityScore >= 80 ? "high" : qualityScore >= 60 ? "medium" : "low";

  return {
    summary: {
      qualityScore,
      qualityLevel,
      requestedAccounts: requestedAccountIds.length,
      inventoryAccounts: inventory.accounts.length,
      totalResources,
      services: inventory.byService.length,
      metricsCollected: metrics.length,
      metricsEligibleResources,
      metricsSampleTarget,
      estimatedMonthlyCost,
      actualMonthlyRunRate,
      estimatedWindowCost,
      actualWindowCost,
      resourceCostsAvailable: Boolean(costs?.resourceCosts?.length),
      resourceCostRows: costs?.resourceCosts?.length || 0,
      matchedResourceCosts: resourceCostMatches.size,
      matchedResourceWindowCost,
      actualVsEstimatedDelta,
      totalOpportunitySavingsMonthly: round(opportunities.reduce((sum, item) => sum + item.estimatedMonthlySavings, 0), 2),
      opportunitiesCount: opportunities.length,
      gapCount: gaps.length,
    },
    coverage,
    topOpportunities: opportunities.slice(0, 8),
    topUnmatchedServices,
    gaps,
    permissionHints,
    collectionIssues,
  };
}
