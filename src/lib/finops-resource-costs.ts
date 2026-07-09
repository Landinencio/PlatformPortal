import type { ResourceDetail } from "@/types/inventory";

export interface CurResourceCost {
  accountId: string;
  service: string;
  resourceId: string;
  cost: number;
  lineItems?: number;
}

export interface MatchedResourceCost {
  accountId: string;
  resourceId: string;
  matchedBy: "id" | "arn-suffix" | "name" | "metadata" | "service-proportional";
  cost: number;
  lineItems?: number;
}

function normalizeId(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "-" ? normalized : null;
}

export function buildCurResourceCostKey(accountId: string | null | undefined, resourceId: string | null | undefined): string | null {
  const normalizedAccountId = normalizeId(accountId);
  const normalizedResourceId = normalizeId(resourceId);
  if (!normalizedAccountId || !normalizedResourceId) return null;
  return `${normalizedAccountId}::${normalizedResourceId}`;
}

function pushCandidate(target: Array<{ value: string; matchedBy: MatchedResourceCost["matchedBy"] }>, raw: string | null | undefined, matchedBy: MatchedResourceCost["matchedBy"]) {
  const normalized = normalizeId(raw);
  if (!normalized) return;
  if (!target.some((item) => item.value === normalized)) {
    target.push({ value: normalized, matchedBy });
  }
}

function extractArnSuffixes(value: string): string[] {
  const suffixes: string[] = [];
  const markerIndex = value.indexOf(":");
  if (markerIndex >= 0) {
    const afterArn = value.slice(markerIndex + 1);
    suffixes.push(afterArn);
  }

  const slashSegments = value.split("/").filter(Boolean);
  if (slashSegments.length > 0) {
    suffixes.push(slashSegments[slashSegments.length - 1]);
    if (slashSegments.length > 1) {
      suffixes.push(slashSegments.slice(-2).join("/"));
    }
  }

  const colonSegments = value.split(":").filter(Boolean);
  if (colonSegments.length > 0) {
    suffixes.push(colonSegments[colonSegments.length - 1]);
  }

  return suffixes;
}

export function getResourceCostCandidates(detail: ResourceDetail): Array<{ value: string; matchedBy: MatchedResourceCost["matchedBy"] }> {
  const candidates: Array<{ value: string; matchedBy: MatchedResourceCost["matchedBy"] }> = [];

  pushCandidate(candidates, detail.id, "id");
  pushCandidate(candidates, detail.name, "name");

  const normalizedId = normalizeId(detail.id);
  if (normalizedId && normalizedId.startsWith("arn:")) {
    for (const suffix of extractArnSuffixes(normalizedId)) {
      pushCandidate(candidates, suffix, "arn-suffix");
    }
  }

  const metadataKeys = [
    "dbClusterIdentifier",
    "dbiResourceId",
    "attachedInstanceId",
    "privateIpAddress",
    "publicIpAddress",
    "vpcId",
    "subnetId",
  ] as const;

  for (const key of metadataKeys) {
    const value = detail.metadata?.[key];
    if (typeof value === "string") {
      pushCandidate(candidates, value, "metadata");
    }
  }

  return candidates;
}

export function buildCurResourceCostIndex(resourceCosts: CurResourceCost[]) {
  const byAccountAndResource = new Map<string, CurResourceCost>();

  for (const row of resourceCosts) {
    const key = buildCurResourceCostKey(row.accountId, row.resourceId);
    if (!key) continue;
    const existing = byAccountAndResource.get(key);
    if (existing) {
      existing.cost += row.cost;
      existing.lineItems = (existing.lineItems || 0) + (row.lineItems || 0);
    } else {
      byAccountAndResource.set(key, {
        accountId: row.accountId,
        service: row.service,
        resourceId: row.resourceId,
        cost: row.cost,
        lineItems: row.lineItems,
      });
    }
  }

  return byAccountAndResource;
}

export function matchCurResourceCost(
  detail: ResourceDetail,
  accountId: string,
  index: Map<string, CurResourceCost>,
): MatchedResourceCost | null {
  const candidates = getResourceCostCandidates(detail);
  for (const candidate of candidates) {
    const key = buildCurResourceCostKey(accountId, candidate.value);
    if (!key) continue;
    const match = index.get(key);
    if (!match) continue;
    return {
      accountId: match.accountId,
      resourceId: match.resourceId,
      cost: Number(match.cost.toFixed(2)),
      lineItems: match.lineItems,
      matchedBy: candidate.matchedBy,
    };
  }

  return null;
}

/**
 * Build a service-level cost index for fallback matching.
 * Groups CUR costs by account+service when resource-level matching fails.
 */
export function buildServiceCostIndex(
  resourceCosts: CurResourceCost[],
  matchedKeys: Set<string>,
): Map<string, { service: string; totalCost: number; unmatchedCost: number; resourceCount: number }> {
  const index = new Map<string, { service: string; totalCost: number; unmatchedCost: number; resourceCount: number }>();

  for (const row of resourceCosts) {
    const serviceKey = `${normalizeId(row.accountId)}::${normalizeId(row.service)}`;
    if (!serviceKey) continue;

    const existing = index.get(serviceKey) || { service: row.service, totalCost: 0, unmatchedCost: 0, resourceCount: 0 };
    existing.totalCost += row.cost;
    existing.resourceCount++;

    const resourceKey = buildCurResourceCostKey(row.accountId, row.resourceId);
    if (!resourceKey || !matchedKeys.has(resourceKey)) {
      existing.unmatchedCost += row.cost;
    }

    index.set(serviceKey, existing);
  }

  return index;
}

