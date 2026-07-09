/**
 * Validation for squad self-service infra resource configs.
 * Returns null if valid, or a descriptive error string.
 */

import type { SquadResourceType } from "./templates";

const AWS_PRINCIPAL_RE = /^[a-z0-9.\-]+\.amazonaws\.com$/;
// SQS/SNS resource name: alphanumeric, hyphen, underscore; 1-80 chars.
const QUEUE_NAME_RE = /^[a-zA-Z0-9_-]{1,80}$/;
// Secret path: dp/<segment>/<segment...>
const SECRET_PATH_RE = /^[a-zA-Z0-9/_.\-]{3,512}$/;
// DynamoDB table name: 3-255 chars, [a-zA-Z0-9_.-]
const DYNAMO_NAME_RE = /^[a-zA-Z0-9_.\-]{3,255}$/;
// TF var name: identifier
const TF_VAR_RE = /^[A-Z][A-Z0-9_]*$/;

const VALID_ENVS = ["dev", "uat", "pro"];

export function validateEnvironments(envs: unknown): string | null {
  if (!Array.isArray(envs) || envs.length === 0) {
    return "environments must be a non-empty array";
  }
  for (const e of envs) {
    if (typeof e !== "string" || !VALID_ENVS.includes(e)) {
      return `environments must be a subset of: ${VALID_ENVS.join(", ")}`;
    }
  }
  return null;
}

export function validateSqsConfig(cfg: any): string | null {
  if (!cfg || typeof cfg !== "object") return "config is required";
  if (typeof cfg.name !== "string" || !QUEUE_NAME_RE.test(cfg.name)) {
    return "SQS name must be 1-80 chars: letters, numbers, hyphens, underscores";
  }
  if (cfg.createDlq !== undefined && typeof cfg.createDlq !== "boolean") {
    return "createDlq must be a boolean";
  }
  if (cfg.maxReceiveCount !== undefined) {
    const n = Number(cfg.maxReceiveCount);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      return "maxReceiveCount must be an integer between 1 and 1000";
    }
  }
  if (!Array.isArray(cfg.principals) || cfg.principals.length === 0) {
    return "principals must be a non-empty array of AWS service principals";
  }
  for (const p of cfg.principals) {
    if (typeof p !== "string" || !AWS_PRINCIPAL_RE.test(p)) {
      return `Invalid principal "${p}". Must be an AWS service like sns.amazonaws.com`;
    }
  }
  if (cfg.delaySeconds !== undefined) {
    const n = Number(cfg.delaySeconds);
    if (!Number.isInteger(n) || n < 0 || n > 900) return "delaySeconds must be 0-900";
  }
  if (cfg.visibilityTimeoutSeconds !== undefined) {
    const n = Number(cfg.visibilityTimeoutSeconds);
    if (!Number.isInteger(n) || n < 0 || n > 43200) return "visibilityTimeoutSeconds must be 0-43200";
  }
  return null;
}

export function validateSecretConfig(cfg: any): string | null {
  if (!cfg || typeof cfg !== "object") return "config is required";
  if (typeof cfg.name !== "string" || !SECRET_PATH_RE.test(cfg.name)) {
    return "Secret name must be a path like dp/<domain>/<name>";
  }
  if (!cfg.name.startsWith("dp/")) {
    return 'Secret name must follow the convention dp/<domain>/<name> (start with "dp/")';
  }
  if (typeof cfg.description !== "string" || cfg.description.trim() === "") {
    return "Secret description is required";
  }
  if (!Array.isArray(cfg.keys) || cfg.keys.length === 0) {
    return "Secret must define at least one key";
  }
  const seen = new Set<string>();
  for (const k of cfg.keys) {
    if (!k || typeof k.jsonKey !== "string" || k.jsonKey.trim() === "") {
      return "Each secret key needs a non-empty jsonKey";
    }
    if (typeof k.tfVar !== "string" || !TF_VAR_RE.test(k.tfVar)) {
      return `tfVar "${k.tfVar}" must be UPPER_SNAKE_CASE (it becomes TF_VAR_<name>)`;
    }
    if (seen.has(k.tfVar)) return `Duplicate tfVar "${k.tfVar}"`;
    seen.add(k.tfVar);
  }
  return null;
}

export function validateDynamoConfig(cfg: any): string | null {
  if (!cfg || typeof cfg !== "object") return "config is required";
  if (typeof cfg.name !== "string" || !DYNAMO_NAME_RE.test(cfg.name)) {
    return "DynamoDB table name must be 3-255 chars: letters, numbers, dot, hyphen, underscore";
  }
  if (typeof cfg.hashKey !== "string" || cfg.hashKey.trim() === "") {
    return "hashKey (partition key) is required";
  }
  if (!Array.isArray(cfg.attributes) || cfg.attributes.length === 0) {
    return "attributes must define at least the hash key";
  }
  const attrNames = new Set<string>();
  for (const a of cfg.attributes) {
    if (!a || typeof a.name !== "string" || !["S", "N", "B"].includes(a.type)) {
      return "Each attribute needs a name and type S, N or B";
    }
    attrNames.add(a.name);
  }
  // Key attributes must be declared.
  if (!attrNames.has(cfg.hashKey)) {
    return `hashKey "${cfg.hashKey}" must be declared in attributes`;
  }
  if (cfg.rangeKey && !attrNames.has(cfg.rangeKey)) {
    return `rangeKey "${cfg.rangeKey}" must be declared in attributes`;
  }
  if (cfg.billingMode && !["PAY_PER_REQUEST", "PROVISIONED"].includes(cfg.billingMode)) {
    return "billingMode must be PAY_PER_REQUEST or PROVISIONED";
  }
  if (cfg.globalSecondaryIndexes) {
    if (!Array.isArray(cfg.globalSecondaryIndexes)) return "globalSecondaryIndexes must be an array";
    for (const gsi of cfg.globalSecondaryIndexes) {
      if (!gsi.name || typeof gsi.hashKey !== "string") return "Each GSI needs a name and hashKey";
      if (!attrNames.has(gsi.hashKey)) return `GSI hashKey "${gsi.hashKey}" must be declared in attributes`;
      if (gsi.rangeKey && !attrNames.has(gsi.rangeKey)) return `GSI rangeKey "${gsi.rangeKey}" must be declared in attributes`;
      if (!["ALL", "KEYS_ONLY", "INCLUDE"].includes(gsi.projectionType)) {
        return "GSI projectionType must be ALL, KEYS_ONLY or INCLUDE";
      }
    }
  }
  return null;
}

export function validateSnsConfig(cfg: any): string | null {
  if (!cfg || typeof cfg !== "object") return "config is required";
  if (typeof cfg.name !== "string" || !QUEUE_NAME_RE.test(cfg.name)) {
    return "SNS topic name must be 1-80 chars: letters, numbers, hyphens, underscores";
  }
  return null;
}

export function validateEventBridgeConfig(cfg: any): string | null {
  if (!cfg || typeof cfg !== "object") return "config is required";
  if (typeof cfg.name !== "string" || cfg.name.trim() === "") return "name is required";
  if (typeof cfg.busName !== "string" || cfg.busName.trim() === "") return "busName is required";
  if (typeof cfg.ruleName !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(cfg.ruleName)) {
    return "ruleName must be 1-64 chars: letters, numbers, hyphens, underscores";
  }
  if (!Array.isArray(cfg.detailTypes) || cfg.detailTypes.length === 0) {
    return "detailTypes must be a non-empty array";
  }
  if (typeof cfg.targetSqsModuleId !== "string" || cfg.targetSqsModuleId.trim() === "") {
    return "targetSqsModuleId is required (the SQS module id to deliver events to)";
  }
  if (typeof cfg.targetName !== "string" || cfg.targetName.trim() === "") {
    return "targetName is required";
  }
  return null;
}

export function validateConfig(resourceType: SquadResourceType, cfg: any): string | null {
  switch (resourceType) {
    case "sqs": return validateSqsConfig(cfg);
    case "secret": return validateSecretConfig(cfg);
    case "dynamodb": return validateDynamoConfig(cfg);
    case "sns": return validateSnsConfig(cfg);
    case "eventbridge": return validateEventBridgeConfig(cfg);
    default: return `Unsupported resource type: ${resourceType}`;
  }
}
