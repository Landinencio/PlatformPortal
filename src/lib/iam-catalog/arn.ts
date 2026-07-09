/**
 * Validación de ARNs / Scope_De_Recurso — módulo puro.
 *
 * Feature: iam-role-least-privilege (Requirements 3.1–3.7).
 *
 * Este módulo es TOTAL (ninguna función lanza) y determinista: dedup + orden
 * lexicográfico por code points, blancos tratados como ausencia, límite duro de
 * 50 ARNs por preset y longitud 1..2048 por ARN.
 *
 * Importa SÓLO el tipo `IamPreset`/`AwsService` de `./catalog` (import type), de
 * modo que resuelve en cuanto `catalog.ts` exista, sin acoplar en runtime.
 */
import type { AwsService, IamPreset } from "./catalog"

/** Segmentos de un ARN: arn:<partition>:<service>:<region>:<account>:<resource>. */
export interface ArnParts {
  partition: string // "aws"
  service: string // "s3", "sqs", ...
  region: string // puede ir vacío (servicios globales)
  account: string // 12 dígitos, o vacío (servicios globales como S3)
  resource: string // no vacío
}

/** Código estable para i18n del rechazo de un ARN. */
export type ArnRejectCode =
  | "bad_format"
  | "empty"
  | "bad_account"
  | "cross_service"
  | "wildcard_not_allowed"

/** Resultado de validar un único ARN (formato o contra un preset). */
export interface ArnValidation {
  valid: boolean
  /** Código estable para i18n. Presente sii `valid === false`. */
  code?: ArnRejectCode
  arn: string
}

/** Resultado de validar/normalizar una lista de ARNs para un preset. */
export interface ScopeValidation {
  /** ARNs aceptados, deduplicados y ordenados determinísticamente. */
  accepted: string[]
  /** ARNs rechazados con su motivo (se conservan para feedback; 3.3/3.5). */
  rejected: ArnValidation[]
  /** true si se superó el límite de 50 (3.7). */
  tooMany: boolean
}

/** Máximo de ARNs de Scope_De_Recurso por preset (3.7). */
export const MAX_ARNS_PER_PRESET = 50
/** Longitud máxima de un ARN individual (3.1). */
export const MAX_ARN_LENGTH = 2048

/**
 * Mapea el `service` del catálogo a su prefijo de servicio dentro del ARN.
 * La mayoría coinciden con el propio id; las excepciones conocidas son
 * EventBridge (`events`), el datalake en S3 (`s3`) y Redshift Data API
 * (recursos del cluster/serverless bajo `redshift`).
 */
const SERVICE_ARN_PREFIX: Record<AwsService, string> = {
  // Familia aplicación/microservicio
  s3: "s3",
  sqs: "sqs",
  sns: "sns",
  eventbridge: "events",
  dynamodb: "dynamodb",
  secretsmanager: "secretsmanager",
  ssm: "ssm",
  logs: "logs",
  cloudwatch: "cloudwatch",
  kinesis: "kinesis",
  lambda: "lambda",
  states: "states",
  ses: "ses",
  bedrock: "bedrock",
  // Familia Data & Analytics
  athena: "athena",
  glue: "glue",
  lakeformation: "lakeformation",
  firehose: "firehose",
  "redshift-data": "redshift",
  elasticmapreduce: "elasticmapreduce",
  kafka: "kafka",
  sagemaker: "sagemaker",
  "s3-datalake": "s3",
}

/** Prefijo de servicio en el ARN para un `AwsService` (fallback: el propio id). */
export function serviceArnPrefix(service: AwsService): string {
  return SERVICE_ARN_PREFIX[service] ?? (service as string)
}

/** true si el string contiene algún comodín IAM (`*` o `?`). */
function hasWildcard(arn: string): boolean {
  return /[*?]/.test(arn)
}

/**
 * Parseo puro de un ARN a sus segmentos, o `null` si no cumple el formato base
 * (`arn:<partition>:<service>:<region>:<account>:<resource>` con al menos 6
 * segmentos, prefijo literal `arn` y partition no vacía). El resto de reglas de
 * campo (servicio/recurso no vacíos, cuenta de 12 dígitos) las aplica
 * `validateArnFormat`. Nunca lanza.
 */
export function parseArn(arn: string): ArnParts | null {
  try {
    if (typeof arn !== "string") return null
    const parts = arn.split(":")
    if (parts.length < 6) return null
    if (parts[0] !== "arn") return null
    const partition = parts[1]
    const service = parts[2]
    const region = parts[3]
    const account = parts[4]
    const resource = parts.slice(5).join(":")
    if (partition.length === 0) return null
    return { partition, service, region, account, resource }
  } catch {
    return null
  }
}

/**
 * Valida el FORMATO de un ARN: arn:aws:<servicio>:<region>:<cuenta>:<recurso>
 *  - servicio no vacío
 *  - region/cuenta pueden ir vacías para servicios globales (p.ej. S3)
 *  - cuenta de 12 dígitos cuando exista
 *  - recurso no vacío
 * TOTAL: cualquier excepción interna se traduce a `valid: false` (3.3, default-deny).
 */
export function validateArnFormat(arn: string): ArnValidation {
  try {
    if (typeof arn !== "string" || arn.trim().length === 0) {
      return { valid: false, code: "empty", arn: typeof arn === "string" ? arn : "" }
    }
    const trimmed = arn.trim()
    const parts = parseArn(trimmed)
    if (parts === null) {
      return { valid: false, code: "bad_format", arn: trimmed }
    }
    if (parts.service.length === 0 || parts.resource.length === 0) {
      return { valid: false, code: "bad_format", arn: trimmed }
    }
    if (parts.account.length > 0 && !/^[0-9]{12}$/.test(parts.account)) {
      return { valid: false, code: "bad_account", arn: trimmed }
    }
    return { valid: true, arn: trimmed }
  } catch {
    return { valid: false, code: "bad_format", arn: typeof arn === "string" ? arn : "" }
  }
}

/**
 * Valida un ARN CONTRA un preset: formato + coherencia servicio↔ARN (3.5) +
 * comodines permitidos por el preset (3.6). Nunca lanza.
 */
export function validateArnForPreset(arn: string, preset: IamPreset): ArnValidation {
  const fmt = validateArnFormat(arn)
  if (!fmt.valid) return fmt
  const trimmed = typeof arn === "string" ? arn.trim() : ""
  const parts = parseArn(trimmed)
  if (parts === null) {
    // Inalcanzable si el formato es válido, pero mantenemos la totalidad.
    return { valid: false, code: "bad_format", arn: trimmed }
  }
  if (parts.service !== serviceArnPrefix(preset.service)) {
    return { valid: false, code: "cross_service", arn: trimmed }
  }
  if (hasWildcard(trimmed) && !preset.allowWildcards) {
    return { valid: false, code: "wildcard_not_allowed", arn: trimmed }
  }
  return { valid: true, arn: trimmed }
}

/**
 * Valida y normaliza una lista de ARNs para un preset:
 *  - ARNs en blanco / sólo espacios se tratan como ausencia (3.4).
 *  - >50 ARNs → `tooMany`, conservando los 50 dentro del límite (3.7).
 *  - dedup + orden lexicográfico determinista por code points (3.2).
 *  - longitud por ARN 1..2048 (3.1); los que exceden se rechazan.
 * Nunca lanza.
 */
export function validateScope(arns: readonly string[], preset: IamPreset): ScopeValidation {
  const nonBlank = (Array.isArray(arns) ? arns : [])
    .map((a) => (typeof a === "string" ? a.trim() : ""))
    .filter((a) => a.length > 0)

  let tooMany = false
  let working = nonBlank
  if (nonBlank.length > MAX_ARNS_PER_PRESET) {
    tooMany = true
    working = nonBlank.slice(0, MAX_ARNS_PER_PRESET)
  }

  const acceptedSet = new Set<string>()
  const rejected: ArnValidation[] = []
  for (const arn of working) {
    if (arn.length > MAX_ARN_LENGTH) {
      rejected.push({ valid: false, code: "bad_format", arn })
      continue
    }
    const v = validateArnForPreset(arn, preset)
    if (v.valid) {
      acceptedSet.add(v.arn)
    } else {
      rejected.push(v)
    }
  }

  const accepted = [...acceptedSet].sort()
  return { accepted, rejected, tooMany }
}
