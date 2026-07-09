const SERVICE_ALIASES: Record<string, string> = {
  "Amazon Elastic Compute Cloud - Compute": "EC2 - Compute",
  "Amazon Elastic Compute Cloud": "EC2",
  AmazonEC2: "EC2",
  "Amazon Elastic Container Service for Kubernetes": "EKS",
  AmazonEKS: "EKS",
  "Amazon Simple Storage Service": "S3",
  AmazonS3: "S3",
  "Amazon Relational Database Service": "RDS",
  AmazonRDS: "RDS",
  "Amazon Virtual Private Cloud": "VPC",
  AmazonVPC: "VPC",
  "Amazon Elastic Load Balancing": "ELB",
  AmazonElastiCache: "ElastiCache",
  AmazonCloudWatch: "CloudWatch",
  AWSSecretsManager: "Secrets Manager",
  AWSDataTransfer: "Data Transfer",
  AmazonEFS: "EFS",
  awskms: "KMS",
  awswaf: "WAF",
  awssupportbusiness: "Support (Business)",
};

function humanizeAwsToken(token: string): string {
  const normalized = token
    .replace(/^Amazon/, "")
    .replace(/^AWS/, "AWS ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return token;
  }

  return normalized
    .replace(/^E c 2$/i, "EC2")
    .replace(/^S 3$/i, "S3")
    .replace(/^R d s$/i, "RDS")
    .replace(/^V p c$/i, "VPC")
    .replace(/^E l b$/i, "ELB")
    .replace(/^E k s$/i, "EKS");
}

export function formatAwsServiceName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "-";

  const alias = SERVICE_ALIASES[trimmed];
  if (alias) return alias;

  return trimmed
    .split("/")
    .map((part) => SERVICE_ALIASES[part.trim()] || humanizeAwsToken(part.trim()))
    .join(" / ");
}

export function truncateLabel(value: string, max = 24): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function splitInventoryServiceKey(serviceKey: string): { serviceFamily: string; resourceType: string } {
  const [serviceFamily, ...rest] = serviceKey.split(" - ");
  return {
    serviceFamily: serviceFamily || serviceKey,
    resourceType: rest.join(" - ") || "Resources",
  };
}

export function truncateMiddle(value: string, start = 24, end = 16): string {
  if (value.length <= start + end + 1) {
    return value;
  }

  return `${value.slice(0, start)}…${value.slice(-end)}`;
}
