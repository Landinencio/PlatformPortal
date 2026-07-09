/**
 * Generador_De_Politica — módulo puro determinista.
 *
 * Feature: iam-role-least-privilege (Requirements 3.2, 3.4, 4.1–4.9, 6.2, 6.6, 6.7, 7.3).
 *
 * Transforma una selección de Preset_IAM + Scope_De_Recurso en HCL Terraform que
 * sigue el Patron_IRSA nativo (`aws_iam_role` + trust
 * `role_templates/iskaypet_dh_access.json.tmpl` + `aws_iam_policy` scoped +
 * `aws_iam_role_policy_attachment`, NUNCA módulos IAM). La generación es:
 *  - determinista y byte-idéntica para la misma selección semántica, sea cual
 *    sea el orden de entrada de presets y ARNs (4.2);
 *  - de mínimo privilegio: sólo las acciones declaradas por los presets (4.4);
 *  - válida frente a `validateHclSyntax` (4.7).
 *
 * Módulo puro: sin React, sin `node:*`. Importa el Catálogo_IAM (única fuente de
 * verdad) y la validación de ARNs.
 */
import {
  getPresetById,
  IAM_CATALOG,
  type IamPreset,
} from "./catalog"
import { validateScope } from "./arn"

/** Selección de un preset con su Scope_De_Recurso opcional. */
export interface PresetSelection {
  presetId: string
  /** ARNs concretos; vacío / ausente ⇒ usar `defaultArnTemplate` del preset (3.4). */
  resourceArns?: readonly string[]
}

/** Entrada del Generador_De_Politica para crear un rol IAM. */
export interface GenerateIamRoleInput {
  roleName: string
  namespace: string
  selections: readonly PresetSelection[]
  /** Subconjunto de ["dev","uat","prod"] o ["tooling"]. */
  targetEnvironments: readonly string[]
}

/** Resultado de la generación: éxito con HCL, o error con código estable. */
export type GenerateResult =
  | { ok: true; hcl: string; filePath: "iac/services/roles.tf"; actionsCount: number }
  | { ok: false; code: "unknown_preset" | "empty_selection" | "invalid_scope"; detail: string }

/** Orden canónico de los entornos para la expresión `count` (4.6). */
const CANONICAL_ENV_ORDER: readonly string[] = ["dev", "uat", "prod", "tooling"]
/** Conjunto completo de entornos disponibles (4.8): dev + uat + prod. */
const ALL_ENVIRONMENTS: readonly string[] = ["dev", "uat", "prod"]

/** Ruta de destino fija del HCL de roles (patrón nativo, steering). */
const ROLES_FILE_PATH = "iac/services/roles.tf" as const

/** Serializa un string a literal HCL con comillas dobles balanceadas y escapadas. */
function q(value: string): string {
  return JSON.stringify(String(value))
}

/** Comparación estable por code points (independiente de locale). */
function byCodePoints(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Deriva el `Sid` de un preset a partir de su id, conservando sólo caracteres
 * alfanuméricos (p.ej. "s3-read-only" → "s3readonly"). Determinista.
 */
export function sidFromPresetId(presetId: string): string {
  return String(presetId).replace(/[^A-Za-z0-9]/g, "")
}

/** Mapa inverso Sid → presetId, construido una vez sobre el catálogo publicado. */
const SID_TO_PRESET_ID: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>()
  for (const p of IAM_CATALOG) {
    m.set(sidFromPresetId(p.id), p.id)
  }
  return m
})()

/**
 * Sanea el nombre de rol a una etiqueta de recurso Terraform válida
 * ([a-zA-Z0-9_-]+). Si el resultado queda vacío, usa "role".
 */
function toResourceLabel(roleName: string): string {
  const cleaned = String(roleName).replace(/[^A-Za-z0-9_-]/g, "_")
  return cleaned.length > 0 ? cleaned : "role"
}

/** true si el valor es un string no vacío tras recortar espacios. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * Determina si una selección está totalmente cubierta por el Catálogo_IAM
 * (4.1 vs 4.5): true sii todos los `presetId` pertenecen al catálogo. Una
 * selección vacía se considera cubierta (verdad vacua). TOTAL: nunca lanza.
 */
export function isCoveredByCatalog(selections: readonly PresetSelection[]): boolean {
  if (!Array.isArray(selections)) return false
  return selections.every(
    (s) => s != null && getPresetById((s as PresetSelection).presetId) !== undefined,
  )
}

/**
 * Valida los campos obligatorios de la Solicitud_Infra de rol IAM (7.3):
 * `roleName`, `namespace` y al menos un entorno destino, todos presentes y no
 * vacíos. TOTAL: nunca lanza.
 */
export function validateRequiredRoleFields(input: GenerateIamRoleInput): boolean {
  if (input == null || typeof input !== "object") return false
  if (!isNonEmptyString(input.roleName)) return false
  if (!isNonEmptyString(input.namespace)) return false
  if (!Array.isArray(input.targetEnvironments)) return false
  return input.targetEnvironments.some((e) => isNonEmptyString(e))
}

/**
 * Extrae del HCL generado (por `Sid`) los ids de preset presentes, para el
 * round-trip del flujo de modificación (6.2). Devuelve los ids únicos en orden
 * determinista. TOTAL: nunca lanza.
 */
export function parseRolePresetIds(hcl: string): string[] {
  if (typeof hcl !== "string") return []
  const ids = new Set<string>()
  const re = /Sid\s*=\s*"([A-Za-z0-9]+)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(hcl)) !== null) {
    const presetId = SID_TO_PRESET_ID.get(match[1])
    if (presetId !== undefined) ids.add(presetId)
  }
  return [...ids].sort(byCodePoints)
}

/**
 * Aplica el complemento exacto: conserva los ids actuales que NO están en
 * `removePresetIds` (6.7), preservando el orden de `currentPresetIds` y
 * deduplicando. TOTAL: nunca lanza.
 */
export function applyRemoval(
  currentPresetIds: readonly string[],
  removePresetIds: readonly string[],
): string[] {
  const current = Array.isArray(currentPresetIds) ? currentPresetIds : []
  const toRemove = new Set(Array.isArray(removePresetIds) ? removePresetIds : [])
  const kept: string[] = []
  const seen = new Set<string>()
  for (const id of current) {
    if (typeof id !== "string") continue
    if (toRemove.has(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    kept.push(id)
  }
  return kept
}

/** Selección normalizada de un preset resuelto con sus recursos finales. */
interface ResolvedStatement {
  presetId: string
  preset: IamPreset
  actions: string[]
  resources: string[]
}

/**
 * Agrupa las selecciones por `presetId` (fusionando los ARNs de entradas
 * repetidas), en orden determinista por presetId.
 */
function groupSelections(
  selections: readonly PresetSelection[],
): { presetId: string; arns: string[] }[] {
  const byId = new Map<string, string[]>()
  for (const sel of selections) {
    if (sel == null || typeof sel.presetId !== "string") continue
    const arns = byId.get(sel.presetId) ?? []
    if (Array.isArray(sel.resourceArns)) {
      for (const a of sel.resourceArns) arns.push(a)
    }
    byId.set(sel.presetId, arns)
  }
  return [...byId.entries()]
    .map(([presetId, arns]) => ({ presetId, arns }))
    .sort((a, b) => byCodePoints(a.presetId, b.presetId))
}

/**
 * Construye la expresión `count` según los entornos destino (4.6/4.8):
 *  - subconjunto propio no vacío ⇒ `count = contains([<envs>], var.environment) ? 1 : 0`;
 *  - conjunto completo (dev+uat+prod) ⇒ sin `count` (y sin `[0]` en referencias).
 * Devuelve { conditional, countLine, indexSuffix }.
 */
function buildCount(targetEnvironments: readonly string[]): {
  countLine: string
  indexSuffix: string
} {
  const provided = new Set(
    (Array.isArray(targetEnvironments) ? targetEnvironments : [])
      .filter((e) => isNonEmptyString(e))
      .map((e) => e.trim()),
  )
  // Entornos ordenados canónicamente y filtrados a los soportados.
  const ordered = CANONICAL_ENV_ORDER.filter((e) => provided.has(e))
  const isAll =
    ALL_ENVIRONMENTS.every((e) => provided.has(e)) &&
    ordered.length === ALL_ENVIRONMENTS.length
  if (isAll) {
    return { countLine: "", indexSuffix: "" }
  }
  const envList = ordered.map((e) => q(e)).join(", ")
  return {
    countLine: `  count = contains([${envList}], var.environment) ? 1 : 0\n`,
    indexSuffix: "[0]",
  }
}

/** Renderiza un array HCL de strings con la indentación dada. */
function renderStringArray(values: readonly string[], indent: string): string {
  const inner = values.map((v) => `${indent}  ${q(v)}`).join(",\n")
  return `[\n${inner}\n${indent}]`
}

/** Renderiza un único objeto-Statement de la política (orden de claves fijo). */
function renderStatement(st: ResolvedStatement): string {
  const i = "        " // indentación dentro del elemento del array Statement
  return [
    "      {",
    `        Sid      = ${q(sidFromPresetId(st.presetId))}`,
    `        Effect   = "Allow"`,
    `        Action   = ${renderStringArray(st.actions, i)}`,
    `        Resource = ${renderStringArray(st.resources, i)}`,
    "      }",
  ].join("\n")
}

/**
 * Genera HCL IRSA determinista a partir de la selección de presets.
 * Ver contrato en la cabecera del módulo. TOTAL: nunca lanza (los errores se
 * devuelven como `{ ok: false, code, detail }`).
 */
export function generateIamRoleHcl(input: GenerateIamRoleInput): GenerateResult {
  const selections = Array.isArray(input?.selections) ? input.selections : []
  if (selections.length === 0) {
    return { ok: false, code: "empty_selection", detail: "No presets selected" }
  }

  const groups = groupSelections(selections)
  if (groups.length === 0) {
    return { ok: false, code: "empty_selection", detail: "No valid preset selections" }
  }

  // 1) Resolver presets: abortar con unknown_preset ante cualquier id ausente (4.9).
  const missing = groups.map((g) => g.presetId).filter((id) => getPresetById(id) === undefined)
  if (missing.length > 0) {
    const first = [...missing].sort(byCodePoints)[0]
    return {
      ok: false,
      code: "unknown_preset",
      detail: `Unknown preset id: ${first}`,
    }
  }

  // 2) Resolver Scope_De_Recurso por preset (3.2/3.4), abortando con invalid_scope.
  const statements: ResolvedStatement[] = []
  for (const g of groups) {
    const preset = getPresetById(g.presetId) as IamPreset
    const scope = validateScope(g.arns, preset)
    if (scope.tooMany) {
      return {
        ok: false,
        code: "invalid_scope",
        detail: `Preset ${g.presetId}: exceeded the maximum of 50 ARNs`,
      }
    }
    if (scope.rejected.length > 0) {
      const bad = scope.rejected[0]
      return {
        ok: false,
        code: "invalid_scope",
        detail: `Preset ${g.presetId}: rejected ARN "${bad.arn}" (${bad.code ?? "bad_format"})`,
      }
    }
    const resources =
      scope.accepted.length > 0 ? scope.accepted : [preset.defaultArnTemplate]
    // Acciones ordenadas por code points y deduplicadas (4.2/4.4).
    const actions = [...new Set(preset.actions)].sort(byCodePoints)
    statements.push({ presetId: g.presetId, preset, actions, resources })
  }

  // 3) Renderizar el HCL determinista.
  const label = toResourceLabel(input.roleName)
  const roleName = String(input.roleName)
  const namespace = String(input.namespace)
  const { countLine, indexSuffix } = buildCount(input.targetEnvironments)

  const statementBlocks = statements.map(renderStatement).join(",\n")
  const actionsCount = statements.reduce((sum, s) => sum + s.actions.length, 0)

  const roleBlock = [
    `resource "aws_iam_role" "${label}" {`,
    countLine.length > 0 ? countLine.replace(/\n$/, "") : null,
    `  name = ${q(roleName)}`,
    `  assume_role_policy = templatefile("role_templates/iskaypet_dh_access.json.tmpl", {`,
    `    AWS_ACCOUNT_ID    = var.oms_account_id`,
    `    OIDC_PROVIDER_URL = var.dp_eks_oidc_provider_url`,
    `    NAMESPACE         = ${q(namespace)}`,
    `  })`,
    `}`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n")

  const policyBlock = [
    `resource "aws_iam_policy" "${label}" {`,
    countLine.length > 0 ? countLine.replace(/\n$/, "") : null,
    `  name = ${q(`${roleName}-policy`)}`,
    `  policy = jsonencode({`,
    `    Version = "2012-10-17"`,
    `    Statement = [`,
    statementBlocks,
    `    ]`,
    `  })`,
    `}`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n")

  const attachmentBlock = [
    `resource "aws_iam_role_policy_attachment" "${label}" {`,
    countLine.length > 0 ? countLine.replace(/\n$/, "") : null,
    `  role       = aws_iam_role.${label}${indexSuffix}.name`,
    `  policy_arn = aws_iam_policy.${label}${indexSuffix}.arn`,
    `}`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n")

  const hcl = `${roleBlock}\n\n${policyBlock}\n\n${attachmentBlock}\n`

  return { ok: true, hcl, filePath: ROLES_FILE_PATH, actionsCount }
}
