/**
 * Deterministic Terraform template generators for squad self-service infra.
 *
 * Unlike the SRE-critical InfraAgent (which uses Bedrock to copy complex
 * patterns), squad resources (SQS, Secret, DynamoDB, EventBridge, SNS) are
 * highly templatable. Rendering them deterministically is faster, free, fully
 * predictable, and impossible to hallucinate. The AI is reserved for the
 * complex SRE infra.
 *
 * Module versions are pinned to the standard used across squad repos (see
 * ops/infra-squads-automation-report.md):
 *   - SQS:        terraform-aws-modules/sqs/aws 4.0.1
 *   - DynamoDB:   terraform-aws-modules/dynamodb-table/aws 3.3.0
 *   - EventBridge:terraform-aws-modules/eventbridge/aws 2.3.0
 */

export type SquadResourceType = "sqs" | "secret" | "dynamodb" | "eventbridge" | "sns";

export interface SquadTagContext {
  projectTag: string; // Project = ...
  ownerTag?: string; // Owner = ... (default "Digital")
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function tfId(name: string): string {
  // Terraform resource/module label: lowercase, non-alnum → underscore.
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function renderTags(ctx: SquadTagContext): string {
  return `  tags = {
    Terraform    = true
    Environment  = var.environment
    Project      = "${ctx.projectTag}"
    Owner        = "${ctx.ownerTag ?? "Digital"}"
    Cluster-name = "eks-\${var.environment}"
  }`;
}

// ── SQS ─────────────────────────────────────────────────────────────────────

export interface SqsConfig {
  name: string;
  createDlq: boolean;
  maxReceiveCount: number;
  /** AWS service principals allowed to SendMessage. */
  principals: string[];
  delaySeconds?: number;
  visibilityTimeoutSeconds?: number;
}

export function renderSqs(cfg: SqsConfig, ctx: SquadTagContext): string {
  const id = tfId(cfg.name);
  const principalsBlock = cfg.principals
    .map(
      (p) => `        {
          type        = "Service"
          identifiers = ["${p}"]
        }`
    )
    .join(",\n");

  const lines: string[] = [];
  lines.push(`module "${id}_sqs" {`);
  lines.push(`  source  = "terraform-aws-modules/sqs/aws"`);
  lines.push(`  version = "4.0.1"`);
  lines.push(``);
  lines.push(`  name = "${cfg.name}"`);
  if (cfg.delaySeconds !== undefined && cfg.delaySeconds > 0) {
    lines.push(`  delay_seconds = ${cfg.delaySeconds}`);
  }
  if (cfg.visibilityTimeoutSeconds !== undefined && cfg.visibilityTimeoutSeconds !== 30) {
    lines.push(`  visibility_timeout_seconds = ${cfg.visibilityTimeoutSeconds}`);
  }
  lines.push(``);
  if (cfg.createDlq) {
    lines.push(`  create_dlq = true`);
    lines.push(`  dlq_message_retention_seconds = var.dlq_retention_time`);
    lines.push(`  redrive_policy = {`);
    lines.push(`    maxReceiveCount = ${cfg.maxReceiveCount}`);
    lines.push(`  }`);
    lines.push(``);
  }
  lines.push(`  create_queue_policy = true`);
  lines.push(`  queue_policy_statements = {`);
  lines.push(`    publish = {`);
  lines.push(`      sid     = "PublishEvents"`);
  lines.push(`      actions = ["sqs:SendMessage"]`);
  lines.push(``);
  lines.push(`      principals = [`);
  lines.push(principalsBlock);
  lines.push(`      ]`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(renderTags(ctx));
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

// ── Secrets Manager ───────────────────────────────────────────────────────────

export interface SecretConfig {
  /** Full secret path, e.g. dp/oms/my-service-credentials */
  name: string;
  description: string;
  /** JSON keys; each maps to a TF_VAR_<VAR> sensitive variable. */
  keys: Array<{ jsonKey: string; tfVar: string }>;
}

export function renderSecret(cfg: SecretConfig, _ctx: SquadTagContext): string {
  const id = tfId(cfg.name);
  const kvLines = cfg.keys
    .map((k) => `      "${k.jsonKey}" = var.${k.tfVar}`)
    .join("\n");

  return `resource "aws_secretsmanager_secret" "${id}" {
  name        = "${cfg.name}"
  description = "${cfg.description.replace(/"/g, '\\"')}"
}

resource "aws_secretsmanager_secret_version" "${id}" {
  secret_id = aws_secretsmanager_secret.${id}.id
  secret_string = jsonencode(
    {
${kvLines}
    }
  )
}
`;
}

/** Returns the variable declarations to append to variables.tf for a secret. */
export function renderSecretVariables(cfg: SecretConfig): string {
  return cfg.keys
    .map(
      (k) => `variable "${k.tfVar}" {
  type      = string
  sensitive = true
}`
    )
    .join("\n\n") + "\n";
}

// ── DynamoDB ──────────────────────────────────────────────────────────────────

export interface DynamoAttribute {
  name: string;
  type: "S" | "N" | "B";
}

export interface DynamoGsi {
  name: string;
  hashKey: string;
  rangeKey?: string;
  projectionType: "ALL" | "KEYS_ONLY" | "INCLUDE";
}

export interface DynamoConfig {
  name: string;
  hashKey: string;
  rangeKey?: string;
  attributes: DynamoAttribute[];
  billingMode: "PAY_PER_REQUEST" | "PROVISIONED";
  pitrProdOnly: boolean; // point_in_time_recovery_enabled = prod ? true : false
  ttlAttribute?: string;
  globalSecondaryIndexes?: DynamoGsi[];
}

export function renderDynamo(cfg: DynamoConfig, ctx: SquadTagContext): string {
  const id = tfId(cfg.name);
  const attrs = cfg.attributes
    .map(
      (a) => `    {
      name = "${a.name}"
      type = "${a.type}"
    }`
    )
    .join(",\n");

  const lines: string[] = [];
  lines.push(`module "${id}_dynamodb_table" {`);
  lines.push(`  source  = "terraform-aws-modules/dynamodb-table/aws"`);
  lines.push(`  version = "3.3.0"`);
  lines.push(``);
  lines.push(`  name      = "${cfg.name}"`);
  lines.push(`  hash_key  = "${cfg.hashKey}"`);
  if (cfg.rangeKey) {
    lines.push(`  range_key = "${cfg.rangeKey}"`);
  }
  lines.push(``);
  lines.push(`  attributes = [`);
  lines.push(attrs);
  lines.push(`  ]`);
  lines.push(``);
  lines.push(`  billing_mode                   = "${cfg.billingMode}"`);
  lines.push(
    `  point_in_time_recovery_enabled = ${cfg.pitrProdOnly ? 'var.environment == "prod" ? true : false' : "true"}`
  );
  if (cfg.ttlAttribute) {
    lines.push(``);
    lines.push(`  ttl_attribute_name = "${cfg.ttlAttribute}"`);
    lines.push(`  ttl_enabled        = true`);
  }
  if (cfg.globalSecondaryIndexes && cfg.globalSecondaryIndexes.length > 0) {
    lines.push(``);
    lines.push(`  global_secondary_indexes = [`);
    lines.push(
      cfg.globalSecondaryIndexes
        .map((gsi) => {
          const inner = [
            `      name            = "${gsi.name}"`,
            `      hash_key        = "${gsi.hashKey}"`,
            gsi.rangeKey ? `      range_key       = "${gsi.rangeKey}"` : "",
            `      projection_type = "${gsi.projectionType}"`,
          ]
            .filter(Boolean)
            .join("\n");
          return `    {\n${inner}\n    }`;
        })
        .join(",\n")
    );
    lines.push(`  ]`);
  }
  lines.push(``);
  lines.push(renderTags(ctx));
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

// ── SNS Topic ─────────────────────────────────────────────────────────────────

export interface SnsConfig {
  name: string;
}

export function renderSns(cfg: SnsConfig, _ctx: SquadTagContext): string {
  const id = tfId(cfg.name);
  return `resource "aws_sns_topic" "${id}" {
  name = "${cfg.name}"
}
`;
}

// ── EventBridge Rule + Target ──────────────────────────────────────────────────

export interface EventBridgeConfig {
  /** Logical name for the module/rule. */
  name: string;
  /** Existing bus name (e.g. "oms"). create_bus is always false for self-service. */
  busName: string;
  ruleName: string;
  /** detail-type values to match. */
  detailTypes: string[];
  /** Optional source values to match. */
  sources?: string[];
  /** Target SQS module reference, e.g. "module.my_queue_sqs.queue_arn".
   *  We reference an existing queue ARN by the module id. */
  targetSqsModuleId: string;
  targetName: string;
}

export function renderEventBridge(cfg: EventBridgeConfig, ctx: SquadTagContext): string {
  const id = tfId(cfg.name);
  const pattern: Record<string, unknown> = { "detail-type": cfg.detailTypes };
  if (cfg.sources && cfg.sources.length > 0) {
    pattern["source"] = cfg.sources;
  }
  const patternJson = JSON.stringify(pattern);

  return `module "${id}_eventbridge" {
  source  = "terraform-aws-modules/eventbridge/aws"
  version = "2.3.0"

  create_bus          = false
  create_role         = false
  bus_name            = "${cfg.busName}"
  append_rule_postfix = false

  rules = {
    ${cfg.ruleName} = {
      description   = "${cfg.name} rule"
      event_pattern = jsonencode(${patternJson})
      enabled       = true
    }
  }

  targets = {
    ${cfg.ruleName} = [
      {
        name            = "${cfg.targetName}"
        arn             = module.${cfg.targetSqsModuleId}.queue_arn
        dead_letter_arn = module.${cfg.targetSqsModuleId}.dead_letter_queue_arn
      }
    ]
  }

${renderTags(ctx)}
}
`;
}
