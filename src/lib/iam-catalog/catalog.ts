/**
 * Catálogo_IAM — módulo puro versionado.
 *
 * Feature: iam-role-least-privilege (Requirements 1.1–1.9, 2.1–2.6).
 *
 * Única fuente de verdad, inmutable, del catálogo curado de presets IAM de
 * mínimo privilegio. Compartida por el Formulario_Creacion y el
 * Formulario_Modificacion, por las rutas API y por los tests.
 *
 * Módulo puro: sin React, sin `node:*`. Importa sólo los helpers de
 * clasificación de acciones de `./action-levels`.
 *
 * Reconciliación de cobertura (decisión de diseño, jun 2026): el Req 1.2 exige
 * que cada servicio con acciones de escritura ofrezca los niveles `read-only` y
 * `read-write`. Los servicios cuyo plano de acceso sólo expone acciones de
 * lectura clasificadas (p. ej. Lake Formation: `GetDataAccess`,
 * `GetResourceLFTags`, `SearchTablesByLFTags`) quedan EXENTOS del nivel
 * `read-write` — no existe una acción de escritura que otorgar sin salirse del
 * mínimo privilegio. `kinesis-consumer` se clasifica como `read-only` (todas sus
 * acciones son List/Read) y se añaden `kafka-read-only` y `firehose-read-only`
 * para completar la cobertura de esos dos servicios.
 */
import { isReadOnlyAction, isRdsDataPlaneAction } from "./action-levels"

/** Nivel de acceso de un preset (Nivel_De_Acceso). */
export type AccessLevel = "read-only" | "read-write" | "custom-actions"

/** Identificador de servicio AWS soportado por el catálogo (23 servicios). */
export type AwsService =
  // Familia aplicación/microservicio (14)
  | "s3"
  | "sqs"
  | "sns"
  | "eventbridge"
  | "dynamodb"
  | "secretsmanager"
  | "ssm"
  | "logs"
  | "cloudwatch"
  | "kinesis"
  | "lambda"
  | "states"
  | "ses"
  | "bedrock"
  // Familia Data & Analytics (9)
  | "athena"
  | "glue"
  | "lakeformation"
  | "firehose"
  | "redshift-data"
  | "elasticmapreduce"
  | "kafka"
  | "sagemaker"
  | "s3-datalake"

/** Familia de servicio del catálogo. */
export type ServiceFamily = "application" | "data-analytics"

/** Entrada del catálogo (Preset_IAM). Inmutable. */
export interface IamPreset {
  /** Identificador único y estable, inmutable entre versiones. p.ej. "s3-read-only". */
  readonly id: string
  readonly service: AwsService
  readonly family: ServiceFamily
  readonly accessLevel: AccessLevel
  /** Etiqueta i18n-key para la UI (no texto literal). Siempre `iam.preset.<id>`. */
  readonly labelKey: string
  /** 1..50 acciones IAM, sin duplicados. p.ej. ["s3:GetObject", "s3:ListBucket"]. */
  readonly actions: readonly string[]
  /** Plantilla de ARN por defecto (no vacía). p.ej. "arn:aws:s3:::*". */
  readonly defaultArnTemplate: string
  /** Si admite Scope_De_Recurso (ARNs concretos) o usa siempre el default. */
  readonly scopable: boolean
  /** Comodines permitidos en el Scope_De_Recurso de este preset. */
  readonly allowWildcards: boolean
}

/** Versión de esquema: entero monotónicamente creciente iniciado en 1. */
export const CATALOG_SCHEMA_VERSION = 1 as const

/** Opción de formulario derivada de un preset (misma para crear y modificar). */
export interface PresetFormOption {
  readonly id: string
  readonly service: AwsService
  readonly family: ServiceFamily
  readonly accessLevel: AccessLevel
  readonly labelKey: string
  readonly scopable: boolean
  readonly allowWildcards: boolean
}

/** Helper interno para construir un preset con `labelKey` derivado del id. */
function preset(
  id: string,
  service: AwsService,
  family: ServiceFamily,
  accessLevel: AccessLevel,
  actions: readonly string[],
  defaultArnTemplate: string,
  scopable: boolean,
  allowWildcards: boolean,
): IamPreset {
  return {
    id,
    service,
    family,
    accessLevel,
    labelKey: `iam.preset.${id}`,
    actions,
    defaultArnTemplate,
    scopable,
    allowWildcards,
  }
}

/**
 * Presets crudos del catálogo, antes de las reglas de integridad. La colección
 * publicada (`IAM_CATALOG`) se deriva de aquí vía `buildPublishedCatalog`.
 *
 * Todas las acciones están clasificadas en `action-levels.ts`. Ningún preset
 * incluye acciones del plano de datos de RDS (fuera de alcance por diseño).
 */
export const RAW_PRESETS: readonly IamPreset[] = [
  // ─── Familia aplicación/microservicio (14 servicios) ───

  // S3
  preset(
    "s3-read-only",
    "s3",
    "application",
    "read-only",
    ["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"],
    "arn:aws:s3:::*",
    true,
    true,
  ),
  preset(
    "s3-read-write",
    "s3",
    "application",
    "read-write",
    [
      "s3:GetObject",
      "s3:ListBucket",
      "s3:GetBucketLocation",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
    ],
    "arn:aws:s3:::*",
    true,
    true,
  ),

  // SQS
  preset(
    "sqs-consumer",
    "sqs",
    "application",
    "read-write",
    [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:ChangeMessageVisibility",
    ],
    "arn:aws:sqs:*:*:*",
    true,
    false,
  ),
  preset(
    "sqs-producer",
    "sqs",
    "application",
    "read-write",
    ["sqs:SendMessage", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"],
    "arn:aws:sqs:*:*:*",
    true,
    false,
  ),
  preset(
    "sqs-read-only",
    "sqs",
    "application",
    "read-only",
    ["sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ListQueues"],
    "arn:aws:sqs:*:*:*",
    true,
    false,
  ),

  // SNS
  preset(
    "sns-publisher",
    "sns",
    "application",
    "read-write",
    ["sns:Publish", "sns:GetTopicAttributes"],
    "arn:aws:sns:*:*:*",
    true,
    false,
  ),
  preset(
    "sns-read-only",
    "sns",
    "application",
    "read-only",
    ["sns:GetTopicAttributes", "sns:ListSubscriptionsByTopic"],
    "arn:aws:sns:*:*:*",
    true,
    false,
  ),

  // EventBridge
  preset(
    "eventbridge-publisher",
    "eventbridge",
    "application",
    "read-write",
    ["events:PutEvents"],
    "arn:aws:events:*:*:event-bus/*",
    true,
    false,
  ),
  preset(
    "eventbridge-read-only",
    "eventbridge",
    "application",
    "read-only",
    ["events:DescribeRule", "events:ListRules", "events:ListTargetsByRule"],
    "arn:aws:events:*:*:rule/*",
    true,
    false,
  ),

  // DynamoDB
  preset(
    "dynamodb-read-only",
    "dynamodb",
    "application",
    "read-only",
    [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:DescribeTable",
    ],
    "arn:aws:dynamodb:*:*:table/*",
    true,
    true,
  ),
  preset(
    "dynamodb-read-write",
    "dynamodb",
    "application",
    "read-write",
    [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:DescribeTable",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:BatchWriteItem",
    ],
    "arn:aws:dynamodb:*:*:table/*",
    true,
    true,
  ),

  // Secrets Manager
  preset(
    "secrets-read-only",
    "secretsmanager",
    "application",
    "read-only",
    ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
    "arn:aws:secretsmanager:*:*:secret:*",
    true,
    true,
  ),
  preset(
    "secrets-read-write",
    "secretsmanager",
    "application",
    "read-write",
    [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:UpdateSecret",
    ],
    "arn:aws:secretsmanager:*:*:secret:*",
    true,
    true,
  ),

  // SSM Parameter Store
  preset(
    "ssm-params-read-only",
    "ssm",
    "application",
    "read-only",
    ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
    "arn:aws:ssm:*:*:parameter/*",
    true,
    true,
  ),
  preset(
    "ssm-params-read-write",
    "ssm",
    "application",
    "read-write",
    [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
      "ssm:PutParameter",
    ],
    "arn:aws:ssm:*:*:parameter/*",
    true,
    true,
  ),

  // CloudWatch Logs
  preset(
    "logs-writer",
    "logs",
    "application",
    "read-write",
    ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
    "arn:aws:logs:*:*:log-group:*",
    true,
    true,
  ),
  preset(
    "logs-read-only",
    "logs",
    "application",
    "read-only",
    ["logs:GetLogEvents", "logs:FilterLogEvents", "logs:DescribeLogGroups"],
    "arn:aws:logs:*:*:log-group:*",
    true,
    true,
  ),

  // CloudWatch Metrics
  preset(
    "cloudwatch-metrics-publisher",
    "cloudwatch",
    "application",
    "read-write",
    ["cloudwatch:PutMetricData"],
    "*",
    false,
    false,
  ),
  preset(
    "cloudwatch-metrics-read-only",
    "cloudwatch",
    "application",
    "read-only",
    ["cloudwatch:GetMetricData", "cloudwatch:ListMetrics", "cloudwatch:GetMetricStatistics"],
    "*",
    false,
    false,
  ),

  // Kinesis — consumer se clasifica read-only (todas sus acciones son List/Read)
  preset(
    "kinesis-consumer",
    "kinesis",
    "application",
    "read-only",
    [
      "kinesis:GetRecords",
      "kinesis:GetShardIterator",
      "kinesis:DescribeStream",
      "kinesis:ListShards",
    ],
    "arn:aws:kinesis:*:*:stream/*",
    true,
    false,
  ),
  preset(
    "kinesis-producer",
    "kinesis",
    "application",
    "read-write",
    ["kinesis:PutRecord", "kinesis:PutRecords", "kinesis:DescribeStream"],
    "arn:aws:kinesis:*:*:stream/*",
    true,
    false,
  ),

  // Lambda
  preset(
    "lambda-invoker",
    "lambda",
    "application",
    "read-write",
    ["lambda:InvokeFunction"],
    "arn:aws:lambda:*:*:function:*",
    true,
    false,
  ),
  preset(
    "lambda-read-only",
    "lambda",
    "application",
    "read-only",
    ["lambda:GetFunction", "lambda:ListFunctions", "lambda:GetFunctionConfiguration"],
    "arn:aws:lambda:*:*:function:*",
    true,
    false,
  ),

  // Step Functions
  preset(
    "states-executor",
    "states",
    "application",
    "read-write",
    ["states:StartExecution", "states:DescribeExecution", "states:StopExecution"],
    "arn:aws:states:*:*:stateMachine:*",
    true,
    false,
  ),
  preset(
    "states-read-only",
    "states",
    "application",
    "read-only",
    ["states:DescribeExecution", "states:ListExecutions", "states:GetExecutionHistory"],
    "arn:aws:states:*:*:stateMachine:*",
    true,
    false,
  ),

  // SES
  preset(
    "ses-sender",
    "ses",
    "application",
    "read-write",
    ["ses:SendEmail", "ses:SendRawEmail"],
    "arn:aws:ses:*:*:identity/*",
    true,
    false,
  ),
  preset(
    "ses-read-only",
    "ses",
    "application",
    "read-only",
    ["ses:GetSendQuota", "ses:ListIdentities", "ses:GetIdentityVerificationAttributes"],
    "*",
    false,
    false,
  ),

  // Bedrock
  preset(
    "bedrock-invoke",
    "bedrock",
    "application",
    "read-write",
    ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
    "arn:aws:bedrock:*::foundation-model/*",
    true,
    true,
  ),
  preset(
    "bedrock-read-only",
    "bedrock",
    "application",
    "read-only",
    ["bedrock:ListFoundationModels", "bedrock:GetFoundationModel"],
    "*",
    false,
    false,
  ),

  // ─── Familia Data & Analytics (9 servicios) ───

  // Athena
  preset(
    "athena-read-only",
    "athena",
    "data-analytics",
    "read-only",
    [
      "athena:GetQueryExecution",
      "athena:GetQueryResults",
      "athena:ListQueryExecutions",
      "athena:GetWorkGroup",
    ],
    "arn:aws:athena:*:*:workgroup/*",
    true,
    false,
  ),
  preset(
    "athena-query-runner",
    "athena",
    "data-analytics",
    "read-write",
    [
      "athena:GetQueryExecution",
      "athena:GetQueryResults",
      "athena:ListQueryExecutions",
      "athena:GetWorkGroup",
      "athena:StartQueryExecution",
      "athena:StopQueryExecution",
    ],
    "arn:aws:athena:*:*:workgroup/*",
    true,
    false,
  ),

  // Glue
  preset(
    "glue-catalog-read-only",
    "glue",
    "data-analytics",
    "read-only",
    ["glue:GetDatabase", "glue:GetTable", "glue:GetTables", "glue:GetPartitions"],
    "arn:aws:glue:*:*:table/*",
    true,
    true,
  ),
  preset(
    "glue-job-runner",
    "glue",
    "data-analytics",
    "read-write",
    ["glue:StartJobRun", "glue:GetJobRun", "glue:GetJobRuns", "glue:BatchStopJobRun"],
    "arn:aws:glue:*:*:job/*",
    true,
    false,
  ),

  // Lake Formation — sólo acciones de lectura clasificadas (exento de read-write)
  preset(
    "lakeformation-read-only",
    "lakeformation",
    "data-analytics",
    "read-only",
    [
      "lakeformation:GetDataAccess",
      "lakeformation:GetResourceLFTags",
      "lakeformation:SearchTablesByLFTags",
    ],
    "*",
    false,
    false,
  ),

  // Kinesis Firehose
  preset(
    "firehose-producer",
    "firehose",
    "data-analytics",
    "read-write",
    ["firehose:PutRecord", "firehose:PutRecordBatch", "firehose:DescribeDeliveryStream"],
    "arn:aws:firehose:*:*:deliverystream/*",
    true,
    false,
  ),
  preset(
    "firehose-read-only",
    "firehose",
    "data-analytics",
    "read-only",
    ["firehose:DescribeDeliveryStream"],
    "arn:aws:firehose:*:*:deliverystream/*",
    true,
    false,
  ),

  // Redshift Data API
  preset(
    "redshift-data-read-only",
    "redshift-data",
    "data-analytics",
    "read-only",
    [
      "redshift-data:GetStatementResult",
      "redshift-data:DescribeStatement",
      "redshift-data:ListStatements",
    ],
    "arn:aws:redshift:*:*:cluster:*",
    true,
    false,
  ),
  preset(
    "redshift-data-query-runner",
    "redshift-data",
    "data-analytics",
    "read-write",
    [
      "redshift-data:GetStatementResult",
      "redshift-data:DescribeStatement",
      "redshift-data:ListStatements",
      "redshift-data:ExecuteStatement",
      "redshift-data:BatchExecuteStatement",
    ],
    "arn:aws:redshift:*:*:cluster:*",
    true,
    false,
  ),

  // EMR (elasticmapreduce)
  preset(
    "emr-read-only",
    "elasticmapreduce",
    "data-analytics",
    "read-only",
    [
      "elasticmapreduce:DescribeCluster",
      "elasticmapreduce:ListClusters",
      "elasticmapreduce:ListSteps",
    ],
    "arn:aws:elasticmapreduce:*:*:cluster/*",
    true,
    false,
  ),
  preset(
    "emr-job-submitter",
    "elasticmapreduce",
    "data-analytics",
    "read-write",
    [
      "elasticmapreduce:DescribeCluster",
      "elasticmapreduce:ListClusters",
      "elasticmapreduce:ListSteps",
      "elasticmapreduce:AddJobFlowSteps",
      "elasticmapreduce:TerminateJobFlows",
    ],
    "arn:aws:elasticmapreduce:*:*:cluster/*",
    true,
    false,
  ),

  // MSK / Kafka (IAM auth)
  preset(
    "kafka-consumer",
    "kafka",
    "data-analytics",
    "read-write",
    [
      "kafka-cluster:Connect",
      "kafka-cluster:DescribeGroup",
      "kafka-cluster:ReadData",
      "kafka-cluster:DescribeTopic",
    ],
    "arn:aws:kafka:*:*:cluster/*",
    true,
    true,
  ),
  preset(
    "kafka-producer",
    "kafka",
    "data-analytics",
    "read-write",
    [
      "kafka-cluster:Connect",
      "kafka-cluster:WriteData",
      "kafka-cluster:DescribeTopic",
      "kafka-cluster:WriteDataIdempotently",
    ],
    "arn:aws:kafka:*:*:cluster/*",
    true,
    true,
  ),
  preset(
    "kafka-read-only",
    "kafka",
    "data-analytics",
    "read-only",
    ["kafka-cluster:DescribeGroup", "kafka-cluster:DescribeTopic"],
    "arn:aws:kafka:*:*:cluster/*",
    true,
    true,
  ),

  // SageMaker
  preset(
    "sagemaker-read-only",
    "sagemaker",
    "data-analytics",
    "read-only",
    ["sagemaker:DescribeEndpoint", "sagemaker:ListEndpoints", "sagemaker:DescribeModel"],
    "arn:aws:sagemaker:*:*:endpoint/*",
    true,
    false,
  ),
  preset(
    "sagemaker-invoker",
    "sagemaker",
    "data-analytics",
    "read-write",
    ["sagemaker:InvokeEndpoint"],
    "arn:aws:sagemaker:*:*:endpoint/*",
    true,
    false,
  ),

  // Datalake (S3, acotado al bucket del datalake)
  preset(
    "s3-datalake-read-only",
    "s3-datalake",
    "data-analytics",
    "read-only",
    ["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"],
    "arn:aws:s3:::*",
    true,
    true,
  ),
  preset(
    "s3-datalake-read-write",
    "s3-datalake",
    "data-analytics",
    "read-write",
    ["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation", "s3:PutObject", "s3:DeleteObject"],
    "arn:aws:s3:::*",
    true,
    true,
  ),
]

/** true si el valor es un objeto no nulo (candidato a preset). */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Congela un preset (y su lista de acciones) devolviendo una copia normalizada. */
function freezePreset(p: IamPreset): IamPreset {
  const frozen: IamPreset = {
    id: p.id,
    service: p.service,
    family: p.family,
    accessLevel: p.accessLevel,
    labelKey: p.labelKey,
    actions: Object.freeze([...p.actions]),
    defaultArnTemplate: p.defaultArnTemplate,
    scopable: p.scopable,
    allowWildcards: p.allowWildcards,
  }
  return Object.freeze(frozen)
}

/**
 * Reglas de integridad del catálogo (puro, TOTAL — nunca lanza). Filtra de la
 * colección publicada todo preset que:
 *  - comparta `id` con otro (excluye todos los que colisionan) (1.9),
 *  - tenga un `id` vacío o no-string,
 *  - tenga `actions` vacía, no-array, con no-strings o con duplicados (1.9, 1.1),
 *  - tenga `defaultArnTemplate` vacío,
 *  - incluya alguna acción del plano de datos RDS (1.7),
 *  - sea `read-only` y contenga alguna acción que no sea List/Read (1.5).
 * Congela recursivamente cada preset superviviente y la colección (1.6).
 */
export function buildPublishedCatalog(raw: readonly IamPreset[]): readonly IamPreset[] {
  if (!Array.isArray(raw)) return Object.freeze([])

  // Frecuencia de ids (sólo sobre presets con id string no vacío).
  const idCounts = new Map<string, number>()
  for (const p of raw) {
    if (isObjectLike(p) && typeof p.id === "string" && p.id.trim().length > 0) {
      idCounts.set(p.id, (idCounts.get(p.id) ?? 0) + 1)
    }
  }

  const published: IamPreset[] = []
  for (const p of raw) {
    if (!isObjectLike(p)) continue
    const id = p.id
    if (typeof id !== "string" || id.trim().length === 0) continue
    if ((idCounts.get(id) ?? 0) > 1) continue // id duplicado → excluir todos (1.9)

    const actions = p.actions
    if (!Array.isArray(actions) || actions.length === 0) continue
    if (actions.some((a) => typeof a !== "string")) continue
    if (new Set(actions).size !== actions.length) continue // acciones duplicadas (1.9)

    if (typeof p.defaultArnTemplate !== "string" || p.defaultArnTemplate.trim().length === 0) {
      continue
    }

    if (actions.some((a) => isRdsDataPlaneAction(a))) continue // plano de datos RDS (1.7)

    if (p.accessLevel === "read-only" && actions.some((a) => !isReadOnlyAction(a))) {
      continue // read-only con acción no List/Read (1.5)
    }

    published.push(freezePreset(p))
  }

  return Object.freeze(published)
}

/**
 * Aserción de arranque (no runtime del usuario) de la cobertura mínima del
 * catálogo (1.2/1.3). Se ejecuta una vez al cargar el módulo sobre el catálogo
 * publicado y lanza si no se cumple, para detectar en desarrollo/CI un catálogo
 * mal formado antes de servirlo. Regla:
 *  - ≥40 presets y ≥22 servicios distintos.
 *  - Cada servicio con ≥1 preset.
 *  - Todo servicio que exponga algún preset `read-write` DEBE ofrecer además un
 *    preset `read-only` y tener ≥2 presets.
 *  - Los servicios cuyo plano de acceso sólo expone acciones de lectura
 *    (p. ej. Lake Formation) quedan exentos del nivel `read-write`.
 */
function assertCatalogCoverage(catalog: readonly IamPreset[]): void {
  const MIN_PRESETS = 40
  const MIN_SERVICES = 22

  if (catalog.length < MIN_PRESETS) {
    throw new Error(
      `IAM catalog coverage: expected >= ${MIN_PRESETS} presets, got ${catalog.length}`,
    )
  }

  const services = new Set<AwsService>(catalog.map((p) => p.service))
  if (services.size < MIN_SERVICES) {
    throw new Error(
      `IAM catalog coverage: expected >= ${MIN_SERVICES} services, got ${services.size}`,
    )
  }

  for (const service of services) {
    const presets = catalog.filter((p) => p.service === service)
    const hasReadWrite = presets.some((p) => p.accessLevel === "read-write")
    const hasReadOnly = presets.some((p) => p.accessLevel === "read-only")
    if (hasReadWrite && (presets.length < 2 || !hasReadOnly)) {
      throw new Error(
        `IAM catalog coverage: service "${service}" exposes read-write but lacks a read-only preset or has < 2 presets`,
      )
    }
  }
}

/**
 * Colección publicada del Catálogo_IAM. Ha pasado por `buildPublishedCatalog`
 * (reglas de integridad + Object.freeze recursivo). Es la ÚNICA fuente de verdad.
 */
export const IAM_CATALOG: readonly IamPreset[] = buildPublishedCatalog(RAW_PRESETS)

// Aserción de arranque: valida la cobertura mínima al cargar el módulo.
assertCatalogCoverage(IAM_CATALOG)

/** Índice por id para lookup O(1) durante la generación. */
const PRESETS_BY_ID: ReadonlyMap<string, IamPreset> = new Map(
  IAM_CATALOG.map((p) => [p.id, p]),
)

/** Devuelve el preset con ese id, o `undefined` si no existe. TOTAL. */
export function getPresetById(id: string): IamPreset | undefined {
  if (typeof id !== "string") return undefined
  return PRESETS_BY_ID.get(id)
}

/** Presets publicados de una familia, en el orden del catálogo. */
export function listPresetsByFamily(family: ServiceFamily): readonly IamPreset[] {
  return Object.freeze(IAM_CATALOG.filter((p) => p.family === family))
}

/** Servicios distintos presentes en el catálogo publicado, en orden estable. */
export function listServices(): readonly AwsService[] {
  const seen = new Set<AwsService>()
  for (const p of IAM_CATALOG) seen.add(p.service)
  return Object.freeze([...seen].sort())
}

/**
 * Opciones de formulario deterministas derivadas del catálogo. Mismo contenido
 * y orden para el Formulario_Creacion y el Formulario_Modificacion (2.4/2.5).
 * Orden estable: family → service → id. Dos invocaciones son idénticas. Con un
 * catálogo vacío devuelve una lista vacía (2.6). TOTAL: nunca lanza.
 */
export function buildFormOptions(catalog: readonly IamPreset[]): readonly PresetFormOption[] {
  if (!Array.isArray(catalog)) return Object.freeze([])
  const options = catalog
    .filter((p): p is IamPreset => isObjectLike(p) && typeof (p as IamPreset).id === "string")
    .map((p) =>
      Object.freeze<PresetFormOption>({
        id: p.id,
        service: p.service,
        family: p.family,
        accessLevel: p.accessLevel,
        labelKey: p.labelKey,
        scopable: p.scopable,
        allowWildcards: p.allowWildcards,
      }),
    )
  options.sort((a, b) => {
    if (a.family !== b.family) return a.family < b.family ? -1 : 1
    if (a.service !== b.service) return a.service < b.service ? -1 : 1
    if (a.id !== b.id) return a.id < b.id ? -1 : 1
    return 0
  })
  return Object.freeze(options)
}
