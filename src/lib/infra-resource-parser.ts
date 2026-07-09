/**
 * Parses Terraform .tf files to extract resource names and basic config.
 * Used by the "modify infrastructure" flow to list existing resources.
 */

import { parseRolePresetIds } from './iam-catalog/generator'

export interface ParsedResource {
  name: string           // human-readable name (e.g. "lastmilesservices", "ads_bucket")
  terraformId: string    // terraform resource/module id (e.g. "module.lastmilesservices_rds_postgres")
  type: 'rds' | 's3' | 'iam_role'
  filePath: string       // e.g. "iac/databases/ultimamilla.tf"
  environments?: string[] // parsed from count = contains([...], var.environment)
  /**
   * IAM only (feature: iam-role-least-privilege, Req 6.2). Catalog preset ids
   * present in the role's current `aws_iam_policy` (derived from the policy
   * Sids via `parseRolePresetIds`). Feeds the "quitar permisos" section of the
   * modify form so the user can deselect current presets. `undefined` when the
   * role's policy carries no recognised catalog preset (e.g. a hand-written or
   * legacy policy).
   */
  presetIds?: string[]
}

/** Escapes a string for safe interpolation inside a RegExp source. */
function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Parse RDS resources from the databases directory.
 * Each .tf file (except backend.tf, provider.tf, variables.tf, identifiers.tf, rbac.tf) is a service.
 */
export function parseRdsResources(files: { path: string; content: string }[]): ParsedResource[] {
  const skip = ['backend.tf', 'provider.tf', 'variables.tf', 'identifiers.tf', 'rbac.tf']
  const results: ParsedResource[] = []

  for (const file of files) {
    const fileName = file.path.split('/').pop() || ''
    if (skip.includes(fileName)) continue

    // Find module "xxx_rds_postgres" blocks
    const moduleRe = /module\s+"([^"]+)"/g
    let match
    while ((match = moduleRe.exec(file.content)) !== null) {
      const moduleName = match[1]
      const envs = parseEnvironments(file.content, match.index)
      const friendlyName = moduleName.replace(/_rds_postgres$/, '').replace(/_/g, '-')

      results.push({
        name: friendlyName,
        terraformId: `module.${moduleName}`,
        type: 'rds',
        filePath: file.path,
        environments: envs,
      })
    }
  }

  return results
}

/**
 * Parse S3 resources from a single s3.tf file.
 */
export function parseS3Resources(filePath: string, content: string): ParsedResource[] {
  const results: ParsedResource[] = []
  const bucketRe = /resource\s+"aws_s3_bucket"\s+"([^"]+)"/g
  let match

  while ((match = bucketRe.exec(content)) !== null) {
    const resourceName = match[1]
    const envs = parseEnvironments(content, match.index)

    // Extract bucket name from the block
    const blockStart = content.indexOf('{', match.index)
    const blockContent = extractBlock(content, blockStart)
    const bucketNameMatch = blockContent.match(/bucket\s*=\s*"([^"]*)"/)
    const displayName = bucketNameMatch ? bucketNameMatch[1].replace(/\$\{var\.environment\}/, '*') : resourceName

    results.push({
      name: displayName,
      terraformId: `aws_s3_bucket.${resourceName}`,
      type: 's3',
      filePath,
      environments: envs,
    })
  }

  return results
}

/**
 * Parse IAM Role resources from roles.tf.
 * Skips commented-out resources.
 */
export function parseIamRoleResources(filePath: string, content: string): ParsedResource[] {
  const results: ParsedResource[] = []
  const roleRe = /^resource\s+"aws_iam_role"\s+"([^"]+)"/gm
  let match

  while ((match = roleRe.exec(content)) !== null) {
    // Skip if the line before is a comment
    const lineStart = content.lastIndexOf('\n', match.index) + 1
    const prefix = content.slice(lineStart, match.index).trim()
    if (prefix.startsWith('#')) continue

    const resourceName = match[1]
    const envs = parseEnvironments(content, match.index)

    // Extract the "name" attribute from the block
    const blockStart = content.indexOf('{', match.index)
    const blockContent = extractBlock(content, blockStart)
    const nameMatch = blockContent.match(/name\s*=\s*"([^"]*)"/)
    const displayName = nameMatch ? nameMatch[1] : resourceName

    // Derive the catalog preset ids from the role's policy (Req 6.2). The
    // generator emits the role, policy and attachment with the SAME terraform
    // label, so we isolate `aws_iam_policy "<label>"` and parse its Sids. A
    // legacy/hand-written policy simply yields no recognised presets.
    const policyRe = new RegExp(`resource\\s+"aws_iam_policy"\\s+"${escapeRegExp(resourceName)}"`)
    const policyMatch = policyRe.exec(content)
    let presetIds: string[] | undefined
    if (policyMatch) {
      const policyBlock = extractBlock(content, content.indexOf('{', policyMatch.index))
      const ids = parseRolePresetIds(policyBlock)
      if (ids.length > 0) presetIds = ids
    }

    results.push({
      name: displayName,
      terraformId: `aws_iam_role.${resourceName}`,
      type: 'iam_role',
      filePath,
      environments: envs,
      presetIds,
    })
  }

  return results
}

/**
 * Parse environments from a count = contains([...], var.environment) pattern near a resource.
 * Returns null if no count (means all environments).
 */
function parseEnvironments(content: string, nearIndex: number): string[] | undefined {
  // Look for count = contains([...], var.environment) within 500 chars after the resource declaration
  const searchArea = content.slice(nearIndex, nearIndex + 800)
  const countMatch = searchArea.match(/count\s*=\s*contains\(\[([^\]]+)\],\s*var\.environment\)/)
  if (countMatch) {
    const envList = countMatch[1]
    return envList.match(/"([^"]+)"/g)?.map(e => e.replace(/"/g, '')) || []
  }

  // Also check for count = var.environment == "xxx" ? 1 : 0
  const ternaryMatch = searchArea.match(/count\s*=\s*var\.environment\s*==\s*"([^"]+)"\s*\?\s*(\d+)\s*:\s*(\d+)/)
  if (ternaryMatch) {
    const env = ternaryMatch[1]
    const ifTrue = parseInt(ternaryMatch[2])
    const ifFalse = parseInt(ternaryMatch[3])
    if (ifTrue === 1 && ifFalse === 0) return [env]
    if (ifTrue === 0 && ifFalse === 1) {
      // Inverted: all EXCEPT this env
      return ['dev', 'uat', 'prod'].filter(e => e !== env)
    }
  }

  // Check for count = var.environment != "xxx" ? 1 : 0
  const notMatch = searchArea.match(/count\s*=\s*var\.environment\s*!=\s*"([^"]+)"\s*\?\s*1\s*:\s*0/)
  if (notMatch) {
    return ['dev', 'uat', 'prod'].filter(e => e !== notMatch[1])
  }

  return undefined // no count = all environments
}

/**
 * Extract a {} block starting at the given index.
 */
function extractBlock(content: string, openBraceIndex: number): string {
  let depth = 0
  let i = openBraceIndex
  for (; i < content.length; i++) {
    if (content[i] === '{') depth++
    if (content[i] === '}') {
      depth--
      if (depth === 0) return content.slice(openBraceIndex, i + 1)
    }
  }
  return content.slice(openBraceIndex, Math.min(openBraceIndex + 2000, content.length))
}
