// POST /api/infra-request-v2/modify
// Reads an existing resource, applies modifications via AI, returns updated Terraform.
//
// Feature: infra-self-service-hardening — task 7.3
//
// Adds a deterministic (non-AI) operation `targetEnvironments` to the modify
// route's discriminated union. When the incoming body carries
// `operation: "targetEnvironments"` and the feature flag
// `ENABLE_INFRA_HARDENING_V1` is on, the request bypasses the AI path entirely
// and returns a byte-exact preview computed from `environments-parser.ts` +
// `render-rds.ts#upsertTfvarsEntriesMulti`. Flag off → the operation is
// declined with 422 `unsupported_operation`, keeping the baseline behaviour of
// `portal-prod v0.23.0-rc.1` untouched (Req 7.3).
//
// Contract for the new operation:
//   Payload:   { team, resourceType, identifier, operation: "targetEnvironments",
//                targetEnvironments: Env[] }
//   Responses:
//     200 { terraformPreview, aiReply, filePath, isModification: true,
//            warnings: Array<{ code, removedEnvironments, message }> }
//     400 { code: "missing_parameter" | "invalid_resource_type" |
//                 "invalid_target_environments" | "no_op_target_environments" }
//     404 { code: "team_not_found" | "resource_not_found" }
//     422 { code: "unsupported_operation" | "invalid_identifier_charset" |
//                 "environments_expression_not_parseable" |
//                 "missing_tfvars_file", environment? }
//     500 (unexpected)

import { NextResponse } from 'next/server'
import { requireUserAuth } from '@/lib/api-auth'
import { repoCatalog } from '@/lib/repo-catalog'
import { gitlabClient } from '@/lib/gitlab'
import { InfraAgent, type AuxiliaryFileOp, type TerraformPreview } from '@/lib/infra-agent'
import { verifyModifyScope } from '@/lib/resource-scope-verifier'
import { InfraLogger } from '@/lib/logger'
import { ENABLE_INFRA_HARDENING_V1 } from '@/lib/feature-flags'
import {
  parseEnvironmentsExpression,
  rewriteEnvironmentsExpression,
  normalizeTargetEnvironments,
  type Env,
} from '@/lib/infra/environments-parser'
import { validateIdentifier } from '@/lib/infra/duplicate-guard'
import {
  tfId,
  upsertTfvarsEntriesMulti,
  type TfvarsFileSpec,
} from '@/lib/rds/render-rds'
import {
  generateIamRoleHcl,
  parseRolePresetIds,
  applyRemoval,
  type PresetSelection,
} from '@/lib/iam-catalog/generator'
import {
  validateManagedPolicyArn,
  isRdsDataPlaneAction,
} from '@/lib/iam-catalog/validator'
import { getPresetById } from '@/lib/iam-catalog/catalog'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// ── Task 7.3 — deterministic `targetEnvironments` operation ─────────────────

type TargetEnvironmentsResourceType = 'rds' | 's3' | 'iam_role'

const TARGET_ENV_VALID_RESOURCE_TYPES: ReadonlySet<TargetEnvironmentsResourceType> =
  new Set(['rds', 's3', 'iam_role'])

/**
 * Canonical mapping Env → tfvars file (`prod` maps to `pro.tfvars`, matching
 * `ENV_TO_TFVARS` in `src/lib/rds/rds-generator.ts`). Only relevant for RDS
 * (S3 and IAM Role live in shared files without per-env tfvars).
 */
const RDS_TFVARS_PATH: Record<Env, string> = {
  dev: 'iac/databases/vars/dev.tfvars',
  uat: 'iac/databases/vars/uat.tfvars',
  prod: 'iac/databases/vars/pro.tfvars',
}

/** Resource-type → `.tf` file mapping (mirrors the Guardia_Duplicado & GET /modify/environments). */
function resolveFilePathFor(
  resourceType: TargetEnvironmentsResourceType,
  identifier: string,
): string {
  switch (resourceType) {
    case 'rds':
      return `iac/databases/${identifier}.tf`
    case 's3':
      return 'iac/s3/s3.tf'
    case 'iam_role':
      return 'iac/roles/roles.tf'
  }
}

function escapeRegexLiteral(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Extracts the body of the `resource "<awsType>" "<identifier>" { ... }` block
 * from a shared HCL file. Returns `{ scope, bodyStart, bodyEnd }` (byte
 * offsets into `hcl` for the block body, EXCLUSIVE of the surrounding
 * braces) or `null` when the block is absent. Balances `{`/`}` so nested
 * blocks (e.g. `lifecycle_rule { ... }`) are handled correctly.
 *
 * HCL string literals in practice never carry unescaped braces for the
 * identifiers we care about (bucket / role names, env values), so a simple
 * depth counter over the raw text is safe here.
 */
function extractResourceBlockRange(
  hcl: string,
  awsType: string,
  identifier: string,
): { scope: string; bodyStart: number; bodyEnd: number } | null {
  const header = new RegExp(
    `resource\\s+"${escapeRegexLiteral(awsType)}"\\s+"${escapeRegexLiteral(identifier)}"\\s*\\{`,
  )
  const match = header.exec(hcl)
  if (!match) return null
  const bodyStart = match.index + match[0].length
  let depth = 1
  for (let i = bodyStart; i < hcl.length; i++) {
    const ch = hcl.charCodeAt(i)
    if (ch === 0x7b /* { */) depth++
    else if (ch === 0x7d /* } */) {
      depth--
      if (depth === 0) {
        return { scope: hcl.slice(bodyStart, i), bodyStart, bodyEnd: i }
      }
    }
  }
  return null
}

/** Structural set equality over Env arrays. Order-insensitive. */
function envsEqualAsSet(a: readonly Env[], b: readonly Env[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set<Env>(a)
  for (const e of b) if (!set.has(e)) return false
  return true
}

/**
 * Parses every `${prefix}_<name> = <value>` entry out of a tfvars content and
 * returns them typed as strings (double-quoted) or bools (`true`/`false`).
 * Used to seed the ADD side of {@link upsertTfvarsEntriesMulti}: when the
 * caller adds a new env to an RDS, we lift the entries for `<prefix>_*` from
 * any current env's tfvars (they're identical across envs by construction —
 * see `render-rds.ts#triple`) and upsert them into the new env's tfvars.
 *
 * Total. Never throws.
 */
function extractIdentifierTfvarsEntries(
  content: string,
  identifierPrefix: string,
): Array<{ key: string; value: string; type: 'string' | 'bool' }> {
  if (typeof content !== 'string' || content.length === 0) return []
  if (typeof identifierPrefix !== 'string' || identifierPrefix.length === 0) return []
  const escaped = escapeRegexLiteral(identifierPrefix)
  const re = new RegExp(
    `^[ \\t]*(${escaped}_[A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.+?)[ \\t]*$`,
    'gm',
  )
  const out: Array<{ key: string; value: string; type: 'string' | 'bool' }> = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const key = m[1]
    if (seen.has(key)) continue // dedupe by key; keep first occurrence
    const rawValue = m[2].trim()
    const stringMatch = /^"([^"\\]*)"$/.exec(rawValue)
    if (stringMatch) {
      out.push({ key, value: stringMatch[1], type: 'string' })
      seen.add(key)
    } else if (rawValue === 'true' || rawValue === 'false') {
      out.push({ key, value: rawValue, type: 'bool' })
      seen.add(key)
    }
    // Any other shape (numeric, list, HCL object) is skipped — the render
    // module only ever emits typed string/bool for the five parameterized
    // variables, so this is exhaustive for our RDS convention.
  }
  return out
}

interface TargetEnvironmentsBody {
  team?: unknown
  resourceType?: unknown
  identifier?: unknown
  operation?: unknown
  targetEnvironments?: unknown
  /** Optional legacy alias — some callers may still send `resourceName`. */
  resourceName?: unknown
}

/**
 * Deterministic handler for the `operation: "targetEnvironments"` payload.
 * Purely computes the preview (no writes, no notifications, no DB updates).
 * Persistence of `payload.targetEnvironments` happens at submit time in
 * `POST /api/infra-assistant/submit`.
 *
 * Never throws — all failures are surfaced as structured JSON responses.
 */
async function handleTargetEnvironmentsOperation(
  body: TargetEnvironmentsBody,
  logger: InfraLogger,
  userEmail: string,
): Promise<NextResponse> {
  // Feature flag gate — flag off keeps the baseline behaviour byte-exact.
  if (!ENABLE_INFRA_HARDENING_V1) {
    return NextResponse.json({ code: 'unsupported_operation' }, { status: 422 })
  }

  const { team, resourceType, identifier, resourceName } = body

  // Payload shape: team, resourceType, identifier (or legacy resourceName).
  const teamStr = typeof team === 'string' ? team.trim() : ''
  const resourceTypeStr =
    typeof resourceType === 'string' ? resourceType.trim() : ''
  const identifierRaw =
    typeof identifier === 'string'
      ? identifier
      : typeof resourceName === 'string'
        ? resourceName
        : ''

  if (!teamStr || !resourceTypeStr || !identifierRaw) {
    return NextResponse.json({ code: 'missing_parameter' }, { status: 400 })
  }
  if (
    !TARGET_ENV_VALID_RESOURCE_TYPES.has(
      resourceTypeStr as TargetEnvironmentsResourceType,
    )
  ) {
    return NextResponse.json({ code: 'invalid_resource_type' }, { status: 400 })
  }
  const rt = resourceTypeStr as TargetEnvironmentsResourceType

  const idCheck = validateIdentifier(identifierRaw)
  if (!idCheck.ok) {
    return NextResponse.json(
      { code: 'invalid_identifier_charset' },
      { status: 422 },
    )
  }
  const id = idCheck.value

  // Req 4.1/4.2 — validate the payload envs (1-3 unique, canonical order).
  const target = normalizeTargetEnvironments(body.targetEnvironments)
  if (target === null) {
    return NextResponse.json(
      { code: 'invalid_target_environments' },
      { status: 400 },
    )
  }

  // Resolve repo (case-insensitive, per repoCatalog.getByTeam).
  const catalog = await repoCatalog.getByTeam(teamStr)
  if (!catalog) {
    logger.warn('team_not_found', { team: teamStr })
    return NextResponse.json({ code: 'team_not_found' }, { status: 404 })
  }
  const { gitlabProjectId: projectId, defaultBranch } = catalog

  // Read the current `.tf` from the source branch.
  const filePath = resolveFilePathFor(rt, id)
  const fileContent = await gitlabClient.getRepositoryFileRaw(
    projectId,
    filePath,
    defaultBranch,
  )
  if (fileContent === null) {
    return NextResponse.json({ code: 'resource_not_found' }, { status: 404 })
  }

  // Isolate the expression scope. For per-resource files (rds) that is the
  // whole file. For shared files (s3, iam_role) we splice the block body and
  // keep byte-exact offsets so the reassembled file is identical outside the
  // block (Req 4.5).
  let scope: string
  let scopeStart = 0
  let scopeEnd = fileContent.length
  if (rt === 'rds') {
    scope = fileContent
  } else {
    const awsType = rt === 's3' ? 'aws_s3_bucket' : 'aws_iam_role'
    const range = extractResourceBlockRange(fileContent, awsType, id)
    if (range === null) {
      return NextResponse.json({ code: 'resource_not_found' }, { status: 404 })
    }
    scope = range.scope
    scopeStart = range.bodyStart
    scopeEnd = range.bodyEnd
  }

  // Req 4.4 — the expression must be present in the canonical form.
  const parsed = parseEnvironmentsExpression(scope)
  if (!parsed.ok) {
    logger.warn('environments_expression_not_parseable', {
      team: teamStr,
      resourceType: rt,
      identifier: id,
      filePath,
    })
    return NextResponse.json(
      { code: 'environments_expression_not_parseable' },
      { status: 422 },
    )
  }
  const current = parsed.current

  // Req 4.7 — no-op guard.
  if (envsEqualAsSet(current, target)) {
    return NextResponse.json(
      { code: 'no_op_target_environments' },
      { status: 400 },
    )
  }

  const addedEnvs: Env[] = target.filter((e) => !current.includes(e))
  const removedEnvs: Env[] = current.filter((e) => !target.includes(e))

  // Req 4.8 — verify every target env has a tfvars file (RDS only).
  // For s3/iam_role there are no per-env tfvars.
  const tfvarsContents = new Map<Env, string | null>()
  if (rt === 'rds') {
    for (const env of target) {
      const varsPath = RDS_TFVARS_PATH[env]
      const varsContent = await gitlabClient.getRepositoryFileRaw(
        projectId,
        varsPath,
        defaultBranch,
      )
      if (varsContent === null) {
        logger.warn('missing_tfvars_file', {
          team: teamStr,
          resourceType: rt,
          identifier: id,
          environment: env,
          filePath: varsPath,
        })
        return NextResponse.json(
          { code: 'missing_tfvars_file', environment: env },
          { status: 422 },
        )
      }
      tfvarsContents.set(env, varsContent)
    }
    // Also load removed envs' tfvars (best-effort: absence just means nothing to strip).
    for (const env of removedEnvs) {
      if (tfvarsContents.has(env)) continue
      const varsPath = RDS_TFVARS_PATH[env]
      const varsContent = await gitlabClient.getRepositoryFileRaw(
        projectId,
        varsPath,
        defaultBranch,
      )
      tfvarsContents.set(env, varsContent)
    }
  }

  // Req 4.3/4.5 — rewrite the expression, byte-exact everywhere else.
  const newScope = rewriteEnvironmentsExpression(scope, target)
  const newFileContent =
    rt === 'rds'
      ? newScope
      : fileContent.slice(0, scopeStart) + newScope + fileContent.slice(scopeEnd)

  // Req 4.6 — for RDS, compute the tfvars diff (add for new envs, strip for
  // retired envs) using the multi orchestrator from render-rds.ts.
  let auxiliaryFiles: AuxiliaryFileOp[] = []
  if (rt === 'rds') {
    const dbPrefix = tfId(id)

    // Seed entries for ADDED envs from any current env's tfvars (values are
    // identical across envs by construction).
    let sourceEntries: Array<{ key: string; value: string; type: 'string' | 'bool' }> = []
    if (addedEnvs.length > 0 && current.length > 0) {
      // Load the source env's tfvars lazily (not already loaded above).
      const sourceEnv = current[0]
      let sourceContent = tfvarsContents.get(sourceEnv) ?? null
      if (sourceContent === null) {
        sourceContent = await gitlabClient.getRepositoryFileRaw(
          projectId,
          RDS_TFVARS_PATH[sourceEnv],
          defaultBranch,
        )
        tfvarsContents.set(sourceEnv, sourceContent)
      }
      sourceEntries = extractIdentifierTfvarsEntries(sourceContent ?? '', dbPrefix)
    }

    // Build per-env specs for every env that could change (target ∪ removed).
    const specs: TfvarsFileSpec[] = []
    const seenEnvs = new Set<Env>()
    for (const env of target) {
      seenEnvs.add(env)
      const isAdded = addedEnvs.includes(env)
      specs.push({
        env,
        filePath: RDS_TFVARS_PATH[env],
        currentContent: tfvarsContents.get(env) ?? null,
        entries: isAdded ? sourceEntries : [],
      })
    }
    for (const env of removedEnvs) {
      if (seenEnvs.has(env)) continue
      seenEnvs.add(env)
      specs.push({
        env,
        filePath: RDS_TFVARS_PATH[env],
        currentContent: tfvarsContents.get(env) ?? null,
        entries: [],
      })
    }

    const multi = upsertTfvarsEntriesMulti(specs, {
      removeEnvironments: removedEnvs,
      identifier: dbPrefix,
    })

    for (const f of multi.files) {
      // AuxiliaryFileOp has no "delete" variant. In practice the tfvars files
      // hold entries for many RDSes so they NEVER end up empty after stripping
      // one identifier's entries. If that ever happened we would need to
      // extend AuxiliaryFileOp; for now we drop the op and rely on the fact
      // that the tfvars file will still exist with the surviving entries.
      if (f.op === 'delete' || f.content === undefined) continue
      auxiliaryFiles.push({
        filePath: f.filePath,
        op: 'create',
        content: f.content,
      })
    }
  }

  // Req 4.9 — warning when retracting an active env.
  const warnings: Array<{
    code: 'environment_removal_warning'
    removedEnvironments: Env[]
    message: string
  }> = []
  if (removedEnvs.length > 0) {
    warnings.push({
      code: 'environment_removal_warning',
      removedEnvironments: removedEnvs,
      message:
        'El próximo terraform apply destruirá el recurso en estos entornos; verifica antes de aprobar.',
    })
  }

  const terraformPreview: TerraformPreview = {
    filePath,
    content: newFileContent,
    resourceType: rt,
    resourceName: id,
    targetEnvironments: target,
    estimatedCostMonthly: null,
    auxiliaryFiles,
  }

  logger.done('targetEnvironments preview complete', {
    team: teamStr,
    resourceType: rt,
    identifier: id,
    filePath,
    current,
    target,
    addedEnvs,
    removedEnvs,
    auxCount: auxiliaryFiles.length,
  })

  return NextResponse.json({
    terraformPreview,
    aiReply:
      `He aplicado de forma determinista el cambio de entornos "${current.join(', ')}" → ` +
      `"${target.join(', ')}" al recurso "${id}" (${rt}). Revisa el preview y los ` +
      `warnings antes de enviar la solicitud.`,
    filePath,
    isModification: true,
    warnings,
  })
}

// ── iam-role-least-privilege — task 8.1 — deterministic IAM modify ──────────
//
// When the caller opts into the discriminated IAM modification payload
// (`resourceType: "iam_role"` + `iamModify`), the route regenerates the role's
// HCL deterministically via the Catálogo_IAM + Generador_De_Politica — the
// InfraAgent is NOT involved (Req 6.6). Presets to add are merged with the
// presets already present in the current `.tf` (parsed round-trip via
// `parseRolePresetIds`) minus the ones selected to remove (`applyRemoval`,
// Req 6.2/6.7). Custom managed policy ARNs are each run through the
// Validador_IAM (`validateManagedPolicyArn`): only `Politica_Admin` ARNs are
// rejected (with the concrete rule), the rest are conserved (Req 6.5). Any
// modification that would grant RDS data-plane permissions is rejected with a
// 422 and creates no branch/MR (Req 6.8 — the modify route never touches Git
// anyway, so "no branch/MR" is satisfied by short-circuiting before any
// preview is produced).

/** Default shared roles file (mirrors the Generador_De_Politica output path). */
const IAM_ROLES_DEFAULT_FILE = 'iac/services/roles.tf'

interface IamModifySelection {
  addSelections?: unknown
  removePresetIds?: unknown
  addManagedArns?: unknown
}

interface IamModifyBody {
  team?: unknown
  resourceType?: unknown
  resourceName?: unknown
  filePath?: unknown
  namespace?: unknown
  targetEnvironments?: unknown
  operation?: unknown
  /** Nested selection (legacy/robustness shape). */
  iamModify?: IamModifySelection
  /** Top-level selection fields (actual client shape, `operation: "iamSelection"`). */
  addSelections?: unknown
  removePresetIds?: unknown
  addManagedArns?: unknown
}

/** Sanitizes a role name to a valid Terraform resource label (mirror of generator). */
function toIamResourceLabel(roleName: string): string {
  const cleaned = String(roleName).replace(/[^A-Za-z0-9_-]/g, '_')
  return cleaned.length > 0 ? cleaned : 'role'
}

/** Returns the full `resource "<awsType>" "<label>" { ... }` block range, or null. */
function extractFullResourceBlock(
  hcl: string,
  awsType: string,
  label: string,
): { start: number; end: number; text: string } | null {
  const header = new RegExp(
    `resource\\s+"${escapeRegexLiteral(awsType)}"\\s+"${escapeRegexLiteral(label)}"\\s*\\{`,
  )
  const m = header.exec(hcl)
  if (!m) return null
  const braceIdx = m.index + m[0].length - 1
  let depth = 0
  for (let j = braceIdx; j < hcl.length; j++) {
    const ch = hcl[j]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        return { start: m.index, end: j + 1, text: hcl.slice(m.index, j + 1) }
      }
    }
  }
  return null
}

/** Replaces the matching block in `content` with `newBlock`, or appends it. */
function replaceOrAppendBlock(
  content: string,
  awsType: string,
  label: string,
  newBlock: string,
): string {
  const existing = extractFullResourceBlock(content, awsType, label)
  if (existing) {
    return content.slice(0, existing.start) + newBlock + content.slice(existing.end)
  }
  return `${content.replace(/\s*$/, '')}\n\n${newBlock}\n`
}

/** Parses the target environments out of a role's `count` expression (defaults to all). */
function parseTargetEnvironmentsFromHcl(hcl: string): string[] {
  const m = /count\s*=\s*contains\(\[([^\]]*)\]\s*,\s*var\.environment\)/.exec(hcl)
  if (!m) return ['dev', 'uat', 'prod']
  const envs = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
  return envs.length > 0 ? envs : ['dev', 'uat', 'prod']
}

/** Parses the namespace out of the IRSA trust `templatefile(...)` block. */
function parseNamespaceFromHcl(hcl: string): string | null {
  const m = /NAMESPACE\s*=\s*"([^"]+)"/.exec(hcl)
  return m ? m[1] : null
}

/** Normalizes a raw `PresetSelection[]` payload, dropping malformed entries. */
function normalizePresetSelections(raw: unknown): PresetSelection[] {
  if (!Array.isArray(raw)) return []
  const out: PresetSelection[] = []
  for (const s of raw) {
    if (s == null || typeof s !== 'object') continue
    const presetId = (s as { presetId?: unknown }).presetId
    if (typeof presetId !== 'string' || presetId.trim() === '') continue
    const resourceArns = (s as { resourceArns?: unknown }).resourceArns
    out.push({
      presetId,
      resourceArns: Array.isArray(resourceArns)
        ? resourceArns.filter((a): a is string => typeof a === 'string')
        : undefined,
    })
  }
  return out
}

async function handleIamModifyOperation(
  body: IamModifyBody,
  logger: InfraLogger,
): Promise<NextResponse> {
  const teamStr = typeof body.team === 'string' ? body.team.trim() : ''
  const resourceName =
    typeof body.resourceName === 'string' ? body.resourceName.trim() : ''
  if (!teamStr || !resourceName) {
    return NextResponse.json({ code: 'missing_parameter' }, { status: 400 })
  }

  const filePath =
    typeof body.filePath === 'string' && body.filePath.trim() !== ''
      ? body.filePath.trim()
      : IAM_ROLES_DEFAULT_FILE

  const sel = body.iamModify ?? {}
  // The selection fields may arrive either TOP-LEVEL (actual client shape under
  // `operation: "iamSelection"`) or nested under `iamModify` (legacy/robustness
  // shape). Prefer whichever is present; top-level wins when both exist.
  const rawAddSelections = body.addSelections ?? sel.addSelections
  const rawRemovePresetIds = body.removePresetIds ?? sel.removePresetIds
  const rawAddManagedArns = body.addManagedArns ?? sel.addManagedArns
  const addSelections = normalizePresetSelections(rawAddSelections)
  const removePresetIds = Array.isArray(rawRemovePresetIds)
    ? rawRemovePresetIds.filter((x): x is string => typeof x === 'string')
    : []
  const addManagedArns = Array.isArray(rawAddManagedArns)
    ? rawAddManagedArns.filter((x): x is string => typeof x === 'string')
    : []

  // Resolve repo (case-insensitive, per repoCatalog.getByTeam).
  const catalog = await repoCatalog.getByTeam(teamStr)
  if (!catalog) {
    logger.warn('team_not_found', { team: teamStr })
    return NextResponse.json({ code: 'team_not_found' }, { status: 404 })
  }
  const { gitlabProjectId: projectId, defaultBranch } = catalog

  // Read the current shared roles `.tf` from the source branch.
  const currentContent = await gitlabClient.getRepositoryFileRaw(
    projectId,
    filePath,
    defaultBranch,
  )
  if (currentContent === null) {
    return NextResponse.json({ code: 'resource_not_found' }, { status: 404 })
  }

  // Req 6.2/6.7 — parse the current preset ids and apply the removal complement.
  const currentPresetIds = parseRolePresetIds(currentContent)
  const keptPresetIds = applyRemoval(currentPresetIds, removePresetIds)

  // Merge kept presets (default scope — the round-trip only recovers ids) with
  // the presets to add. `addSelections` win on ARN scope for a shared preset id.
  const addById = new Map<string, PresetSelection>()
  for (const s of addSelections) addById.set(s.presetId, s)
  const finalSelections: PresetSelection[] = []
  const seen = new Set<string>()
  for (const id of keptPresetIds) {
    if (seen.has(id)) continue
    seen.add(id)
    finalSelections.push(addById.get(id) ?? { presetId: id })
  }
  for (const s of addSelections) {
    if (seen.has(s.presetId)) continue
    seen.add(s.presetId)
    finalSelections.push(s)
  }

  // Req 6.8 — reject any modification that would grant RDS data-plane
  // permissions, before producing any preview (⇒ no branch/MR is created).
  for (const s of finalSelections) {
    const preset = getPresetById(s.presetId)
    if (!preset) continue
    if (preset.actions.some((a) => isRdsDataPlaneAction(a))) {
      logger.warn('rds_data_plane_not_allowed', {
        team: teamStr,
        resourceName,
        presetId: s.presetId,
      })
      return NextResponse.json(
        { code: 'rds_data_plane_not_allowed', detail: `Preset ${s.presetId} grants RDS data-plane access` },
        { status: 422 },
      )
    }
  }

  // Req 6.4/6.5 — partition custom managed policy ARNs by the Validador_IAM
  // verdict: reject ONLY the Politica_Admin ones (with the concrete rule),
  // conserve the rest.
  const acceptedManagedArns: string[] = []
  const rejectedManagedArns: Array<{ arn: string; rule?: string; detail?: string }> = []
  for (const arn of addManagedArns) {
    const verdict = validateManagedPolicyArn(arn)
    if (verdict.verdict === 'Politica_Admin') {
      rejectedManagedArns.push({ arn, rule: verdict.rule, detail: verdict.detail })
    } else {
      acceptedManagedArns.push(arn)
    }
  }

  // Resolve namespace + target environments (payload wins, else parse the
  // current HCL, else sensible defaults).
  const namespace =
    typeof body.namespace === 'string' && body.namespace.trim() !== ''
      ? body.namespace.trim()
      : parseNamespaceFromHcl(currentContent) ?? ''
  const targetEnvironments =
    Array.isArray(body.targetEnvironments) &&
    body.targetEnvironments.some((e) => typeof e === 'string' && e.trim() !== '')
      ? (body.targetEnvironments as unknown[]).filter(
          (e): e is string => typeof e === 'string' && e.trim() !== '',
        )
      : parseTargetEnvironmentsFromHcl(currentContent)

  if (namespace === '') {
    return NextResponse.json({ code: 'missing_required_fields' }, { status: 422 })
  }

  // Req 6.6/6.7 — deterministic HCL from the Generador_De_Politica (no InfraAgent).
  const gen = generateIamRoleHcl({
    roleName: resourceName,
    namespace,
    selections: finalSelections,
    targetEnvironments,
  })
  if (!gen.ok) {
    logger.warn('iam_generation_rejected', {
      team: teamStr,
      resourceName,
      code: gen.code,
      detail: gen.detail,
    })
    return NextResponse.json({ code: gen.code, detail: gen.detail }, { status: 422 })
  }

  // Merge the regenerated role/policy/attachment blocks into the shared file,
  // preserving every other resource byte-for-byte.
  const label = toIamResourceLabel(resourceName)
  let mergedContent = currentContent
  for (const awsType of ['aws_iam_role', 'aws_iam_policy', 'aws_iam_role_policy_attachment']) {
    const block = extractFullResourceBlock(gen.hcl, awsType, label)
    if (block) {
      mergedContent = replaceOrAppendBlock(mergedContent, awsType, label, block.text)
    }
  }

  // Append attachment blocks for the accepted custom managed ARNs (deterministic
  // order). Their labels are prefixed with the role label so they remain in
  // scope for verifyModifyScope.
  const hasCount = /\n\s*count\s*=/.test(gen.hcl)
  const indexSuffix = hasCount ? '[0]' : ''
  const sortedManagedArns = [...acceptedManagedArns].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  sortedManagedArns.forEach((arn, i) => {
    const attLabel = `${label}_managed_${i + 1}`
    const block = [
      `resource "aws_iam_role_policy_attachment" "${attLabel}" {`,
      hasCount ? '  count = contains([' +
        targetEnvironments.map((e) => JSON.stringify(e)).join(', ') +
        '], var.environment) ? 1 : 0' : null,
      `  role       = aws_iam_role.${label}${indexSuffix}.name`,
      `  policy_arn = ${JSON.stringify(arn)}`,
      `}`,
    ]
      .filter((l): l is string => l !== null)
      .join('\n')
    mergedContent = replaceOrAppendBlock(
      mergedContent,
      'aws_iam_role_policy_attachment',
      attLabel,
      block,
    )
  })

  // Gotcha §9 — verifyModifyScope receives the string HCL (not the object).
  const scopeCheck = verifyModifyScope(currentContent, mergedContent, label)
  if (!scopeCheck.valid) {
    logger.warn('iam_scope_violation', {
      team: teamStr,
      resourceName,
      unexpectedChanges: scopeCheck.unexpectedChanges,
    })
    return NextResponse.json(
      {
        code: 'scope_violation',
        error:
          'Modification scope violation: the deterministic modification would change resources outside the target role',
        unexpectedChanges: scopeCheck.unexpectedChanges,
      },
      { status: 422 },
    )
  }

  const terraformPreview: TerraformPreview = {
    filePath,
    content: mergedContent,
    resourceType: 'iam_role',
    resourceName,
    targetEnvironments,
    estimatedCostMonthly: null,
  }

  logger.done('IAM modify preview complete', {
    team: teamStr,
    resourceName,
    filePath,
    keptPresetIds,
    added: addSelections.map((s) => s.presetId),
    removed: removePresetIds,
    acceptedManagedArns: acceptedManagedArns.length,
    rejectedManagedArns: rejectedManagedArns.length,
  })

  return NextResponse.json({
    terraformPreview,
    aiReply:
      `He aplicado de forma determinista la modificación de permisos del rol "${resourceName}" ` +
      `usando el catálogo de presets (sin agente IA). Revisa el preview antes de enviar la solicitud.`,
    filePath,
    isModification: true,
    managedArns: { accepted: acceptedManagedArns, rejected: rejectedManagedArns },
  })
}

export async function POST(request: Request) {
  const auth = await requireUserAuth(request)
  if (auth.error) return auth.error

  const userEmail = auth.session.user?.email ?? 'unknown'
  const logger = new InfraLogger('modify', userEmail)
  logger.info('Request received')

  const body = await request.json()

  // ── Task 7.3 — deterministic dispatch ─────────────────────────────────────
  // When the caller opts into the discriminated `operation: "targetEnvironments"`
  // payload, we skip the AI path entirely and compute the preview from the pure
  // environments-parser + render-rds helpers. Any other body keeps the existing
  // AI-driven flow (byte-exact to portal-prod v0.23.0-rc.1).
  if (
    body &&
    typeof body === 'object' &&
    (body as { operation?: unknown }).operation === 'targetEnvironments'
  ) {
    return handleTargetEnvironmentsOperation(
      body as TargetEnvironmentsBody,
      logger,
      userEmail,
    )
  }

  // ── iam-role-least-privilege — task 8.1 — deterministic IAM modify dispatch ─
  // When the caller sends an IAM-role selection modification, regenerate the
  // role HCL deterministically from the Catálogo_IAM (no InfraAgent). Any other
  // body keeps the existing AI-driven modify flow untouched.
  //
  // The client (modify-infra-form.tsx#submitIamModification) sends the
  // selection fields TOP-LEVEL under `operation: "iamSelection"`
  // (`{ ..., operation, addSelections, removePresetIds, addManagedArns }`).
  // For robustness we also accept the legacy nested `iamModify` object shape.
  // Trigger on `resourceType === 'iam_role'` AND (`operation === 'iamSelection'`
  // OR a present `iamModify` object).
  if (
    body &&
    typeof body === 'object' &&
    (body as { resourceType?: unknown }).resourceType === 'iam_role' &&
    ((body as { operation?: unknown }).operation === 'iamSelection' ||
      (typeof (body as { iamModify?: unknown }).iamModify === 'object' &&
        (body as { iamModify?: unknown }).iamModify != null))
  ) {
    return handleIamModifyOperation(body as IamModifyBody, logger)
  }

  const { team, resourceType, resourceName, filePath, modifications } = body as {
    team: string
    resourceType: string
    resourceName: string
    filePath: string
    modifications: {
      targetEnvironments?: string[]
      // RDS
      instanceClass?: string
      storageGb?: number
      maxStorageGb?: number
      multiAz?: boolean
      engineVersion?: string
      backupRetentionDays?: number
      performanceInsights?: boolean
      // IAM
      addPermissions?: string[]
      removePermissions?: string[]
      // S3
      versioning?: boolean
      lifecycleRules?: {
        expirationDays?: number
        transitions?: Array<{ days: number; storageClass: string }>
      }
    }
  }

  if (!team || !resourceType || !resourceName || !filePath || !modifications) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const catalog = await repoCatalog.getByTeam(team)
  if (!catalog) {
    return NextResponse.json({ error: `Team "${team}" not found` }, { status: 422 })
  }

  const { gitlabProjectId: projectId, defaultBranch } = catalog

  // Read the current file content
  const currentContent = await gitlabClient.getRepositoryFileRaw(projectId, filePath, defaultBranch)
  if (!currentContent) {
    return NextResponse.json({ error: `File "${filePath}" not found` }, { status: 404 })
  }

  // Safety guards for irreversible/destructive RDS changes (apply cabeza):
  //  - allocated_storage can only grow (RDS forbids shrinking).
  //  - engine_version can only move forward (downgrade is impossible in PG).
  if (resourceType === 'rds') {
    if (modifications.storageGb !== undefined) {
      const m = currentContent.match(/allocated_storage\s*=\s*(?:var\.environment[^?]*\?\s*(\d+)\s*:\s*(\d+)|(\d+))/)
      // Pick the smallest current value present (covers ternary prod/non-prod).
      const nums = m ? [m[1], m[2], m[3]].filter(Boolean).map(Number) : []
      const currentMin = nums.length ? Math.min(...nums) : null
      if (currentMin !== null && modifications.storageGb < currentMin) {
        return NextResponse.json(
          { error: `No se puede reducir el almacenamiento de una RDS. Actual mínimo: ${currentMin} GB, solicitado: ${modifications.storageGb} GB.` },
          { status: 422 }
        )
      }
    }
    if (modifications.maxStorageGb !== undefined && modifications.storageGb !== undefined &&
        modifications.maxStorageGb < modifications.storageGb) {
      return NextResponse.json(
        { error: `max_allocated_storage (${modifications.maxStorageGb}) debe ser >= allocated_storage (${modifications.storageGb}).` },
        { status: 422 }
      )
    }
    if (modifications.engineVersion) {
      const m = currentContent.match(/engine_version\s*=\s*"?(\d+)/)
      const currentMajor = m ? Number(m[1]) : null
      const requestedMajor = Number(modifications.engineVersion)
      if (currentMajor !== null && requestedMajor < currentMajor) {
        return NextResponse.json(
          { error: `No se puede bajar la versión de PostgreSQL. Actual: ${currentMajor}, solicitada: ${requestedMajor}.` },
          { status: 422 }
        )
      }
    }
  }

  // Build the modification prompt
  const modDescriptions: string[] = []
  if (modifications.targetEnvironments) {
    const allEnvs = ['dev', 'uat', 'prod']
    const hasAll = allEnvs.every(e => modifications.targetEnvironments!.includes(e))
    if (hasAll) {
      modDescriptions.push('Eliminar el count condicional — el recurso debe desplegarse en TODOS los entornos (dev, uat, prod)')
    } else {
      const envList = modifications.targetEnvironments.map(e => `"${e}"`).join(', ')
      modDescriptions.push(`Cambiar los entornos a SOLO: ${modifications.targetEnvironments.join(', ')}. Usar count = contains([${envList}], var.environment) ? 1 : 0`)
    }
  }
  if (modifications.instanceClass) {
    modDescriptions.push(`Cambiar la clase de instancia a: ${modifications.instanceClass}. Si el valor actual usa un patrón ternario por entorno (var.environment == "prod" ? X : Y), mantén el patrón ternario y cambia el valor que corresponda preservando el resto.`)
  }
  if (modifications.storageGb !== undefined) {
    modDescriptions.push(`Cambiar allocated_storage a: ${modifications.storageGb} GB. AVISO: en RDS el almacenamiento solo puede AMPLIARSE, nunca reducirse. Si hay patrón ternario por entorno, mantenlo. allocated_storage no puede ser mayor que max_allocated_storage.`)
  }
  if (modifications.maxStorageGb !== undefined) {
    modDescriptions.push(`Cambiar max_allocated_storage (autoscaling de almacenamiento) a: ${modifications.maxStorageGb} GB. Debe ser >= allocated_storage. Si el recurso no tiene max_allocated_storage, añádelo.`)
  }
  if (modifications.multiAz !== undefined) {
    modDescriptions.push(`Cambiar Multi-AZ a: ${modifications.multiAz ? 'habilitado (true)' : 'deshabilitado (false)'}. Si hay patrón ternario por entorno (var.environment == "prod" ? true : false), reemplázalo por el valor fijo solicitado.`)
  }
  if (modifications.engineVersion) {
    modDescriptions.push(`Cambiar engine_version a: "${modifications.engineVersion}" y family a "postgres${modifications.engineVersion}". AVISO: el upgrade de versión de PostgreSQL es irreversible y puede requerir downtime. Solo se permite subir de versión, nunca bajar.`)
  }
  if (modifications.backupRetentionDays !== undefined) {
    modDescriptions.push(`Cambiar backup_retention_period a: ${modifications.backupRetentionDays} días.`)
  }
  if (modifications.performanceInsights !== undefined) {
    modDescriptions.push(`Cambiar performance_insights_enabled a: ${modifications.performanceInsights ? 'habilitado (true)' : 'deshabilitado (false)'}. Mantén el patrón ternario por entorno si existe.`)
  }
  if (modifications.versioning !== undefined) {
    modDescriptions.push(`Cambiar el versionado del bucket S3 a: ${modifications.versioning ? 'habilitado (Enabled)' : 'suspendido (Suspended)'}. Usar el bloque aws_s3_bucket_versioning o versioning según el patrón del archivo.`)
  }
  if (modifications.addPermissions && modifications.addPermissions.length > 0) {
    const policies = modifications.addPermissions.map(p => `"${p}"`).join(', ')
    modDescriptions.push(`Añadir las siguientes políticas/permisos IAM al rol: ${policies}. Crear aws_iam_role_policy_attachment resources para cada política añadida.`)
  }
  if (modifications.removePermissions && modifications.removePermissions.length > 0) {
    const policies = modifications.removePermissions.map(p => `"${p}"`).join(', ')
    modDescriptions.push(`Eliminar las siguientes políticas/permisos IAM del rol: ${policies}. Eliminar los aws_iam_role_policy_attachment resources correspondientes.`)
  }
  if (modifications.lifecycleRules) {
    const { expirationDays, transitions } = modifications.lifecycleRules
    const parts: string[] = []
    if (expirationDays !== undefined) {
      parts.push(`expiración de objetos a los ${expirationDays} días`)
    }
    if (transitions && transitions.length > 0) {
      const transDesc = transitions.map(t => `transición a ${t.storageClass} después de ${t.days} días`).join(', ')
      parts.push(transDesc)
    }
    modDescriptions.push(`Añadir/actualizar reglas de ciclo de vida (lifecycle_rule) en el bucket S3: ${parts.join('; ')}. Usar un bloque lifecycle_rule con las configuraciones especificadas.`)
  }

  const prompt = `Necesito MODIFICAR un recurso existente en el archivo "${filePath}".

El recurso a modificar es: ${resourceName} (tipo: ${resourceType})

CONTENIDO ACTUAL DEL ARCHIVO:
\`\`\`hcl
${currentContent}
\`\`\`

MODIFICACIONES REQUERIDAS:
${modDescriptions.map((d, i) => `${i + 1}. ${d}`).join('\n')}

INSTRUCCIONES:
1. Devuelve el archivo COMPLETO con las modificaciones aplicadas.
2. Solo modifica el recurso "${resourceName}" y sus recursos relacionados (subnet_group, security_group, policy_attachment).
3. NO modifiques otros recursos del archivo.
4. Mantén EXACTAMENTE el mismo formato, comentarios y estructura del archivo original.
5. Si cambias los entornos y el recurso tiene count, actualiza el count en TODOS los resources relacionados.
6. Si el recurso no tenía count y ahora necesita uno, añádelo. Si tenía count y ahora va a todos los entornos, quítalo.`

  // Model resolved from AWS_BEDROCK_MODEL_ID env var (Requirement 7.4)
  const agent = new InfraAgent({
    projectId,
    defaultBranch,
    temperature: 0.1,
    maxTokens: 8000,
  })

  try {
    const result = await agent.run({
      message: prompt,
      history: [],
      team,
      projectId,
      defaultBranch,
      requestorEmail: auth.session.user?.email ?? '',
    })

    if (!result.terraformPreview) {
      logger.warn('No preview parsed', { replySnippet: result.reply.slice(0, 300) })
    }

    // Scope verification: ensure only target resource and related resources were changed
    if (result.terraformPreview) {
      const scopeCheck = verifyModifyScope(currentContent, result.terraformPreview.content, resourceName)

      if (!scopeCheck.valid) {
        // Retry once with explicit "only modify target" instruction
        logger.warn('Scope violation detected, retrying with stricter prompt', { unexpectedChanges: scopeCheck.unexpectedChanges })

        const retryPrompt = `${prompt}

IMPORTANTE: En tu respuesta anterior modificaste recursos que NO debías tocar: ${scopeCheck.unexpectedChanges.join(', ')}.
SOLO debes modificar el recurso "${resourceName}" y sus recursos directamente relacionados (que empiecen con "${resourceName}" en su nombre).
NO modifiques, añadas ni elimines ningún otro recurso.`

        const retryResult = await agent.run({
          message: retryPrompt,
          history: [],
          team,
          projectId,
          defaultBranch,
          requestorEmail: auth.session.user?.email ?? '',
        })

        if (retryResult.terraformPreview) {
          const retryScope = verifyModifyScope(currentContent, retryResult.terraformPreview.content, resourceName)

          if (!retryScope.valid) {
            // Retry also failed — return 422 with list of unexpectedly changed resources
            return NextResponse.json({
              error: 'Modification scope violation: AI modified resources outside the target scope',
              unexpectedChanges: retryScope.unexpectedChanges,
            }, { status: 422 })
          }
        }

        // Retry succeeded or no preview in retry
        return NextResponse.json({
          terraformPreview: retryResult.terraformPreview ?? null,
          aiReply: retryResult.reply,
          filePath,
          isModification: true,
        })
      }
    }

    logger.done('Modification complete', { filePath, resourceName })

    return NextResponse.json({
      terraformPreview: result.terraformPreview ?? null,
      aiReply: result.reply,
      filePath,
      isModification: true,
    })
  } catch (err) {
    logger.error('Modification error', { error: String(err) })
    return NextResponse.json({ error: 'Error generating modification' }, { status: 500 })
  }
}
