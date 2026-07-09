type CostResourceLike = {
  type: string;
  state: string;
  metadata?: Record<string, string | number | boolean | null | undefined>;
};

const EC2_PRICING: Record<string, number> = {
  "t3.nano": 3.8, "t3.micro": 7.6, "t3.small": 15.2, "t3.medium": 30.4, "t3.large": 60.7, "t3.xlarge": 121.5, "t3.2xlarge": 243,
  "t3a.nano": 3.4, "t3a.micro": 6.8, "t3a.small": 13.7, "t3a.medium": 27.4, "t3a.large": 54.7, "t3a.xlarge": 109.5,
  "t2.micro": 8.5, "t2.small": 16.9, "t2.medium": 33.9, "t2.large": 67.7, "t2.xlarge": 135.4,
  "m5.large": 70.1, "m5.xlarge": 140.2, "m5.2xlarge": 280.3, "m5.4xlarge": 560.6,
  "m6i.large": 70.1, "m6i.xlarge": 140.2, "m6i.2xlarge": 280.3,
  "r5.large": 91.3, "r5.xlarge": 182.5, "r5.2xlarge": 365,
  "c5.large": 62, "c5.xlarge": 124, "c5.2xlarge": 248,
};

const RDS_PRICING: Record<string, number> = {
  "db.t3.micro": 12.4, "db.t3.small": 24.8, "db.t3.medium": 49.6, "db.t3.large": 99.3,
  "db.t4g.micro": 11.8, "db.t4g.small": 23.7, "db.t4g.medium": 47.3,
  "db.m5.large": 125, "db.m5.xlarge": 250, "db.m5.2xlarge": 500,
  "db.r5.large": 166, "db.r5.xlarge": 332, "db.r5.2xlarge": 664,
};

const ELASTICACHE_PRICING: Record<string, number> = {
  "cache.t3.micro": 12, "cache.t3.small": 24, "cache.t3.medium": 48,
  "cache.m5.large": 112, "cache.r5.large": 148,
};

function parseStorageGiB(type: string): number | null {
  const match = type.match(/(\d+)\s*GiB/i);
  return match ? Number(match[1]) : null;
}

function normalizeClass(raw: string | null | undefined) {
  return raw ? raw.trim().toLowerCase() : "";
}

export function estimateResourceMonthlyCost(serviceFamily: string, resourceType: string, detail: CostResourceLike): number | null {
  const normalizedFamily = serviceFamily.toLowerCase();
  const normalizedType = resourceType.toLowerCase();
  const detailType = detail.type.trim();
  const metadataClass = typeof detail.metadata?.instanceClass === "string" ? detail.metadata.instanceClass : null;

  if (normalizedFamily === "ec2" && normalizedType === "instances") {
    return EC2_PRICING[normalizeClass(detailType)] ?? null;
  }

  if (normalizedFamily === "ec2" && normalizedType === "ebs volumes") {
    const size = parseStorageGiB(detailType);
    return size !== null ? Number((size * 0.1).toFixed(2)) : null;
  }

  if (normalizedFamily === "ec2" && normalizedType === "elastic ips") {
    return detail.state === "available" ? 3.6 : 0;
  }

  if (normalizedFamily === "rds" && normalizedType === "db instances") {
    const instanceClass = normalizeClass(metadataClass || detailType.split("/")[0]);
    return RDS_PRICING[instanceClass] ?? 100;
  }

  if (normalizedFamily === "rds" && normalizedType === "db clusters") {
    const min = typeof detail.metadata?.serverlessV2MinCapacity === "number" ? detail.metadata.serverlessV2MinCapacity : null;
    const max = typeof detail.metadata?.serverlessV2MaxCapacity === "number" ? detail.metadata.serverlessV2MaxCapacity : null;
    if (min !== null && max !== null) {
      return Number((((min + max) / 2) * 45).toFixed(2));
    }
    return 150;
  }

  if (normalizedFamily === "elasticache" && normalizedType === "clusters") {
    const cacheClass = normalizeClass(detailType.split("/")[0]);
    return ELASTICACHE_PRICING[cacheClass] ?? 50;
  }

  if (normalizedFamily === "vpc" && normalizedType === "nat gateways") {
    return 32;
  }

  if (normalizedFamily === "elb" && normalizedType === "load balancers") {
    return 16;
  }

  return null;
}
