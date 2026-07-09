"use client"

import { useState, useEffect, useMemo } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n"
import {
  IAM_CATALOG,
  buildFormOptions,
  getPresetById,
  type AwsService,
  type ServiceFamily,
  type PresetFormOption,
} from "@/lib/iam-catalog/catalog"
import { validateScope, type ArnValidation } from "@/lib/iam-catalog/arn"
import type { PresetSelection } from "@/lib/iam-catalog/generator"
import type { IamRoleFields } from "@/lib/infra-prompt-builder"

// ── Validation ───────────────────────────────────────────────────────────────

const ROLE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{2,63}$/
const NAMESPACE_RE = /^[a-z][a-z0-9-]{0,62}$/

const STANDARD_ENVS = ["dev", "uat", "prod"]

// Readable fallback labels for the family/service group headers. i18n keys are
// used first (with these as fallback), so translations can override later.
const FAMILY_FALLBACK: Record<ServiceFamily, string> = {
  application: "Aplicación / microservicio",
  "data-analytics": "Data & Analytics",
}

const SERVICE_FALLBACK: Record<AwsService, string> = {
  s3: "S3",
  sqs: "SQS",
  sns: "SNS",
  eventbridge: "EventBridge",
  dynamodb: "DynamoDB",
  secretsmanager: "Secrets Manager",
  ssm: "SSM Parameter Store",
  logs: "CloudWatch Logs",
  cloudwatch: "CloudWatch Metrics",
  kinesis: "Kinesis",
  lambda: "Lambda",
  states: "Step Functions",
  ses: "SES",
  bedrock: "Bedrock",
  athena: "Athena",
  glue: "Glue",
  lakeformation: "Lake Formation",
  firehose: "Kinesis Firehose",
  "redshift-data": "Redshift Data API",
  elasticmapreduce: "EMR",
  kafka: "MSK / Kafka",
  sagemaker: "SageMaker",
  "s3-datalake": "Datalake S3",
}

// ── Helpers (pure) ─────────────────────────────────────────────────────────

/** Splits raw ARN editor text (one ARN per line or comma-separated) into trimmed entries. */
function parseArnLines(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Result of validating one selected scopable preset's ARN editor content. */
interface PresetScope {
  accepted: string[]
  rejected: ArnValidation[]
  tooMany: boolean
}

// ── Props ────────────────────────────────────────────────────────────────────

export interface IamRoleFieldsProps {
  team: string
  onChange: (fields: IamRoleFields & { targetEnvironments: string[] }, valid: boolean) => void
}

// ── Component ────────────────────────────────────────────────────────────────

export function IamRoleFieldsPanel({ team, onChange }: IamRoleFieldsProps) {
  const { t } = useI18n()

  const [roleName, setRoleName] = useState("")
  const [namespace, setNamespace] = useState("")
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [arnText, setArnText] = useState<Record<string, string>>({})
  const [envs, setEnvs] = useState<string[]>([])

  const [roleNameTouched, setRoleNameTouched] = useState(false)
  const [namespaceTouched, setNamespaceTouched] = useState(false)

  const isTooling = team === "Tooling"

  // Catalog form options (single source of truth), grouped family → service.
  const options = useMemo(() => buildFormOptions(IAM_CATALOG), [])
  const catalogEmpty = options.length === 0

  const groups = useMemo(() => {
    const byFamily = new Map<ServiceFamily, Map<AwsService, PresetFormOption[]>>()
    for (const opt of options) {
      let services = byFamily.get(opt.family)
      if (!services) {
        services = new Map<AwsService, PresetFormOption[]>()
        byFamily.set(opt.family, services)
      }
      const list = services.get(opt.service) ?? []
      list.push(opt)
      services.set(opt.service, list)
    }
    return byFamily
  }, [options])

  useEffect(() => {
    if (isTooling) setEnvs(["tooling"])
  }, [isTooling])

  const roleNameError =
    roleNameTouched && roleName && !ROLE_NAME_RE.test(roleName)
      ? "Alfanuméricos, guiones y guiones bajos. Entre 3 y 64 caracteres, empieza con letra."
      : null

  const namespaceError =
    namespaceTouched && namespace && !NAMESPACE_RE.test(namespace)
      ? "Solo minúsculas, números y guiones. Entre 1 y 63 caracteres, empieza con letra."
      : null

  const targetEnvironments = isTooling ? ["tooling"] : envs

  // Validate the ARN editors of every selected scopable preset (client-side,
  // mirrors the pure module). Non-scopable presets always use the default ARN.
  const scopeByPreset = useMemo(() => {
    const result: Record<string, PresetScope> = {}
    for (const opt of options) {
      if (!selected[opt.id]) continue
      const preset = getPresetById(opt.id)
      if (!preset) continue
      if (!opt.scopable) {
        result[opt.id] = { accepted: [], rejected: [], tooMany: false }
        continue
      }
      const arns = parseArnLines(arnText[opt.id] ?? "")
      const scope = validateScope(arns, preset)
      result[opt.id] = {
        accepted: scope.accepted,
        rejected: scope.rejected,
        tooMany: scope.tooMany,
      }
    }
    return result
  }, [options, selected, arnText])

  // Build the structured preset selections emitted to the parent (accepted ARNs
  // only; empty ⇒ omit resourceArns so the generator uses the default template).
  const presetSelections = useMemo<PresetSelection[]>(() => {
    const out: PresetSelection[] = []
    for (const opt of options) {
      if (!selected[opt.id]) continue
      const scope = scopeByPreset[opt.id]
      if (scope && scope.accepted.length > 0) {
        out.push({ presetId: opt.id, resourceArns: scope.accepted })
      } else {
        out.push({ presetId: opt.id })
      }
    }
    return out
  }, [options, selected, scopeByPreset])

  // ── Validity ─────────────────────────────────────────────────────────────

  const roleValid = ROLE_NAME_RE.test(roleName)
  const nsValid = NAMESPACE_RE.test(namespace)
  const envsValid = targetEnvironments.length > 0
  const hasSelection = presetSelections.length > 0
  // Any selected preset with rejected ARNs or too many blocks submission.
  const scopeClean = Object.values(scopeByPreset).every(
    (s) => s.rejected.length === 0 && !s.tooMany,
  )
  const valid =
    !catalogEmpty && roleValid && nsValid && envsValid && hasSelection && scopeClean

  useEffect(() => {
    onChange(
      {
        roleName,
        servicePrincipal: "eks.amazonaws.com",
        policyType: "irsa",
        namespace,
        permissions: [],
        presetSelections,
        targetEnvironments,
      },
      valid,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleName, namespace, presetSelections, targetEnvironments.join(","), valid])

  // ── Handlers ───────────────────────────────────────────────────────────────

  const toggleEnv = (env: string) => {
    setEnvs((prev) => (prev.includes(env) ? prev.filter((e) => e !== env) : [...prev, env]))
  }

  const togglePreset = (id: string) => {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  // ── Catalog unavailable (defensive, 2.6) ────────────────────────────────

  if (catalogEmpty) {
    return (
      <div
        role="alert"
        className="rounded-md bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-400"
      >
        {t("iam.catalog.unavailable", "Las opciones de permiso no están disponibles en este momento. No es posible continuar con la solicitud.")}
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Role name */}
      <div className="space-y-1.5">
        <Label htmlFor="iam-rolename">Nombre del rol</Label>
        <Input
          id="iam-rolename"
          placeholder="mi-servicio-role"
          value={roleName}
          onChange={(e) => setRoleName(e.target.value)}
          onBlur={() => setRoleNameTouched(true)}
        />
        {roleNameError && <p className="text-xs text-red-500">{roleNameError}</p>}
        <p className="text-xs text-muted-foreground">Nombre del IAM Role para tu servicio en EKS (IRSA)</p>
      </div>

      {/* Namespace */}
      <div className="space-y-1.5">
        <Label htmlFor="iam-namespace">Namespace de Kubernetes</Label>
        <Input
          id="iam-namespace"
          placeholder="mi-namespace"
          value={namespace}
          onChange={(e) => setNamespace(e.target.value)}
          onBlur={() => setNamespaceTouched(true)}
        />
        {namespaceError && <p className="text-xs text-red-500">{namespaceError}</p>}
        <p className="text-xs text-muted-foreground">Namespace donde corre tu servicio en el cluster EKS</p>
      </div>

      {/* Permissions — catalog presets grouped by family → service */}
      <div className="space-y-3">
        <div>
          <Label>Permisos AWS necesarios</Label>
          <p className="text-xs text-muted-foreground">
            Selecciona los permisos de mínimo privilegio que necesita tu servicio. Cada permiso
            concede solo las acciones estrictamente necesarias.
          </p>
        </div>

        {[...groups.entries()].map(([family, services]) => (
          <div key={family} className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t(`iam.family.${family}`, FAMILY_FALLBACK[family])}
            </p>
            {[...services.entries()].map(([service, presets]) => (
              <div key={service} className="rounded-md border p-3 space-y-2">
                <p className="text-sm font-medium">
                  {t(`iam.service.${service}`, SERVICE_FALLBACK[service])}
                </p>
                <div className="space-y-2">
                  {presets.map((opt) => {
                    const scope = scopeByPreset[opt.id]
                    const isChecked = !!selected[opt.id]
                    return (
                      <div key={opt.id} className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id={`iam-preset-${opt.id}`}
                            checked={isChecked}
                            onCheckedChange={() => togglePreset(opt.id)}
                          />
                          <Label htmlFor={`iam-preset-${opt.id}`} className="font-normal">
                            {t(opt.labelKey, opt.id)}
                          </Label>
                        </div>

                        {/* ARN scope editor for scopable presets */}
                        {isChecked && opt.scopable && (
                          <div className="ml-6 space-y-1">
                            <textarea
                              id={`iam-arn-${opt.id}`}
                              rows={2}
                              placeholder={"arn:aws:...\narn:aws:... (uno por línea, opcional)"}
                              value={arnText[opt.id] ?? ""}
                              onChange={(e) =>
                                setArnText((prev) => ({ ...prev, [opt.id]: e.target.value }))
                              }
                              className={cn(
                                "flex w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
                              )}
                            />
                            <p className="text-[11px] text-muted-foreground">
                              Deja vacío para aplicar a todos los recursos del servicio. Máximo 50 ARNs.
                            </p>
                            {scope?.tooMany && (
                              <p className="text-xs text-red-500">{t("iam.arn.limit", "Se ha superado el límite máximo de 50 ARNs por permiso.")}</p>
                            )}
                            {scope?.rejected.map((r, i) => (
                              <p key={`${opt.id}-rej-${i}`} className="text-xs text-red-500 break-all">
                                <span className="font-mono">{r.arn || "(vacío)"}</span>
                                {" — "}
                                {t(`iam.arn.${r.code ?? "bad_format"}`, "ARN no válido.")}
                              </p>
                            ))}
                            {scope && scope.accepted.length > 0 && (
                              <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
                                {scope.accepted.length} ARN(s) válidos.
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        ))}

        {!hasSelection && (
          <p className="text-xs text-red-500">Selecciona al menos un permiso.</p>
        )}
      </div>

      {/* Target environments */}
      <div className="space-y-1.5">
        <Label>Entornos destino</Label>
        {isTooling ? (
          <p className="text-sm text-muted-foreground">Entorno: tooling (auto-seleccionado)</p>
        ) : (
          <div className="flex gap-4">
            {STANDARD_ENVS.map((env) => (
              <div key={env} className="flex items-center gap-1.5">
                <Checkbox
                  id={`iam-env-${env}`}
                  checked={envs.includes(env)}
                  onCheckedChange={() => toggleEnv(env)}
                />
                <Label htmlFor={`iam-env-${env}`} className="capitalize">{env}</Label>
              </div>
            ))}
          </div>
        )}
        {!isTooling && envs.length === 0 && (
          <p className="text-xs text-red-500">Selecciona al menos un entorno.</p>
        )}
      </div>
    </div>
  )
}
