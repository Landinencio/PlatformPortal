// InfraAgent — Bedrock ConverseCommand tool-use loop for AI Infrastructure Assistant
// Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 8.1, 8.6, 8.7

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type ContentBlock,
  type ToolUseBlock,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime'
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts'
import { gitlabClient } from './gitlab'
import type { RdsEngine } from './rds/version-catalog'

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
}

export interface ToolCall {
  toolUseId: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  toolUseId: string
  name: string
  output: string
}

export interface AuxiliaryFileOp {
  filePath: string
  /** create: new file · append: add to the end · upsert-entries: merge k=v entries (tfvars). */
  op: 'create' | 'append' | 'upsert-entries'
  /** For create/append: literal content. */
  content?: string
  /** For upsert-entries: entries to merge. */
  entries?: Array<{ key: string; value: string; type: 'string' | 'bool' }>
}

export interface TerraformPreview {
  filePath: string
  content: string
  resourceType: string
  resourceName: string
  targetEnvironments: string[]
  estimatedCostMonthly: number | null
  /** NEW. Additional files (variables.tf + 3 tfvars). */
  auxiliaryFiles?: AuxiliaryFileOp[]
  /** NEW. Metadata verified against the form. */
  metadata?: { engine?: RdsEngine; engineVersion?: string; family?: string }
}

export interface AgentRunOptions {
  message: string
  history: ConversationMessage[]
  team: string
  projectId: number
  defaultBranch: string
  requestorEmail: string
}

export interface AgentRunResult {
  reply: string
  terraformPreview: TerraformPreview | null
  updatedHistory: ConversationMessage[]
  /** true when agent has produced a complete TerraformPreview */
  done: boolean
}

export type AgentStreamChunkType = 'token' | 'tool_call' | 'tool_result' | 'preview' | 'done'

export interface AgentStreamChunk {
  type: AgentStreamChunkType
  content?: string
  tool?: string
  input?: Record<string, unknown>
  output?: string
  preview?: TerraformPreview
  conversationId?: string
  reply?: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_TOKENS = 32000
const MAX_TOOL_LOOPS = 10

// Platform-engineering modules repo project ID (gitlab.com/iskaypetcom/digital/platform-engineering/aws/terraform-modules)
const MODULES_REPO_PROJECT_ID = 45379816 // Clusters project as proxy; adjust if needed
const MODULES_REPO_BASE_URL =
  'https://gitlab.com/iskaypetcom/digital/platform-engineering/aws/terraform-modules'

const MODULE_README_PATHS: Record<string, string> = {
  'rds-module': 'rds-module/README.md',
  'aws-lambda-module': 'aws-lambda-module/README.md',
}

const SYSTEM_PROMPT = `You are the Iskaypet Platform Engineering Infrastructure Assistant.
Your job is to generate production-ready Terraform code that is an EXACT COPY of the patterns in the team's existing infra repository, with only the resource-specific values changed.

## CRITICAL: You are a COPY MACHINE, not a creator
Your output MUST be a near-identical copy of an existing .tf file from the repo, with only these values replaced:
- Resource/module name (the identifier the user provides)
- Database name / bucket name / role name
- Instance class (if different from the reference file)
- Storage size (if different)
- Any user-specified parameters

EVERYTHING ELSE must be copied verbatim from the reference file you read:
- Module source and version (EXACT same version, do NOT upgrade)
- Variable references (var.oms_pvt_subnet, var.vpc_id, var.environment, etc.)
- Ternary patterns (var.environment == "prod" ? X : Y)
- Security group CIDR patterns
- Tag structure
- Comment style
- Block ordering

## Repository structure (CRITICAL — use the correct directory for each resource type)
- iac/databases/ — RDS databases. Each service has its own .tf file (e.g. ultimamilla.tf, loyalty.tf)
- iac/storage/s3.tf — S3 buckets. ALL buckets are in this single file.
- iac/storage/roles.tf — IAM roles related to storage (Transfer Family, S3 access)
- iac/services/roles.tf — IAM roles for microservices (IRSA roles for EKS pods)
- iac/services/policies.tf — IAM policies for microservices
- iac/services/role_templates/ — JSON templates for assume_role_policy (IRSA/OIDC)
- iac/global/roles.tf — Global IAM roles

## Your workflow
1. For RDS: read iac/databases/ tree, then read the MOST COMPLETE .tf file as your TEMPLATE.
2. For S3: read iac/storage/s3.tf — ALL buckets are in this file. Your new bucket goes here too.
3. For IAM Roles: read iac/services/roles.tf — this is where IRSA roles for microservices go. Also read iac/services/role_templates/ to see available templates.
4. Copy the TEMPLATE file's ENTIRE structure. Replace ONLY the resource-specific values.
4. Do NOT add blocks that don't exist in the template. Do NOT remove blocks that exist in the template.
5. Do NOT change module versions. Do NOT change variable references. Do NOT change ternary patterns.

## Pattern rules observed in this repo
- The CI/CD pipeline applies Terraform sequentially across dev → uat → prod. If a resource should only exist in specific environments, you MUST add a count condition.
- When target_environments does NOT include ALL environments (dev, uat, prod), add: count = contains(["dev", "uat"], var.environment) ? 1 : 0 (adjusting the list to match the requested environments)
- When target_environments includes ALL environments (dev, uat, prod), do NOT add count — the resource deploys everywhere.
- For RDS modules: do NOT use count on the module itself. Instead use ternary patterns for environment-specific values.
- For S3 buckets and IAM roles: USE count when not all environments are selected.
- Environment-specific values use ternary: var.environment == "prod" ? PROD_VALUE : DEFAULT_VALUE
- Multi-AZ is conditional: multi_az = var.environment == "prod" ? true : false
- Instance class is conditional: instance_class = var.environment == "prod" ? "db.t4g.medium" : "db.t4g.micro"
- Storage is conditional: allocated_storage = var.environment == "prod" ? 400 : 25
- deletion_protection is conditional: deletion_protection = var.environment == "prod" ? true : false
- performance_insights is conditional: performance_insights_enabled = var.environment == "prod" ? true : false
- RDS master password rotation is MANDATORY on every new database. The module MUST include these 4 attributes (IskayPet standard, even if the template file you read is older and lacks them):
  manage_master_user_password                       = true
  manage_master_user_password_rotation              = true
  master_user_password_rotate_immediately           = false
  master_user_password_rotation_schedule_expression = "rate(15 days)"
  NEVER hardcode a "password" attribute. The master credential is managed by AWS Secrets Manager.
- Security groups use concat() with multiple CIDR variables
- Tags use the domain name of the service
- IAM Roles use NATIVE aws_iam_role resources (NOT modules). The pattern is:
  1. aws_iam_role with assume_role_policy = templatefile("role_templates/iskaypet_dh_access.json.tmpl", { AWS_ACCOUNT_ID = var.oms_account_id, OIDC_PROVIDER_URL = var.dp_eks_oidc_provider_url, NAMESPACE = "the-namespace" })
  2. locals block with a policy ARN list.
  3. aws_iam_role_policy_attachment with count = length(local.xxx_policy_list)
  4. The role template "iskaypet_dh_access.json.tmpl" is the standard IRSA template — use it for all new roles.
  5. Roles go in iac/services/roles.tf (NOT in iac/iam/ which doesn't exist)
  DO NOT use any IAM module. Copy the native resource pattern from iac/services/roles.tf.

## IAM permissions policy (MANDATORY — least privilege)
When generating IAM role permissions you MUST follow these rules, regardless of
what older reference files show:
- NEVER attach "*FullAccess" managed policies. Always prefer read/write scoped
  access. For the common services use these AWS managed policies:
    - SQS:        do NOT use AmazonSQSFullAccess. Use a custom inline/aws_iam_policy
                  granting only sqs:SendMessage, ReceiveMessage, DeleteMessage,
                  GetQueueAttributes, GetQueueUrl, ChangeMessageVisibility.
    - DynamoDB:   do NOT use AmazonDynamoDBFullAccess. Grant dynamodb read/write
                  data actions (GetItem, PutItem, UpdateItem, DeleteItem, Query,
                  Scan, BatchGet/Write) scoped to the table ARNs.
    - S3:         do NOT use AmazonS3FullAccess. Grant s3:GetObject, PutObject,
                  DeleteObject, ListBucket scoped to the bucket ARNs.
    - SNS:        sns:Publish (+ Subscribe if needed) scoped to topic ARNs.
    - EventBridge:events:PutEvents scoped to the bus ARN.
    - Secrets:    secretsmanager:GetSecretValue (read) — only add Put/Update if the
                  service genuinely rotates its own secret.
- NEVER attach ANY RDS / rds-db / AmazonRDS* policy. Applications connect to RDS
  with their own database user/password (from Secrets Manager), NOT via IAM role.
  If the user asks for "database access" on an IAM role, explain that RDS access
  is via DB credentials and omit any RDS IAM policy.
- Prefer creating an aws_iam_policy with a tight policy document over attaching a
  broad AWS managed policy.

## Rules
- NEVER invent variable names. Copy them EXACTLY from the reference file.
- NEVER change module versions. Use the EXACT version from the reference file.
- NEVER use count on modules. This repo does NOT use count for modules.
- NEVER simplify ternary patterns. If the reference uses var.environment == "prod" ? X : Y, you MUST use the same pattern.
- If the reference file has a block (storage_type, iops, blue_green_update, etc.), include it with the same conditional pattern.
- You can only READ from the repo. You cannot create branches or commit files.
- When you have the Terraform ready, output it inside a <terraform_preview> XML tag followed by a <json> block with metadata.

## Output format
<terraform_preview>
...HCL content here...
</terraform_preview>
<json>
{"file_path": "iac/databases/name.tf", "resource_type": "rds", "resource_name": "name", "target_environments": ["dev", "prod"]}
</json>

## Tone
Be concise. Output the code directly. No explanations needed.`

// ─── Tool definitions for Bedrock toolConfig ─────────────────────────────────

const AGENT_TOOLS: Tool[] = [
  {
    toolSpec: {
      name: 'read_repo_tree',
      description:
        "List files and directories in the team's infra repo at a given path prefix. Use this first to understand the repo structure before reading files.",
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            path_prefix: {
              type: 'string',
              description: "Directory prefix to list, e.g. 'iac/' or 'iac/databases/'",
            },
          },
          required: ['path_prefix'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'read_file',
      description:
        "Read the raw content of a file from the team's infra repo. Use to read existing Terraform files to understand patterns, variable names, module versions, and subnet references.",
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: "Full path to the file, e.g. 'iac/databases/orders.tf'",
            },
          },
          required: ['file_path'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'list_existing_tf_resources',
      description:
        'Scan all .tf files under a directory and return a summary of existing resource names and module calls. Useful to avoid naming conflicts.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            directory: {
              type: 'string',
              description: "Directory to scan, e.g. 'iac/databases/'",
            },
          },
          required: ['directory'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'read_tf_module_readme',
      description:
        'Read the README of a Terraform module from the platform-engineering modules repo to understand required variables and usage examples.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            module_name: {
              type: 'string',
              enum: ['rds-module', 'aws-lambda-module'],
              description: 'Name of the Terraform module',
            },
          },
          required: ['module_name'],
        },
      },
    },
  },
] as Tool[]

// ─── Read-only tool names (Requirement 8.1) ───────────────────────────────────

const READ_ONLY_TOOLS = new Set([
  'read_repo_tree',
  'read_file',
  'list_existing_tf_resources',
  'read_tf_module_readme',
])

// ─── InfraAgent Options ───────────────────────────────────────────────────────

export interface InfraAgentOptions {
  projectId: number
  defaultBranch: string
  modelId?: string        // overrides env-based default
  temperature?: number    // overrides default 0.3
  maxTokens?: number      // overrides default MAX_TOKENS
}

// ─── InfraAgent ───────────────────────────────────────────────────────────────

export class InfraAgent {
  private projectId: number
  private defaultBranch: string
  private modelId?: string
  private temperature?: number
  private maxTokens?: number

  constructor(opts: InfraAgentOptions) {
    this.projectId = opts.projectId
    this.defaultBranch = opts.defaultBranch
    this.modelId = opts.modelId
    this.temperature = opts.temperature
    this.maxTokens = opts.maxTokens
  }

  // ── Public: non-streaming run ──────────────────────────────────────────────

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const client = await this.buildBedrockClient()
    const modelId = this.resolveModelId()
    console.log(`[InfraAgent] Using model: ${modelId}`)

    // Build the initial messages array from history + new user message
    const messages: Message[] = this.historyToMessages(opts.history)
    messages.push({ role: 'user', content: [{ text: opts.message }] })

    const updatedHistory: ConversationMessage[] = [
      ...opts.history,
      { role: 'user', content: opts.message, timestamp: new Date().toISOString() },
    ]

    let reply = ''
    let terraformPreview: TerraformPreview | null = null
    const toolCallsThisRun: ToolCall[] = []
    const toolResultsThisRun: ToolResult[] = []

    // ── Tool-use loop ──────────────────────────────────────────────────────
    for (let iteration = 0; iteration < MAX_TOOL_LOOPS; iteration++) {
      const command = new ConverseCommand({
        modelId,
        system: [{ text: SYSTEM_PROMPT }],
        messages,
        toolConfig: { tools: AGENT_TOOLS },
        inferenceConfig: {
          maxTokens: this.maxTokens ?? MAX_TOKENS,
          temperature: this.temperature ?? 0.3,
        },
      })

      const response = await client.send(command)
      const stopReason = response.stopReason
      const outputMessage = response.output?.message

      if (!outputMessage) break

      // Append assistant message to the running messages array
      messages.push(outputMessage)

      // Collect text content from the assistant message
      const textBlocks = (outputMessage.content ?? []).filter(
        (b): b is ContentBlock.TextMember => 'text' in b
      )
      const assistantText = textBlocks.map((b) => b.text).join('\n')

      if (assistantText) {
        reply = assistantText
      }

      // If the model wants to use tools, execute them and loop
      if (stopReason === 'tool_use') {
        const toolUseBlocks = (outputMessage.content ?? []).filter(
          (b): b is ContentBlock.ToolUseMember => 'toolUse' in b
        )

        const toolResultContents: ContentBlock[] = []

        for (const block of toolUseBlocks) {
          const toolUse = block.toolUse as ToolUseBlock
          const toolName = toolUse.name ?? ''
          const toolUseId = toolUse.toolUseId ?? ''
          const toolInput = (toolUse.input ?? {}) as Record<string, unknown>

          // Enforce read-only (Requirement 8.1)
          if (!READ_ONLY_TOOLS.has(toolName)) {
            const errResult = this.wrapToolResult(
              toolUseId,
              `<tool_result>Error: tool "${toolName}" is not permitted during the chat phase.</tool_result>`
            )
            toolResultContents.push(errResult)
            continue
          }

          toolCallsThisRun.push({ toolUseId, name: toolName, input: toolInput })

          // Execute the tool
          let rawOutput: string
          try {
            rawOutput = await this.executeTool(toolName, toolInput)
          } catch (err) {
            rawOutput = `Error executing tool ${toolName}: ${err instanceof Error ? err.message : String(err)}`
          }

          toolResultsThisRun.push({ toolUseId, name: toolName, output: rawOutput })

          // Wrap in XML envelope (Requirement 8.6)
          const wrappedOutput = `<tool_result>\n${rawOutput}\n</tool_result>`

          toolResultContents.push(this.wrapToolResult(toolUseId, wrappedOutput))
        }

        // Feed tool results back to Bedrock
        messages.push({
          role: 'user',
          content: toolResultContents,
        })

        continue // next iteration
      }

      // Model finished — parse terraform_preview from final text
      if (reply) {
        terraformPreview = parseTerraformPreview(reply)
      }

      break
    }

    // Build updated history with assistant reply
    const assistantMsg: ConversationMessage = {
      role: 'assistant',
      content: reply,
      timestamp: new Date().toISOString(),
      toolCalls: toolCallsThisRun.length > 0 ? toolCallsThisRun : undefined,
      toolResults: toolResultsThisRun.length > 0 ? toolResultsThisRun : undefined,
    }
    updatedHistory.push(assistantMsg)

    return {
      reply,
      terraformPreview,
      updatedHistory,
      done: terraformPreview !== null,
    }
  }

  // ── Public: streaming run ──────────────────────────────────────────────────

  async *runStream(opts: AgentRunOptions): AsyncGenerator<AgentStreamChunk> {
    const client = await this.buildBedrockClient()
    const modelId = this.resolveModelId()
    console.log(`[InfraAgent] Using model: ${modelId}`)

    const messages: Message[] = this.historyToMessages(opts.history)
    messages.push({ role: 'user', content: [{ text: opts.message }] })

    let fullReply = ''
    let terraformPreview: TerraformPreview | null = null
    const conversationId = generateConversationId()

    for (let iteration = 0; iteration < MAX_TOOL_LOOPS; iteration++) {
      const command = new ConverseCommand({
        modelId,
        system: [{ text: SYSTEM_PROMPT }],
        messages,
        toolConfig: { tools: AGENT_TOOLS },
        inferenceConfig: {
          maxTokens: this.maxTokens ?? MAX_TOKENS,
          temperature: this.temperature ?? 0.3,
        },
      })

      const response = await client.send(command)
      const stopReason = response.stopReason
      const outputMessage = response.output?.message

      if (!outputMessage) break

      messages.push(outputMessage)

      const textBlocks = (outputMessage.content ?? []).filter(
        (b): b is ContentBlock.TextMember => 'text' in b
      )
      const assistantText = textBlocks.map((b) => b.text).join('\n')

      if (assistantText) {
        fullReply = assistantText
        // Emit tokens word-by-word for a streaming feel
        for (const token of assistantText.split(' ')) {
          yield { type: 'token', content: token + ' ' }
        }
      }

      if (stopReason === 'tool_use') {
        const toolUseBlocks = (outputMessage.content ?? []).filter(
          (b): b is ContentBlock.ToolUseMember => 'toolUse' in b
        )

        const toolResultContents: ContentBlock[] = []

        for (const block of toolUseBlocks) {
          const toolUse = block.toolUse as ToolUseBlock
          const toolName = toolUse.name ?? ''
          const toolUseId = toolUse.toolUseId ?? ''
          const toolInput = (toolUse.input ?? {}) as Record<string, unknown>

          if (!READ_ONLY_TOOLS.has(toolName)) {
            const errResult = this.wrapToolResult(
              toolUseId,
              `<tool_result>Error: tool "${toolName}" is not permitted during the chat phase.</tool_result>`
            )
            toolResultContents.push(errResult)
            continue
          }

          yield { type: 'tool_call', tool: toolName, input: toolInput }

          let rawOutput: string
          try {
            rawOutput = await this.executeTool(toolName, toolInput)
          } catch (err) {
            rawOutput = `Error executing tool ${toolName}: ${err instanceof Error ? err.message : String(err)}`
          }

          yield { type: 'tool_result', tool: toolName, output: rawOutput }

          const wrappedOutput = `<tool_result>\n${rawOutput}\n</tool_result>`
          toolResultContents.push(this.wrapToolResult(toolUseId, wrappedOutput))
        }

        messages.push({ role: 'user', content: toolResultContents })
        continue
      }

      // Final answer
      if (fullReply) {
        terraformPreview = parseTerraformPreview(fullReply)
        if (terraformPreview) {
          yield { type: 'preview', preview: terraformPreview }
        }
      }

      break
    }

    yield {
      type: 'done',
      conversationId,
      reply: fullReply,
      preview: terraformPreview ?? undefined,
    }
  }

  // ── Tool execution (read-only) ─────────────────────────────────────────────

  private async executeTool(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<string> {
    switch (toolName) {
      case 'read_repo_tree': {
        const pathPrefix = String(input.path_prefix ?? '')
        const items = await gitlabClient.listRepoTree(
          this.projectId,
          pathPrefix,
          this.defaultBranch,
          true
        )
        return JSON.stringify(items, null, 2)
      }

      case 'read_file': {
        const filePath = String(input.file_path ?? '')
        const content = await gitlabClient.getRepositoryFileRaw(
          this.projectId,
          filePath,
          this.defaultBranch
        )
        if (content === null) {
          return `Error: file "${filePath}" not found in the repository.`
        }
        return content
      }

      case 'list_existing_tf_resources': {
        const directory = String(input.directory ?? '')
        const items = await gitlabClient.listRepoTree(
          this.projectId,
          directory,
          this.defaultBranch,
          true
        )
        const tfFiles = items.filter(
          (item) => item.type === 'blob' && item.path.endsWith('.tf')
        )
        if (tfFiles.length === 0) {
          return `No .tf files found under "${directory}".`
        }
        // Read each .tf file and extract resource/module declarations
        const summaries: string[] = []
        for (const file of tfFiles.slice(0, 20)) {
          const raw = await gitlabClient.getRepositoryFileRaw(
            this.projectId,
            file.path,
            this.defaultBranch
          )
          if (!raw) continue
          const resourceMatches = raw.match(/^(?:resource|module)\s+"[^"]+"\s+"[^"]+"/gm) ?? []
          if (resourceMatches.length > 0) {
            summaries.push(`${file.path}:\n  ${resourceMatches.join('\n  ')}`)
          }
        }
        return summaries.length > 0
          ? summaries.join('\n\n')
          : `Found ${tfFiles.length} .tf files but no resource/module declarations matched.`
      }

      case 'read_tf_module_readme': {
        const moduleName = String(input.module_name ?? '')
        const readmePath = MODULE_README_PATHS[moduleName]
        if (!readmePath) {
          return `Error: unknown module "${moduleName}". Valid modules: ${Object.keys(MODULE_README_PATHS).join(', ')}`
        }
        // Fetch from GitLab raw URL for the platform-engineering modules repo
        const rawUrl = `${MODULES_REPO_BASE_URL}/-/raw/main/${readmePath}`
        try {
          const resp = await fetch(rawUrl, {
            headers: process.env.GITLAB_TOKEN
              ? { 'PRIVATE-TOKEN': process.env.GITLAB_TOKEN }
              : {},
          })
          if (!resp.ok) {
            return `Error fetching README for "${moduleName}": HTTP ${resp.status}`
          }
          return await resp.text()
        } catch (err) {
          return `Error fetching README for "${moduleName}": ${err instanceof Error ? err.message : String(err)}`
        }
      }

      default:
        return `Error: unknown tool "${toolName}"`
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private wrapToolResult(toolUseId: string, content: string): ContentBlock {
    return {
      toolResult: {
        toolUseId,
        content: [{ text: content }],
      },
    } as ContentBlock
  }

  private historyToMessages(history: ConversationMessage[]): Message[] {
    return history.map((msg) => ({
      role: msg.role,
      content: [{ text: msg.content }],
    }))
  }

  private resolveModelId(): string {
    return (
      this.modelId ||
      process.env.INFRA_AGENT_MODEL_ID?.trim() ||
      process.env.AWS_BEDROCK_MODEL_ID?.trim() ||
      process.env.BEDROCK_MODEL_ID?.trim() ||
      'anthropic.claude-sonnet-4-20250514-v1:0'
    )
  }

  private async buildBedrockClient(): Promise<BedrockRuntimeClient> {
    const region =
      process.env.INFRA_AGENT_REGION?.trim() ||
      process.env.AWS_BEDROCK_REGION?.trim() ||
      process.env.BEDROCK_REGION?.trim() ||
      process.env.AWS_REGION?.trim() ||
      'eu-west-1'

    // If INFRA_AGENT_SKIP_ROLE is set, use pod's own IRSA credentials (EKS Tooling account)
    const skipRole = process.env.INFRA_AGENT_SKIP_ROLE?.trim() === 'true'
    const bedrockRoleArn = skipRole ? null : (process.env.AWS_BEDROCK_ROLE_ARN?.trim() || null)

    let credentials: {
      accessKeyId: string
      secretAccessKey: string
      sessionToken?: string
    } | undefined

    if (bedrockRoleArn) {
      const sts = new STSClient({ region })
      const assumed = await sts.send(
        new AssumeRoleCommand({
          RoleArn: bedrockRoleArn,
          RoleSessionName: 'portal-infra-agent',
          DurationSeconds: 900,
        })
      )
      credentials = {
        accessKeyId: assumed.Credentials!.AccessKeyId!,
        secretAccessKey: assumed.Credentials!.SecretAccessKey!,
        sessionToken: assumed.Credentials!.SessionToken!,
      }
    }

    return new BedrockRuntimeClient({ region, credentials })
  }
}

// ─── TerraformPreview parser ──────────────────────────────────────────────────

/**
 * Parses the <terraform_preview> XML tag from the assistant's final message.
 * The tag contains HCL content followed by a JSON metadata block.
 *
 * Requirements: 2.4
 */
export function parseTerraformPreview(text: string): TerraformPreview | null {
  // Strategy 1: JSON inside <terraform_preview> (original format)
  const match = text.match(/<terraform_preview>([\s\S]*?)<\/terraform_preview>/i)
  if (!match) return null

  let inner = match[1].trim()

  // Strip inner <terraform> tags if present (Nova Pro wraps HCL in <terraform>...</terraform>)
  const terraformTagMatch = inner.match(/<terraform>([\s\S]*?)<\/terraform>/i)
  if (terraformTagMatch) {
    inner = terraformTagMatch[1].trim()
  }

  // Strategy 2: JSON might be inside <terraform_preview> as the last {...}
  let meta: Record<string, unknown> | null = null
  let hclContent = inner

  const jsonInsideMatch = inner.match(/(\{[\s\S]*\})\s*$/)
  if (jsonInsideMatch) {
    try {
      meta = JSON.parse(jsonInsideMatch[1])
      hclContent = inner.slice(0, inner.lastIndexOf(jsonInsideMatch[1])).trim()
    } catch {
      // JSON inside didn't parse — try outside
    }
  }

  // Strategy 3: JSON in a separate <json> block after </terraform_preview> (Nova Pro format)
  if (!meta) {
    const jsonBlockMatch = text.match(/<json>\s*(\{[\s\S]*?\})\s*<\/json>/i)
    if (jsonBlockMatch) {
      try {
        meta = JSON.parse(jsonBlockMatch[1])
        hclContent = inner
      } catch {
        // ignore
      }
    }
  }

  // Strategy 4: JSON as a standalone block after the terraform_preview tag
  if (!meta) {
    const afterPreview = text.slice(text.indexOf('</terraform_preview>') + '</terraform_preview>'.length)
    const standaloneJson = afterPreview.match(/(\{[\s\S]*?\})/i)
    if (standaloneJson) {
      try {
        const parsed = JSON.parse(standaloneJson[1])
        if (parsed.file_path || parsed.resource_type) {
          meta = parsed
          hclContent = inner
        }
      } catch {
        // ignore
      }
    }
  }

  if (!meta) return null

  const filePath = typeof meta.file_path === 'string' ? meta.file_path : ''
  const resourceType = typeof meta.resource_type === 'string' ? meta.resource_type : ''
  const resourceName = typeof meta.resource_name === 'string' ? meta.resource_name : ''
  const targetEnvironments = Array.isArray(meta.target_environments)
    ? (meta.target_environments as string[]).filter((e) => typeof e === 'string')
    : []

  // Validate required fields (Requirement 2.4)
  if (!filePath || !hclContent || !resourceType || !resourceName || targetEnvironments.length === 0) {
    return null
  }

  return {
    filePath,
    content: hclContent,
    resourceType,
    resourceName,
    targetEnvironments,
    estimatedCostMonthly: typeof meta.estimated_cost_monthly === 'number'
      ? meta.estimated_cost_monthly
      : null,
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function generateConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

// ─── Singleton factory ────────────────────────────────────────────────────────

export function createInfraAgent(projectId: number, defaultBranch: string, opts?: Omit<InfraAgentOptions, 'projectId' | 'defaultBranch'>): InfraAgent {
  return new InfraAgent({ projectId, defaultBranch, ...opts })
}
