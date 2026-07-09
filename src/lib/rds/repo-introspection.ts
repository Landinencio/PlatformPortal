// Read-only introspection of a Repositorio_Destino's `iac/databases/` directory.
//
// Part of the deterministic Generador_RDS (spec: portal-rds-creation-improvement).
// This module extracts the conventions in use by the target repository so the
// generator can reproduce them:
//   - the RDS module version actually used (R4.2/R4.3),
//   - which `<db>_`-prefixed variables already exist in `variables.tf` (R3.2),
//   - whether the multi-environment `count = contains([...], var.environment)`
//     pattern is present (R6.3),
//   - whether `iac/databases/` exists and is readable at all (R3.5).
//
// It NEVER throws on missing files or read failures; it signals those states
// through the returned flags so the caller can degrade gracefully.

import type { gitlabClient } from '../gitlab'
import { extractNetworkWiring, type NetworkWiring } from './network-extractor'

const DATABASES_DIR = 'iac/databases'
const VARIABLES_FILE = `${DATABASES_DIR}/variables.tf`
const RDS_MODULE_SOURCE = 'terraform-aws-modules/rds/aws'

export interface RepoRdsConvention {
  /** Version_Modulo seleccionada según R4.2/R4.3 (más frecuente, empate→mayor semver). */
  moduleVersion: string | null
  /** Nombres de variables ya declaradas en iac/databases/variables.tf (con prefijo incluido). */
  existingVariables: Set<string>
  /** Plantilla del patrón count vigente, p.ej. count = contains([...], var.environment) ? 1 : 0. */
  countPatternFound: boolean
  /** true si iac/databases/ existe y es legible (R3.5). */
  databasesDirReadable: boolean
  /**
   * Cableado de red (VPC/subnets/SG) descubierto de las RDS existentes del repo
   * destino (SRE-001). `null` cuando ninguna RDS existente tiene un cableado
   * completo — el generador lo trata como fail-safe y BLOQUEA la generación
   * para no crear la base de datos en el VPC por defecto.
   */
  networkWiring: NetworkWiring | null
}

/**
 * Extracts the bodies (including the outermost braces) of every `module "..." {}`
 * block found in the given Terraform content, using brace matching so nested
 * blocks are kept together.
 */
function extractModuleBlocks(content: string): string[] {
  const blocks: string[] = []
  const header = /module\s+"[^"]*"\s*\{/g
  let match: RegExpExecArray | null

  while ((match = header.exec(content)) !== null) {
    const openBrace = match.index + match[0].length - 1
    let depth = 0
    let i = openBrace
    for (; i < content.length; i++) {
      const ch = content[i]
      if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0) {
          i++
          break
        }
      }
    }
    blocks.push(content.slice(openBrace, i))
    // Continue scanning after this block to avoid re-matching nested headers.
    header.lastIndex = i
  }

  return blocks
}

/**
 * Extracts the `version` of every `module` block whose `source` is
 * `terraform-aws-modules/rds/aws`, ignoring blocks with any other source (R4.2).
 */
export function extractModuleVersions(tfContents: string[]): string[] {
  const versions: string[] = []

  for (const content of tfContents) {
    if (!content) continue
    for (const block of extractModuleBlocks(content)) {
      const sourceMatch = block.match(/source\s*=\s*"([^"]+)"/)
      if (!sourceMatch || sourceMatch[1] !== RDS_MODULE_SOURCE) continue

      const versionMatch = block.match(/version\s*=\s*"([^"]+)"/)
      if (versionMatch) {
        versions.push(versionMatch[1])
      }
    }
  }

  return versions
}

/**
 * Compares two version strings (MAJOR.MINOR.PATCH...) numerically segment by
 * segment. Returns a negative number if `a < b`, positive if `a > b`, 0 if equal.
 */
function compareSemver(a: string, b: string): number {
  const partsA = a.split('.').map((n) => parseInt(n, 10) || 0)
  const partsB = b.split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(partsA.length, partsB.length)
  for (let i = 0; i < len; i++) {
    const x = partsA[i] ?? 0
    const y = partsB[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

/**
 * Selects the Version_Modulo from a multiset of versions: the most frequent one;
 * on a frequency tie, the highest according to semver order. Returns null for an
 * empty input (R4.3, R4.4).
 */
export function selectModuleVersion(versions: string[]): string | null {
  if (!versions || versions.length === 0) return null

  const counts = new Map<string, number>()
  for (const v of versions) {
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }

  let maxCount = 0
  for (const count of counts.values()) {
    if (count > maxCount) maxCount = count
  }

  const mostFrequent = [...counts.entries()]
    .filter(([, count]) => count === maxCount)
    .map(([version]) => version)

  // Tie-break: highest semver first.
  mostFrequent.sort((a, b) => compareSemver(b, a))

  return mostFrequent[0]
}

/**
 * Parses the variable names declared in a `variables.tf` content
 * (`variable "name" { ... }`).
 */
function extractDeclaredVariables(content: string): string[] {
  const names: string[] = []
  const re = /variable\s+"([^"]+)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) {
    names.push(match[1])
  }
  return names
}

/**
 * Detects the multi-environment conditional pattern in use by the repository,
 * e.g. `count = contains(["dev", "uat"], var.environment) ? 1 : 0` (R6.3).
 */
function hasCountPattern(content: string): boolean {
  return /count\s*=\s*contains\s*\([^)]*\)\s*\?\s*\d+\s*:\s*\d+/.test(content)
}

/**
 * Reads `iac/databases/` of the Repositorio_Destino via gitlabClient and returns
 * the conventions in use. Never throws on missing files or read failures; it
 * signals those states through `databasesDirReadable` and the other flags.
 */
export async function readRdsConvention(
  gitlab: typeof gitlabClient,
  projectId: number,
  branch: string,
): Promise<RepoRdsConvention> {
  const empty: RepoRdsConvention = {
    moduleVersion: null,
    existingVariables: new Set<string>(),
    countPatternFound: false,
    databasesDirReadable: false,
    networkWiring: null,
  }

  // List the contents of iac/databases/ (recursive to reach vars/ as well).
  let tree
  try {
    tree = await gitlab.listRepoTree(projectId, DATABASES_DIR, branch, true)
  } catch {
    // Read failure → directory not determinable.
    return empty
  }

  if (!tree || tree.length === 0) {
    // Missing or empty directory → convention cannot be determined (R3.5).
    return empty
  }

  // The directory is readable. From here on, individual file failures degrade
  // gracefully without flipping databasesDirReadable back to false.
  const tfPaths = tree
    .filter((item) => item.type === 'blob' && item.path.endsWith('.tf'))
    .map((item) => item.path)

  const files: Array<{ path: string; content: string }> = []
  for (const path of tfPaths) {
    let content: string | null = null
    try {
      content = await gitlab.getRepositoryFileRaw(projectId, path, branch)
    } catch {
      content = null
    }
    if (content) {
      files.push({ path, content })
    }
  }

  const tfContents = files.map((f) => f.content)
  const moduleVersion = selectModuleVersion(extractModuleVersions(tfContents))

  // Existing variables come specifically from iac/databases/variables.tf.
  const existingVariables = new Set<string>()
  const variablesFile = files.find((f) => f.path === VARIABLES_FILE)
  if (variablesFile) {
    for (const name of extractDeclaredVariables(variablesFile.content)) {
      existingVariables.add(name)
    }
  }

  const countPatternFound = tfContents.some((content) => hasCountPattern(content))

  // Discover the network wiring (VPC/subnets/SG) from the repo's existing RDS
  // modules so the generator can replicate it (SRE-001). Reuses the already
  // fetched `.tf` contents — no extra GitLab I/O. `null` when no existing RDS
  // yields a complete wiring; the generator's fail-safe blocks generation then.
  const networkWiring = extractNetworkWiring(tfContents)

  return {
    moduleVersion,
    existingVariables,
    countPatternFound,
    databasesDirReadable: true,
    networkWiring,
  }
}
