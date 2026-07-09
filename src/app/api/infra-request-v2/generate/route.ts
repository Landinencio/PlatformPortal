// POST /api/infra-request-v2/generate
// Accepts structured form data, builds AI prompt, runs InfraAgent, returns TerraformPreview
// Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 6.1, 6.4, 6.9, 12.1, 12.2, 12.3
//
// Feature `infra-self-service-hardening` (task 5.3): before invoking the
// Generador_RDS or the InfraAgent this route runs the Guardia_Duplicado to
// short-circuit requests whose target file already exists in the team repo
// (Req 2.1–2.11, 6.1, 6.6). The whole gate is behind
// `ENABLE_INFRA_HARDENING_V1` so the flag-off path stays byte-exact with the
// baseline `portal-prod v0.23.0-rc.1` behaviour (Req 7.3).

import { NextResponse } from 'next/server'
import { requireUserAuth } from '@/lib/api-auth'
import { repoCatalog } from '@/lib/repo-catalog'
import { InfraAgent } from '@/lib/infra-agent'
import { buildPrompt } from '@/lib/infra-prompt-builder'
import type { ResourceFields } from '@/lib/infra-prompt-builder'
import { validateRdsFields, validateS3Fields, validateIamRoleFields } from '@/lib/field-validators'
import { RateLimiter } from '@/lib/rate-limiter'
import { InfraLogger } from '@/lib/logger'
import { RdsGenerator } from '@/lib/rds/rds-generator'
import type { RdsFields } from '@/lib/infra-prompt-builder'
import { ENABLE_INFRA_HARDENING_V1 } from '@/lib/feature-flags'
import { validateIdentifier, checkDuplicate } from '@/lib/infra/duplicate-guard'
import { gitlabClient } from '@/lib/gitlab'
import {
  generateIamRoleHcl,
  isCoveredByCatalog,
  validateRequiredRoleFields,
  type PresetSelection,
  type GenerateIamRoleInput,
} from '@/lib/iam-catalog/generator'
import type { TerraformPreview } from '@/lib/infra-agent'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const VALID_RESOURCE_TYPES = ['rds', 's3', 'iam_role'] as const
type ValidResourceType = (typeof VALID_RESOURCE_TYPES)[number]

/**
 * Portal standard `terraform-aws-modules/rds/aws` version, used by the
 * deterministic RDS generator as a fallback when the destination repo has no
 * readable module version to mirror (R4.4/R4.5).
 */
const PORTAL_DEFAULT_RDS_MODULE_VERSION = '6.10.0'

// Maps RdsGenerator error codes to HTTP statuses. Invalid engine/version are
// client input errors (400); the deterministic guards (missing databases dir,
// literal/tfvars/coherence) are unprocessable-entity conditions (422). In every
// case the generator performs no writes, so the repository stays intact.
const RDS_ERROR_STATUS: Record<string, number> = {
  invalid_engine: 400,
  invalid_version: 400,
  missing_databases_dir: 422,
  literal_guard: 422,
  tfvars_incomplete: 422,
  coherence_mismatch: 422,
}

// Canonical env forced for the Tooling team (Requirement 7.4): the destination
// environment is fixed to `tooling` and treated as non-editable server-side.
const TOOLING_TEAM_SLUG = 'tooling'

// Module-level rate limiter instance — persists across requests within the same server process
const rateLimiter = new RateLimiter()

export async function POST(request: Request) {
  const auth = await requireUserAuth(request)
  if (auth.error) { return auth.error }

  // Rate limit check — enforce per-user threshold after authentication
  const userEmail = auth.session.user?.email ?? 'unknown'
  const logger = new InfraLogger('generate', userEmail)
  logger.info('Request received')

  const rateResult = rateLimiter.check(userEmail)
  if (!rateResult.allowed) {
    logger.warn('Rate limited', { retryAfterSeconds: rateResult.retryAfterSeconds })
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      {
        status: 429,
        headers: { 'Retry-After': String(rateResult.retryAfterSeconds) },
      }
    )
  }

  // Parse request body
  let body: {
    team?: unknown
    resourceType?: unknown
    fields?: unknown
    targetEnvironments?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { team, resourceType, fields, targetEnvironments } = body

  // Requirement 10.3 — validate resourceType
  if (
    typeof resourceType !== 'string' ||
    !VALID_RESOURCE_TYPES.includes(resourceType as ValidResourceType)
  ) {
    return NextResponse.json(
      { error: `Invalid resourceType. Must be one of: ${VALID_RESOURCE_TYPES.join(', ')}` },
      { status: 400 }
    )
  }

  if (typeof team !== 'string' || team.trim() === '') {
    return NextResponse.json({ error: 'team must be a non-empty string' }, { status: 400 })
  }

  if (!fields || typeof fields !== 'object') {
    return NextResponse.json({ error: 'fields must be an object' }, { status: 400 })
  }

  if (!Array.isArray(targetEnvironments) || targetEnvironments.length === 0) {
    return NextResponse.json(
      { error: 'targetEnvironments must be a non-empty array' },
      { status: 400 }
    )
  }

  // Requirement 6.1–6.5 — field validation per resource type
  const typedResourceType = resourceType as ValidResourceType
  const typedFields = fields as Record<string, any>
  let fieldError: string | null = null

  if (typedResourceType === 'rds') {
    fieldError = validateRdsFields(typedFields)
  } else if (typedResourceType === 's3') {
    fieldError = validateS3Fields(typedFields)
  } else if (typedResourceType === 'iam_role') {
    fieldError = validateIamRoleFields(typedFields)
  }

  if (fieldError) {
    return NextResponse.json({ error: fieldError }, { status: 400 })
  }

  // Requirement 10.2 — look up team in RepoCatalog
  const catalogEntry = await repoCatalog.getByTeam(team.trim())
  if (!catalogEntry) {
    logger.warn('Team not found in catalog', { team })
    return NextResponse.json(
      { error: `Team "${team}" not found in the infrastructure catalog` },
      { status: 422 }
    )
  }
  logger.info('Request validated', { team, resourceType, targetEnvironments, projectId: catalogEntry.gitlabProjectId })

  // ── Guardia_Duplicado (infra-self-service-hardening, task 5.3) ──────────────
  //
  // Runs after auth + rate-limit + payload validation and BEFORE Generador_RDS
  // or InfraAgent. Fallthrough for `squad-*` resource types (Req 2.11) — those
  // never reach this point because they use the dedicated /api/squad-infra
  // routes and the payload gate above rejects them with 400, but we keep the
  // defensive skip so the intent is explicit.
  //
  // Gated behind ENABLE_INFRA_HARDENING_V1: when the flag is off the guard is
  // fully bypassed and the flow keeps the byte-exact baseline behaviour
  // (Req 7.3, ventana de convivencia del design).
  if (ENABLE_INFRA_HARDENING_V1 && !typedResourceType.startsWith('squad-')) {
    // Req 6.6 — s3/iam_role must not carry engine-family fields (RDS-only).
    if (typedResourceType === 's3' || typedResourceType === 'iam_role') {
      const hasEngineField =
        typedFields.engine !== undefined ||
        typedFields.engineVersion !== undefined ||
        typedFields.family !== undefined
      if (hasEngineField) {
        logger.warn('unexpected_engine_field', { resourceType: typedResourceType })
        return NextResponse.json({ code: 'unexpected_engine_field' }, { status: 422 })
      }
    }

    // Extract identifier by resource type (spec §5.3 mapping).
    const identifierRaw =
      typedResourceType === 'rds'
        ? typedFields.identifier
        : typedResourceType === 's3'
          ? typedFields.bucketName
          : typedFields.roleName

    // Req 2.8 — normalize (lowercase+trim) and validate the identifier charset.
    if (typeof identifierRaw !== 'string' || identifierRaw === '') {
      logger.warn('invalid_identifier_charset', { resourceType: typedResourceType, reason: 'missing_identifier' })
      return NextResponse.json({ code: 'invalid_identifier_charset' }, { status: 422 })
    }
    const idCheck = validateIdentifier(identifierRaw)
    if (!idCheck.ok) {
      logger.warn('invalid_identifier_charset', { resourceType: typedResourceType, raw: identifierRaw })
      return NextResponse.json({ code: 'invalid_identifier_charset' }, { status: 422 })
    }
    const identifier = idCheck.value

    // Compute filePath per resource type (spec §5.3):
    //   - rds       → iac/databases/<identifier>.tf   (per-resource file)
    //   - s3        → iac/s3/s3.tf                    (shared file; block lookup)
    //   - iam_role  → iac/roles/roles.tf              (shared file; block lookup)
    const filePath =
      typedResourceType === 'rds'
        ? `iac/databases/${identifier}.tf`
        : typedResourceType === 's3'
          ? 'iac/s3/s3.tf'
          : 'iac/roles/roles.tf'

    // Req 2.1/2.2/2.3 — HEAD-cached check against the team repo default branch.
    const dup = await checkDuplicate(
      catalogEntry.gitlabProjectId,
      catalogEntry.defaultBranch,
      filePath,
    )

    // Req 2.7 — transient failures (timeout / 5xx / network) → 503.
    if (dup.unavailable) {
      logger.warn('duplicate_check_unavailable', {
        detail: dup.unavailable.reason,
        filePath,
      })
      return NextResponse.json(
        { code: 'duplicate_check_unavailable', detail: dup.unavailable.reason },
        { status: 503 },
      )
    }

    // Req 2.4 — file exists: 409 for rds; for s3/iam_role additionally search
    // the shared file for the specific `resource "<awsType>" "<identifier>"`
    // block (Req 2.2/2.3). A file that exists but lacks the block is NOT a
    // duplicate and the flow continues.
    if (dup.exists) {
      let blockPresent = true
      if (typedResourceType === 's3' || typedResourceType === 'iam_role') {
        const awsBlockType = typedResourceType === 's3' ? 'aws_s3_bucket' : 'aws_iam_role'
        const content = await gitlabClient.getRepositoryFileRaw(
          catalogEntry.gitlabProjectId,
          filePath,
          catalogEntry.defaultBranch,
        )
        if (content === null) {
          blockPresent = false
        } else {
          const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const blockRegex = new RegExp(
            `resource\\s+"${awsBlockType}"\\s+"${escaped}"`,
          )
          blockPresent = blockRegex.test(content)
        }
      }

      if (blockPresent) {
        logger.warn('resource_exists', {
          resourceType: typedResourceType,
          identifier,
          filePath,
        })
        return NextResponse.json(
          {
            code: 'resource_exists',
            resourceType: typedResourceType,
            identifier,
            filePath,
            suggestion: 'modify',
          },
          { status: 409 },
        )
      }

      logger.info('shared_file_exists_block_absent', {
        resourceType: typedResourceType,
        identifier,
        filePath,
      })
    }
  }

  // ── Generador_De_Politica (iam-role-least-privilege, task 7.1) ──────────────
  //
  // When the iam_role request carries a structured `presetSelections` array
  // that is fully covered by the curated Catálogo_IAM, generate the HCL
  // deterministically (least-privilege IRSA pattern) WITHOUT invoking the
  // InfraAgent (Req 4.1). If any selected preset id is not in the catalog — or
  // no structured selections are provided (legacy free-text `permissions`
  // path) — the request falls through to the InfraAgent exactly as before
  // (Req 4.5). RDS keeps its own deterministic generator below; S3 keeps
  // flowing through the InfraAgent.
  if (typedResourceType === 'iam_role') {
    const rawSelections = (typedFields as { presetSelections?: unknown }).presetSelections
    const selections: PresetSelection[] = Array.isArray(rawSelections)
      ? (rawSelections as PresetSelection[])
      : []

    if (selections.length > 0 && isCoveredByCatalog(selections)) {
      // Req 7.4 — for the Tooling team the target environment is fixed to
      // `tooling` and non-editable; enforce it on the server regardless of the
      // client-supplied value.
      const effectiveEnvironments =
        team.trim().toLowerCase() === TOOLING_TEAM_SLUG
          ? ['tooling']
          : (targetEnvironments as string[])

      const input: GenerateIamRoleInput = {
        roleName: String((typedFields as { roleName?: unknown }).roleName ?? ''),
        namespace: String((typedFields as { namespace?: unknown }).namespace ?? ''),
        selections,
        targetEnvironments: effectiveEnvironments,
      }

      // Req 7.3 — roleName, namespace and target environments are mandatory.
      if (!validateRequiredRoleFields(input)) {
        logger.warn('IAM role required fields missing', {
          roleName: input.roleName,
          namespace: input.namespace,
          targetEnvironments: input.targetEnvironments,
        })
        return NextResponse.json(
          {
            error: 'roleName, namespace and targetEnvironments are required',
            code: 'missing_required_fields',
          },
          { status: 422 }
        )
      }

      const result = generateIamRoleHcl(input)
      if (!result.ok) {
        // Req 4.9 — unknown_preset / empty_selection / invalid_scope → 422 with detail.
        logger.warn('IAM role generation rejected', { code: result.code, detail: result.detail })
        return NextResponse.json({ error: result.detail, code: result.code }, { status: 422 })
      }

      const terraformPreview: TerraformPreview = {
        filePath: result.filePath,
        content: result.hcl,
        resourceType: 'iam_role',
        resourceName: input.roleName,
        targetEnvironments: effectiveEnvironments,
        // IAM roles/policies have no direct monthly AWS cost.
        estimatedCostMonthly: 0,
      }

      logger.info('IAM role preview generated (deterministic)', {
        filePath: terraformPreview.filePath,
        presets: selections.length,
        actionsCount: result.actionsCount,
      })
      logger.done('Generation complete')

      return NextResponse.json({
        terraformPreview,
        aiReply:
          `He generado de forma determinista el rol IAM IRSA "${input.roleName}" ` +
          `con ${selections.length} preset(s) de mínimo privilegio del catálogo, limitando ` +
          `las acciones y los recursos a lo seleccionado. Revisa el preview antes de enviar la solicitud.`,
      })
    }
    // Not covered by the catalog (or legacy free-text request): fall through to
    // the InfraAgent path below (Req 4.5).
  }

  // RDS creation is handled by the deterministic Generador_RDS (spec:
  // portal-rds-creation-improvement), not the AI InfraAgent. It validates
  // engine/version against the Catalogo_Versiones, introspects iac/databases/
  // read-only, and emits an extended TerraformPreview (primary .tf +
  // variables.tf + three tfvars). S3 and IAM keep flowing through InfraAgent.
  if (typedResourceType === 'rds') {
    const generator = new RdsGenerator()
    try {
      const result = await generator.generate({
        fields: typedFields as RdsFields,
        targetEnvironments: targetEnvironments as string[],
        projectId: catalogEntry.gitlabProjectId,
        defaultBranch: catalogEntry.defaultBranch,
        portalDefaultModuleVersion: PORTAL_DEFAULT_RDS_MODULE_VERSION,
      })

      if (!result.ok) {
        const status = RDS_ERROR_STATUS[result.code] ?? 422
        logger.warn('RDS generation rejected', { code: result.code, status })
        return NextResponse.json({ error: result.message, code: result.code }, { status })
      }

      logger.info('RDS preview generated', {
        filePath: result.preview.filePath,
        engine: result.preview.metadata?.engine,
        engineVersion: result.preview.metadata?.engineVersion,
      })
      logger.done('Generation complete')

      const engine = result.preview.metadata?.engine ?? 'postgres'
      const version = result.preview.metadata?.engineVersion ?? ''
      return NextResponse.json({
        terraformPreview: result.preview,
        aiReply:
          `He generado de forma determinista la RDS ${engine} ${version} ` +
          `"${result.preview.resourceName}" siguiendo la convención parametrizada del repositorio ` +
          `(variables.tf + vars/{dev,uat,pro}.tfvars). Revisa el preview antes de enviar la solicitud.`,
      })
    } catch (err) {
      logger.error('RDS generator error', { error: String(err) })
      return NextResponse.json(
        { error: 'Error generating Terraform. Please try again.' },
        { status: 500 }
      )
    }
  }

  const prompt = buildPrompt({
    resourceType: resourceType as ValidResourceType,
    fields: fields as ResourceFields,
    targetEnvironments: targetEnvironments as string[],
  })

  // Requirements 12.1, 12.2, 12.3 — create InfraAgent (model resolved from AWS_BEDROCK_MODEL_ID env var)
  const agent = new InfraAgent({
    projectId: catalogEntry.gitlabProjectId,
    defaultBranch: catalogEntry.defaultBranch,
    temperature: 0.2,
    maxTokens: 8000,
  })

  logger.info('Prompt built, calling InfraAgent', { promptLength: prompt.length })

  const requestorEmail = auth.session.user?.email ?? ''

  try {
    // Requirement 10.4, 6.4 — run agent with constructed prompt
    const result = await agent.run({
      message: prompt,
      history: [],
      team: team.trim(),
      projectId: catalogEntry.gitlabProjectId,
      defaultBranch: catalogEntry.defaultBranch,
      requestorEmail,
    })

    // Requirement 10.5 — return preview + reply on success
    // Requirement 10.6 — return null preview if agent completes without one
    if (!result.terraformPreview) {
      logger.warn('No terraform preview parsed', { replySnippet: result.reply.slice(0, 500) })
    } else {
      logger.info('Preview generated', { filePath: result.terraformPreview.filePath, resourceType: result.terraformPreview.resourceType })
    }

    logger.done('Generation complete')

    return NextResponse.json({
      terraformPreview: result.terraformPreview ?? null,
      aiReply: result.reply,
    })
  } catch (err) {
    // Requirement 10.7 — return 500 on unrecoverable agent errors
    logger.error('Agent error', { error: String(err) })
    return NextResponse.json(
      { error: 'Error generating Terraform. Please try again.' },
      { status: 500 }
    )
  }
}
