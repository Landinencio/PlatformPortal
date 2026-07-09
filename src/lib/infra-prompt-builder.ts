// Prompt Builder — deterministic prompt construction from structured form fields
// Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 6.2, 6.3

import type { RdsEngine } from "./rds/version-catalog"
import type { PresetSelection } from "./iam-catalog/generator"

// ── Types ────────────────────────────────────────────────────────────────────

export interface RdsFields {
  identifier: string
  dbName: string
  instanceClass: string
  storageGb: number
  multiAz: boolean
  /** Major engine version (formerly "PostgreSQL version"). */
  engineVersion: string
  /** NEW. Database engine. For backward compatibility, absent ⇒ 'postgres'. */
  engine?: RdsEngine
  /** NEW (derived). Parameter group family; the generator recalculates it from the catalog. */
  family?: string
}

export interface S3Fields {
  bucketName: string
  versioning: boolean
  encryptionType: 'AES-256' | 'aws:kms'
  lifecycleRules?: string
}

export interface IamRoleFields {
  roleName: string
  servicePrincipal: string
  policyType: 'irsa' | 'standard'
  namespace?: string
  /**
   * Legacy / fallback free-text permissions consumed by the InfraAgent when the
   * request is NOT covered by the curated IAM catalog. Kept for backward
   * compatibility with the AI agent path.
   */
  permissions: string[]
  /**
   * Structured selection from the curated IAM catalog (least-privilege presets).
   * When present and non-empty, the prompt transports the structured selection
   * (presetId + resourceArns) so the deterministic generator/agent can build a
   * scoped policy. Absent ⇒ fall back to the free-text `permissions` path.
   */
  presetSelections?: PresetSelection[]
}

export type ResourceFields = RdsFields | S3Fields | IamRoleFields

export interface BuildPromptInput {
  resourceType: 'rds' | 's3' | 'iam_role'
  fields: ResourceFields
  targetEnvironments: string[]
}

// ── Shared instructions ──────────────────────────────────────────────────────

function buildCountInstruction(targetEnvironments: string[]): string {
  const allEnvs = ["dev", "uat", "prod"]
  const hasAll = allEnvs.every(e => targetEnvironments.includes(e))
  if (hasAll) {
    return "Los entornos destino son TODOS (dev, uat, prod). NO añadas count — el recurso se despliega en todos los entornos."
  }
  const envList = targetEnvironments.map(e => `"${e}"`).join(", ")
  return `IMPORTANTE: Los entornos destino son SOLO: ${targetEnvironments.join(", ")}. La pipeline aplica en dev → uat → prod secuencialmente. DEBES añadir count = contains([${envList}], var.environment) ? 1 : 0 a TODOS los resources (aws_iam_role, aws_s3_bucket, aws_security_group, etc.) para que solo se creen en los entornos seleccionados. Si un recurso referencia a otro con count, usa [0] en la referencia.`
}

const SHARED_INSTRUCTIONS = `INSTRUCCIONES CRÍTICAS:
1. Lee el árbol del repositorio en el directorio correspondiente:
   - RDS → iac/databases/ (cada servicio tiene su propio .tf)
   - S3 → iac/storage/s3.tf (todos los buckets en un solo archivo)
   - IAM Roles → iac/services/roles.tf (roles IRSA para microservicios)
2. Lee el archivo .tf correspondiente como PLANTILLA.
3. COPIA la estructura COMPLETA. Solo cambia los valores específicos del nuevo recurso.
4. NO cambies la versión del módulo. NO cambies las referencias a variables. NO cambies los patrones ternarios.
5. Incluye TODOS los bloques que existan en la plantilla.
6. Para IAM Roles: usa el template "role_templates/iskaypet_dh_access.json.tmpl" con AWS_ACCOUNT_ID, OIDC_PROVIDER_URL y NAMESPACE.`

// ── Prompt templates ─────────────────────────────────────────────────────────

function buildRdsPrompt(fields: RdsFields, targetEnvironments: string[]): string {
  const multiAzLabel = fields.multiAz ? 'sí' : 'no'
  const countInstr = buildCountInstruction(targetEnvironments)
  return `Genera un archivo Terraform para una instancia RDS PostgreSQL con los siguientes parámetros:
- Identificador: ${fields.identifier}
- Nombre de base de datos: ${fields.dbName}
- Clase de instancia: ${fields.instanceClass}
- Almacenamiento: ${fields.storageGb} GB
- Multi-AZ: ${multiAzLabel}
- Versión de PostgreSQL: ${fields.engineVersion}
- Entornos destino: ${targetEnvironments.join(', ')}
- Archivo destino: iac/databases/${fields.identifier}.tf

${countInstr}

${SHARED_INSTRUCTIONS}
7. En el JSON metadata usa file_path: "iac/databases/${fields.identifier}.tf"

ROTACIÓN OBLIGATORIA DE CONTRASEÑA MASTER (NO OMITIR):
El módulo RDS DEBE gestionar la contraseña del usuario master en Secrets Manager y rotarla cada 15 días. Incluye SIEMPRE estos 4 atributos en el bloque "module" (es el estándar de IskayPet para todas las RDS nuevas, aunque la plantilla que leas no los tenga):
  manage_master_user_password                       = true
  manage_master_user_password_rotation              = true
  master_user_password_rotate_immediately           = false
  master_user_password_rotation_schedule_expression = "rate(15 days)"
NUNCA uses el atributo "password" hardcodeado ni "username/password" en texto plano. La contraseña la gestiona AWS Secrets Manager vía manage_master_user_password.`
}

function buildS3Prompt(fields: S3Fields, targetEnvironments: string[]): string {
  const versioningLabel = fields.versioning ? 'habilitado' : 'deshabilitado'
  const countInstr = buildCountInstruction(targetEnvironments)
  let prompt = `Genera un archivo Terraform para un bucket S3 con los siguientes parámetros:
- Nombre del bucket: ${fields.bucketName}
- Versionado: ${versioningLabel}
- Tipo de cifrado: ${fields.encryptionType}
- Entornos destino: ${targetEnvironments.join(', ')}
- Archivo destino: iac/storage/s3.tf (añadir al final del archivo existente)

${countInstr}`

  if (fields.lifecycleRules) {
    prompt += `\n- Reglas de ciclo de vida: ${fields.lifecycleRules}`
  }

  prompt += `\n\n${SHARED_INSTRUCTIONS}`
  prompt += `\n7. En el JSON metadata usa file_path: "iac/storage/s3.tf"`
  return prompt
}

function buildIamRolePrompt(fields: IamRoleFields, targetEnvironments: string[]): string {
  const policyLabel = fields.policyType === 'irsa' ? 'IRSA' : 'estándar'
  const countInstr = buildCountInstruction(targetEnvironments)
  let prompt = `Genera un archivo Terraform para un IAM Role con los siguientes parámetros:
- Nombre del rol: ${fields.roleName}
- Tipo de política: ${policyLabel}
- Entornos destino: ${targetEnvironments.join(', ')}
- Archivo destino: iac/services/roles.tf (añadir al final del archivo existente)

${countInstr}`

  if (fields.policyType === 'irsa' && fields.namespace) {
    prompt += `\n- Namespace: ${fields.namespace}`
  }

  if (fields.presetSelections && fields.presetSelections.length > 0) {
    const selectionLines = fields.presetSelections
      .map(sel => {
        const arns = sel.resourceArns && sel.resourceArns.length > 0
          ? sel.resourceArns.join(', ')
          : '(usar el ARN por defecto del preset)'
        return `  - Preset: ${sel.presetId} · Recursos: ${arns}`
      })
      .join('\n')
    prompt += `\n- Selección de presets del catálogo IAM de mínimo privilegio (fuente autoritativa; genera un Statement por preset con sus acciones y limita el Resource a los ARNs indicados):\n${selectionLines}`
  } else if (fields.permissions.length > 0) {
    prompt += `\n- Permisos: ${fields.permissions.join(', ')}`
  }

  prompt += `\n\n${SHARED_INSTRUCTIONS}`
  prompt += `\n7. Usa el template "role_templates/iskaypet_dh_access.json.tmpl" con AWS_ACCOUNT_ID = var.oms_account_id, OIDC_PROVIDER_URL = var.dp_eks_oidc_provider_url, NAMESPACE = "${fields.namespace || 'oms'}"`
  prompt += `\n8. En el JSON metadata usa file_path: "iac/services/roles.tf"`
  return prompt
}

// ── Public API ───────────────────────────────────────────────────────────────

export function buildPrompt(input: BuildPromptInput): string {
  switch (input.resourceType) {
    case 'rds':
      return buildRdsPrompt(input.fields as RdsFields, input.targetEnvironments)
    case 's3':
      return buildS3Prompt(input.fields as S3Fields, input.targetEnvironments)
    case 'iam_role':
      return buildIamRolePrompt(input.fields as IamRoleFields, input.targetEnvironments)
  }
}
