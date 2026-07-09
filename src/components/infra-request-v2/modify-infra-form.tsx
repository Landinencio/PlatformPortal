"use client"

import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Loader2, CheckCircle2, AlertTriangle, ExternalLink, Send, Database, HardDrive, Shield, Settings, Plus, X, Globe } from "lucide-react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { SELECTABLE_APPROVERS } from "@/lib/infra-approvers"
import { useI18n } from "@/lib/i18n"
import {
  IAM_CATALOG,
  buildFormOptions,
  getPresetById,
  type PresetFormOption,
} from "@/lib/iam-catalog/catalog"
import { validateScope, type ArnRejectCode } from "@/lib/iam-catalog/arn"
import { validateManagedPolicyArn } from "@/lib/iam-catalog/validator"
import type { PresetSelection } from "@/lib/iam-catalog/generator"

interface ParsedResource {
  name: string
  terraformId: string
  type: string
  filePath: string
  environments?: string[]
  /** IAM only: catalog preset ids present in the role's current policy (6.2). */
  presetIds?: string[]
}

type FormStep = "select" | "modify" | "processing" | "submitting" | "success"

/**
 * Modification mode within the modify form.
 *
 * - `resource`         → AI-driven modifications of a specific resource
 *                        (existing behaviour, preserved byte-exact).
 * - `targetEnvironments` → deterministic add/remove of environments for the
 *                          selected resource (feature: infra-self-service-hardening,
 *                          task 11.2). Consumes `GET /modify/environments` and
 *                          `POST /modify` with `operation: "targetEnvironments"`.
 *
 * The mode is only shown once a resource has been picked and only for
 * `rds` / `s3` / `iam_role` (the three types the backend supports).
 */
type OperationMode = "resource" | "targetEnvironments"

/** Warning shape returned by `POST /modify` for the targetEnvironments op. */
interface TargetEnvironmentsWarning {
  code: string
  removedEnvironments?: string[]
  message?: string
}

/**
 * Mapping of the error codes surfaced by `GET /modify/environments`
 * (task 7.1) and by the deterministic branch of `POST /modify` (task 7.3) to
 * user-facing Spanish messages. Any code not listed here falls back to a
 * generic "no se pudo cargar" message so the UI never explodes on an
 * unexpected shape.
 */
const ENV_ERROR_MESSAGES: Record<string, string> = {
  missing_parameter: "Faltan parámetros obligatorios para consultar los entornos.",
  invalid_resource_type: "Este tipo de recurso no admite cambio de entornos.",
  invalid_identifier_charset: "El identificador del recurso contiene caracteres no válidos.",
  invalid_target_environments: "La selección de entornos no es válida (debe contener 1–3 valores únicos entre dev/uat/prod).",
  no_op_target_environments: "No hay cambios de entornos que aplicar: la selección coincide con la actual.",
  environments_expression_not_parseable: "No se pudo detectar la expresión de entornos en el fichero del recurso. Cambia los entornos con la operación AI o pide ayuda a Plataforma.",
  team_not_found: "No se encuentra el repositorio del equipo seleccionado.",
  resource_not_found: "El recurso ya no existe en el repositorio.",
  missing_tfvars_file: "Falta el fichero de variables para uno de los entornos solicitados.",
  route_disabled: "La operación de entornos aún no está disponible en este entorno.",
  unsupported_operation: "La operación de entornos aún no está habilitada en este entorno.",
}

/**
 * Resource types for which the deterministic `targetEnvironments` operation
 * is implemented on the backend (task 7.1/7.3).
 */
const TARGET_ENV_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "rds",
  "s3",
  "iam_role",
])

const RESOURCE_ICONS: Record<string, typeof Database> = {
  rds: Database,
  s3: HardDrive,
  iam_role: Shield,
}

const RESOURCE_LABELS: Record<string, string> = {
  rds: "RDS (PostgreSQL)",
  s3: "S3 Bucket",
  iam_role: "IAM Role",
}

const ALL_ENVS = ["dev", "uat", "prod"]

const INSTANCE_CLASSES = [
  { value: "db.t4g.micro", label: "db.t4g.micro (2 vCPU, 1 GB)" },
  { value: "db.t4g.small", label: "db.t4g.small (2 vCPU, 2 GB)" },
  { value: "db.t4g.medium", label: "db.t4g.medium (2 vCPU, 4 GB)" },
  { value: "db.t4g.large", label: "db.t4g.large (2 vCPU, 8 GB)" },
]

const S3_STORAGE_CLASSES = [
  { value: "STANDARD_IA", label: "Standard-IA" },
  { value: "ONEZONE_IA", label: "One Zone-IA" },
  { value: "GLACIER", label: "Glacier" },
  { value: "GLACIER_IR", label: "Glacier Instant Retrieval" },
  { value: "DEEP_ARCHIVE", label: "Deep Archive" },
]

// Catalog-derived preset options for the IAM "add permissions" section. Same
// source and order as the creation form (feature: iam-role-least-privilege,
// Req 2.5) — `buildFormOptions` yields a deterministic family → service → id
// ordering. Computed once at module load; the catalog is immutable.
const IAM_PRESET_OPTIONS: readonly PresetFormOption[] = buildFormOptions(IAM_CATALOG)

export interface ModifyInfraFormProps {
  teams: string[]
}

export function ModifyInfraForm({ teams }: ModifyInfraFormProps) {
  const { t } = useI18n()
  const [step, setStep] = useState<FormStep>("select")
  const [team, setTeam] = useState("")
  const [resourceType, setResourceType] = useState("")
  const [resources, setResources] = useState<ParsedResource[]>([])
  const [loadingResources, setLoadingResources] = useState(false)
  const [selectedResource, setSelectedResource] = useState<ParsedResource | null>(null)
  const [newEnvs, setNewEnvs] = useState<string[]>([])
  // RDS
  const [newInstanceClass, setNewInstanceClass] = useState("")
  const [newStorageGb, setNewStorageGb] = useState("")
  const [newMaxStorageGb, setNewMaxStorageGb] = useState("")
  const [newMultiAz, setNewMultiAz] = useState<"" | "true" | "false">("")
  const [newEngineVersion, setNewEngineVersion] = useState("")
  const [newBackupRetention, setNewBackupRetention] = useState("")
  const [newPerfInsights, setNewPerfInsights] = useState<"" | "true" | "false">("")
  // S3 lifecycle
  const [lifecycleEnabled, setLifecycleEnabled] = useState(false)
  const [expirationDays, setExpirationDays] = useState("")
  const [transitionDays, setTransitionDays] = useState("")
  const [transitionClass, setTransitionClass] = useState("STANDARD_IA")
  // IAM (feature: iam-role-least-privilege) — catalog-driven add/remove + managed ARNs
  // `iamAddIds`     → preset ids selected to ADD (6.3)
  // `iamArns`       → per-preset Scope_De_Recurso (one ARN per line, validated client-side)
  // `iamRemoveIds`  → current preset ids selected to REMOVE (6.2)
  // `iamManagedArns`→ custom managed-policy ARNs added (6.4), validated client-side
  const [iamAddIds, setIamAddIds] = useState<string[]>([])
  const [iamArns, setIamArns] = useState<Record<string, string>>({})
  const [iamRemoveIds, setIamRemoveIds] = useState<string[]>([])
  const [iamManagedArns, setIamManagedArns] = useState<string[]>([])
  const [customPolicy, setCustomPolicy] = useState("")
  const [customPolicyError, setCustomPolicyError] = useState<string | null>(null)

  const [approver, setApprover] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [successId, setSuccessId] = useState<number | null>(null)

  // ── Task 11.2 — targetEnvironments operation state ────────────────────────
  //
  // The environments operation is a separate branch: instead of the AI path
  // it fetches the current envs from `GET /modify/environments`, lets the
  // user tick dev/uat/prod, and POSTs `operation: "targetEnvironments"` to
  // `/modify`. The submit flow (approver + createNotificationBatch) is the
  // same as any other modify request.
  const [operationMode, setOperationMode] = useState<OperationMode>("resource")
  const [envLoading, setEnvLoading] = useState(false)
  const [envCurrent, setEnvCurrent] = useState<string[] | null>(null)
  const [envSelection, setEnvSelection] = useState<string[]>([])
  const [envError, setEnvError] = useState<string | null>(null)
  const [envWarnings, setEnvWarnings] = useState<TargetEnvironmentsWarning[]>([])

  // Reset all modification-specific fields (used on resource/type/team change)
  const resetModFields = () => {
    setNewInstanceClass("")
    setNewStorageGb("")
    setNewMaxStorageGb("")
    setNewMultiAz("")
    setNewEngineVersion("")
    setNewBackupRetention("")
    setNewPerfInsights("")
    setLifecycleEnabled(false)
    setExpirationDays("")
    setTransitionDays("")
    setTransitionClass("STANDARD_IA")
    setIamAddIds([])
    setIamArns({})
    setIamRemoveIds([])
    setIamManagedArns([])
    setCustomPolicy("")
    setCustomPolicyError(null)
    setEnvCurrent(null)
    setEnvSelection([])
    setEnvError(null)
    setEnvWarnings([])
    setOperationMode("resource")
  }

  /**
   * Loads the current environments for the selected resource from
   * `GET /api/infra-request-v2/modify/environments`. Called when the user
   * switches to the `targetEnvironments` operation and every time the target
   * resource changes while in that mode.
   *
   * All error paths map to a friendly Spanish message via
   * `ENV_ERROR_MESSAGES`; the fetch is idempotent (no side effects) so
   * retrying is safe.
   */
  const loadCurrentEnvironments = useCallback(
    async (opts: { team: string; resourceType: string; identifier: string }) => {
      setEnvLoading(true)
      setEnvError(null)
      try {
        const qs = new URLSearchParams({
          team: opts.team,
          resourceType: opts.resourceType,
          identifier: opts.identifier,
        })
        const res = await fetch(`/api/infra-request-v2/modify/environments?${qs.toString()}`)
        const data: {
          current?: string[]
          available?: string[]
          code?: string
        } = await res.json().catch(() => ({}))
        if (!res.ok) {
          const code = typeof data?.code === "string" ? data.code : "unknown"
          setEnvError(
            ENV_ERROR_MESSAGES[code] ??
              "No se pudo cargar la configuración de entornos del recurso.",
          )
          setEnvCurrent(null)
          setEnvSelection([])
          return
        }
        const current = Array.isArray(data?.current) ? data.current : []
        setEnvCurrent(current)
        // Pre-check the current envs so the user starts from the live state.
        setEnvSelection([...current])
      } catch {
        setEnvError("No se pudo cargar la configuración de entornos del recurso.")
        setEnvCurrent(null)
        setEnvSelection([])
      } finally {
        setEnvLoading(false)
      }
    },
    [],
  )

  // Fetch resources when team + type selected
  useEffect(() => {
    if (!team || !resourceType) { setResources([]); return }
    setLoadingResources(true)
    setSelectedResource(null)
    fetch("/api/infra-request-v2/list-resources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team, resourceType }),
    })
      .then(r => r.json())
      .then(data => setResources(data.resources || []))
      .catch(() => setResources([]))
      .finally(() => setLoadingResources(false))
  }, [team, resourceType])

  // When resource selected, pre-fill current envs and reset mod fields (M5 fix)
  useEffect(() => {
    if (selectedResource) {
      setNewEnvs(selectedResource.environments || ALL_ENVS)
      resetModFields()
      setStep("modify")
    }
  }, [selectedResource])

  // Load current envs whenever we enter the targetEnvironments operation
  // for a valid resource + type. If the type is not supported by the
  // backend (e.g. squad-*), fall back to the AI-driven mode.
  useEffect(() => {
    if (operationMode !== "targetEnvironments") return
    if (!selectedResource || !team || !resourceType) return
    if (!TARGET_ENV_RESOURCE_TYPES.has(resourceType)) {
      setOperationMode("resource")
      return
    }
    // Reset any previous state before firing the fetch.
    setEnvWarnings([])
    void loadCurrentEnvironments({
      team,
      resourceType,
      identifier: selectedResource.name,
    })
  }, [operationMode, selectedResource, team, resourceType, loadCurrentEnvironments])

  const toggleEnv = (env: string) => {
    setNewEnvs(prev => prev.includes(env) ? prev.filter(e => e !== env) : [...prev, env])
  }

  /**
   * Task 11.2 — toggle the selection for the deterministic
   * `targetEnvironments` operation. Kept separate from `toggleEnv` (which
   * feeds the AI path) so both flows can coexist without state bleed.
   */
  const toggleEnvSelection = (env: string) => {
    setEnvSelection(prev =>
      prev.includes(env) ? prev.filter(e => e !== env) : [...prev, env],
    )
  }

  // ── IAM helpers (feature: iam-role-least-privilege) ───────────────────────

  /** Toggle a catalog preset in the ADD selection (6.3). */
  const toggleIamAdd = (presetId: string) => {
    setIamAddIds(prev =>
      prev.includes(presetId) ? prev.filter(p => p !== presetId) : [...prev, presetId],
    )
  }

  /** Toggle a current preset id in the REMOVE selection (6.2). */
  const toggleIamRemove = (presetId: string) => {
    setIamRemoveIds(prev =>
      prev.includes(presetId) ? prev.filter(p => p !== presetId) : [...prev, presetId],
    )
  }

  /** Set the raw ARN text (one per line) for a scopable preset. */
  const setIamArnText = (presetId: string, value: string) => {
    setIamArns(prev => ({ ...prev, [presetId]: value }))
  }

  /** Split a textarea's raw content into candidate ARNs (blank lines dropped). */
  const parseArnLines = (raw: string | undefined): string[] =>
    (raw ?? "")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0)

  /**
   * Client-side scope validation for a preset's ARNs (immediate feedback,
   * 3.3/3.5/3.7). The server re-validates on submit. Returns the rejected ARNs
   * (with their i18n code) plus the too-many flag.
   */
  const arnFeedback = (option: PresetFormOption): { rejected: { arn: string; code?: ArnRejectCode }[]; tooMany: boolean } => {
    const preset = getPresetById(option.id)
    if (!preset) return { rejected: [], tooMany: false }
    const scope = validateScope(parseArnLines(iamArns[option.id]), preset)
    return {
      rejected: scope.rejected.map(r => ({ arn: r.arn, code: r.code })),
      tooMany: scope.tooMany,
    }
  }

  /**
   * Add a custom managed-policy ARN. Validated in the client with
   * `validateManagedPolicyArn` for immediate feedback (6.4); the server
   * re-validates before touching the repo (6.5). Admin-shaped ARNs are rejected
   * inline and never added.
   */
  const addCustomPolicy = () => {
    const arn = customPolicy.trim()
    if (!arn) return
    const result = validateManagedPolicyArn(arn)
    if (result.verdict === "Politica_Admin") {
      setCustomPolicyError(t(`iam.validator.${result.rule ?? "invalid_managed_arn"}`))
      return
    }
    if (!iamManagedArns.includes(arn)) {
      setIamManagedArns(prev => [...prev, arn])
    }
    setCustomPolicy("")
    setCustomPolicyError(null)
  }

  // Whether the user has actually requested at least one change beyond envs.
  const hasAnyChange = (): boolean => {
    const envsChanged =
      JSON.stringify([...newEnvs].sort()) !==
      JSON.stringify([...(selectedResource?.environments || ALL_ENVS)].sort())
    if (envsChanged) return true
    if (resourceType === "rds") {
      return Boolean(newInstanceClass) || newStorageGb !== "" || newMaxStorageGb !== "" ||
        newMultiAz !== "" || Boolean(newEngineVersion) || newBackupRetention !== "" || newPerfInsights !== ""
    }
    if (resourceType === "s3") {
      return lifecycleEnabled && (expirationDays !== "" || transitionDays !== "")
    }
    if (resourceType === "iam_role") {
      return iamAddIds.length > 0 || iamRemoveIds.length > 0 || iamManagedArns.length > 0
    }
    return false
  }

  const buildModifications = (): Record<string, unknown> => {
    const modifications: Record<string, unknown> = { targetEnvironments: newEnvs }
    if (resourceType === "rds") {
      if (newInstanceClass) modifications.instanceClass = newInstanceClass
      if (newStorageGb !== "") modifications.storageGb = Number(newStorageGb)
      if (newMaxStorageGb !== "") modifications.maxStorageGb = Number(newMaxStorageGb)
      if (newMultiAz !== "") modifications.multiAz = newMultiAz === "true"
      if (newEngineVersion) modifications.engineVersion = newEngineVersion
      if (newBackupRetention !== "") modifications.backupRetentionDays = Number(newBackupRetention)
      if (newPerfInsights !== "") modifications.performanceInsights = newPerfInsights === "true"
    } else if (resourceType === "s3" && lifecycleEnabled) {
      const lifecycleRules: Record<string, unknown> = {}
      if (expirationDays !== "") lifecycleRules.expirationDays = Number(expirationDays)
      if (transitionDays !== "") {
        lifecycleRules.transitions = [{ days: Number(transitionDays), storageClass: transitionClass }]
      }
      if (Object.keys(lifecycleRules).length > 0) modifications.lifecycleRules = lifecycleRules
    }
    return modifications
  }

  /**
   * Task 11.2 — deterministic target-environments submit.
   *
   * Sends `POST /api/infra-request-v2/modify` with the discriminated
   * `operation: "targetEnvironments"` payload; on success, forwards the
   * `terraformPreview` to `POST /api/infra-assistant/submit` exactly like
   * the AI branch does. Warnings from the preview (notably
   * `environment_removal_warning`) are surfaced to the user in an amber
   * banner BEFORE we call the submit endpoint, but we still submit so the
   * approver sees the same details in the request. Any 4xx from `/modify`
   * is mapped through {@link ENV_ERROR_MESSAGES}.
   */
  const submitTargetEnvironments = async () => {
    if (!selectedResource || !approver) return
    if (envSelection.length === 0) return
    // Local no-op guard so the round trip is avoided when the user hasn't
    // changed anything. The backend also returns 400 `no_op_target_environments`
    // in that case; we prefer to explain it inline without a spinner.
    const currentSorted = [...(envCurrent ?? [])].sort()
    const selectionSorted = [...envSelection].sort()
    if (
      currentSorted.length === selectionSorted.length &&
      currentSorted.every((e, i) => e === selectionSorted[i])
    ) {
      setError("No hay cambios: la selección coincide con los entornos actuales.")
      return
    }

    setStep("processing")
    setError(null)
    setEnvWarnings([])

    try {
      const modRes = await fetch("/api/infra-request-v2/modify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          team,
          resourceType,
          identifier: selectedResource.name,
          operation: "targetEnvironments",
          targetEnvironments: envSelection,
        }),
      })
      const modData: {
        terraformPreview?: {
          isModification?: boolean
          [k: string]: unknown
        }
        aiReply?: string
        warnings?: TargetEnvironmentsWarning[]
        code?: string
        error?: string
      } = await modRes.json().catch(() => ({}))

      if (!modRes.ok || !modData?.terraformPreview) {
        const code = typeof modData?.code === "string" ? modData.code : ""
        const message =
          ENV_ERROR_MESSAGES[code] ??
          modData?.error ??
          "No se pudo generar la modificación de entornos."
        setError(message)
        setStep("modify")
        return
      }

      const warnings = Array.isArray(modData.warnings) ? modData.warnings : []
      setEnvWarnings(warnings)

      // Mark the preview as a modification so the submit endpoint treats it
      // as an update-in-place (same flag the AI branch sets).
      modData.terraformPreview.isModification = true

      setStep("submitting")
      const submitRes = await fetch("/api/infra-assistant/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: `mod-envs-${Date.now()}`,
          conversation: [
            {
              role: "user",
              content: `[Modify targetEnvironments] ${resourceType} ${selectedResource.name} — envs: ${envSelection.join(",")}`,
              timestamp: new Date().toISOString(),
            },
            {
              role: "assistant",
              content: modData.aiReply || "",
              timestamp: new Date().toISOString(),
            },
          ],
          terraformPreview: modData.terraformPreview,
          team,
          approver,
        }),
      })
      const submitData = await submitRes.json().catch(() => ({}))

      if (!submitRes.ok) {
        setError(submitData?.error || "Error enviando la solicitud.")
        setStep("modify")
        return
      }

      setSuccessId(submitData.id)
      setStep("success")
    } catch {
      setError("Error procesando la modificación de entornos.")
      setStep("modify")
    }
  }

  /**
   * IAM role modification (feature: iam-role-least-privilege).
   *
   * Builds an `IamModifySelection`-shaped payload (addSelections,
   * removePresetIds, addManagedArns) and POSTs it to
   * `POST /api/infra-request-v2/modify` under the discriminated
   * `operation: "iamSelection"`. The server generates deterministic HCL
   * (generateIamRoleHcl + applyRemoval), re-validates managed ARNs
   * (validateManagedPolicyArn, 6.5) and returns the `terraformPreview`, which we
   * forward to `POST /api/infra-assistant/submit` exactly like the other
   * branches. Managed ARNs are also validated client-side on add for immediate
   * feedback (6.4).
   */
  const submitIamModification = async () => {
    if (!selectedResource || !approver) return
    if (!hasAnyChange()) return

    // Build the preset selections with their per-preset Scope_De_Recurso. Only
    // valid (accepted) ARNs are forwarded; blank/invalid lines are dropped here
    // and the server falls back to the preset default when the scope is empty.
    const addSelections: PresetSelection[] = iamAddIds.map(presetId => {
      const preset = getPresetById(presetId)
      const scope = preset ? validateScope(parseArnLines(iamArns[presetId]), preset) : null
      const resourceArns = scope ? scope.accepted : []
      return resourceArns.length > 0 ? { presetId, resourceArns } : { presetId }
    })

    const payload = {
      team,
      resourceType,
      resourceName: selectedResource.name,
      filePath: selectedResource.filePath,
      operation: "iamSelection" as const,
      addSelections,
      removePresetIds: iamRemoveIds,
      addManagedArns: iamManagedArns,
    }

    setStep("processing")
    setError(null)

    try {
      const modRes = await fetch("/api/infra-request-v2/modify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const modData = await modRes.json().catch(() => ({}))

      if (!modRes.ok || !modData?.terraformPreview) {
        setError(modData?.error || "No se pudo generar la modificación de permisos.")
        setStep("modify")
        return
      }

      modData.terraformPreview.isModification = true

      setStep("submitting")
      const summary = [
        addSelections.length > 0 ? `+${addSelections.length} preset(s)` : null,
        iamRemoveIds.length > 0 ? `-${iamRemoveIds.length} preset(s)` : null,
        iamManagedArns.length > 0 ? `+${iamManagedArns.length} managed ARN(s)` : null,
      ].filter(Boolean).join(", ")

      const submitRes = await fetch("/api/infra-assistant/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: `mod-iam-${Date.now()}`,
          conversation: [
            {
              role: "user",
              content: `[Modify IAM] ${selectedResource.name} — ${summary}`,
              timestamp: new Date().toISOString(),
            },
            {
              role: "assistant",
              content: modData.aiReply || "",
              timestamp: new Date().toISOString(),
            },
          ],
          terraformPreview: modData.terraformPreview,
          team,
          approver,
        }),
      })
      const submitData = await submitRes.json().catch(() => ({}))

      if (!submitRes.ok) {
        setError(submitData?.error || "Error enviando la solicitud.")
        setStep("modify")
        return
      }

      setSuccessId(submitData.id)
      setStep("success")
    } catch {
      setError("Error procesando la modificación de permisos.")
      setStep("modify")
    }
  }

  const handleSubmit = async () => {
    // Route to the deterministic branch when the operation mode is set.
    if (operationMode === "targetEnvironments") {
      await submitTargetEnvironments()
      return
    }
    // IAM roles use the catalog-driven selection path (deterministic HCL on the
    // server via generateIamRoleHcl / applyRemoval); RDS & S3 keep the AI path.
    if (resourceType === "iam_role") {
      await submitIamModification()
      return
    }
    if (!selectedResource || !approver || newEnvs.length === 0) return
    setStep("processing")
    setError(null)

    try {
      const modifications = buildModifications()

      const modRes = await fetch("/api/infra-request-v2/modify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          team,
          resourceType,
          resourceName: selectedResource.name,
          filePath: selectedResource.filePath,
          modifications,
        }),
      })
      const modData = await modRes.json()

      if (!modRes.ok || !modData.terraformPreview) {
        setError(modData.error || "No se pudo generar la modificación.")
        setStep("modify")
        return
      }

      modData.terraformPreview.isModification = true

      setStep("submitting")
      const submitRes = await fetch("/api/infra-assistant/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: `mod-${Date.now()}`,
          conversation: [
            { role: "user", content: `[Modify] ${resourceType} ${selectedResource.name} — envs: ${newEnvs.join(",")}`, timestamp: new Date().toISOString() },
            { role: "assistant", content: modData.aiReply || "", timestamp: new Date().toISOString() },
          ],
          terraformPreview: modData.terraformPreview,
          team,
          approver,
        }),
      })
      const submitData = await submitRes.json()

      if (!submitRes.ok) {
        setError(submitData.error || "Error enviando la solicitud.")
        setStep("modify")
        return
      }

      setSuccessId(submitData.id)
      setStep("success")
    } catch {
      setError("Error procesando la modificación.")
      setStep("modify")
    }
  }

  const resetAll = () => {
    setStep("select")
    setTeam("")
    setResourceType("")
    setResources([])
    setSelectedResource(null)
    setNewEnvs([])
    resetModFields()
    setApprover("")
    setError(null)
    setSuccessId(null)
  }

  if (step === "success") {
    return (
      <Card>
        <CardContent className="py-8 text-center space-y-4">
          <CheckCircle2 className="h-12 w-12 text-emerald-500 mx-auto" />
          <h2 className="text-lg font-semibold">Modificación enviada</h2>
          <p className="text-sm text-muted-foreground">
            La solicitud #{successId} ha sido enviada para aprobación.
          </p>
          <div className="flex items-center justify-center gap-2">
            <Link href="/infra-requests">
              <Button variant="outline" className="gap-1.5">
                <ExternalLink className="h-4 w-4" /> Ver solicitudes
              </Button>
            </Link>
            <Button variant="ghost" onClick={resetAll}>Nueva modificación</Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  const Icon = RESOURCE_ICONS[resourceType] || Settings
  const inFlight = step === "processing" || step === "submitting"

  return (
    <div className="space-y-6">
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-400">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1">{error}</div>
          <button onClick={() => setError(null)} className="text-xs underline">Cerrar</button>
        </div>
      )}

      {/* Team */}
      <div className="space-y-1.5">
        <Label htmlFor="mod-team">Equipo</Label>
        <Select value={team} onValueChange={v => { setTeam(v); setResourceType(""); setSelectedResource(null) }}>
          <SelectTrigger id="mod-team"><SelectValue placeholder="Selecciona un equipo..." /></SelectTrigger>
          <SelectContent>
            {teams.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* Resource type */}
      <div className="space-y-1.5">
        <Label htmlFor="mod-type">Tipo de recurso</Label>
        <Select value={resourceType} onValueChange={v => { setResourceType(v); setSelectedResource(null) }} disabled={!team}>
          <SelectTrigger id="mod-type"><SelectValue placeholder="Selecciona tipo..." /></SelectTrigger>
          <SelectContent>
            <SelectItem value="rds">RDS (PostgreSQL)</SelectItem>
            <SelectItem value="s3">S3</SelectItem>
            <SelectItem value="iam_role">IAM Role</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Resource list */}
      {resourceType && (
        <div className="space-y-1.5">
          <Label htmlFor="mod-resource">Recurso existente</Label>
          {loadingResources ? (
            <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Cargando recursos del repositorio...
            </div>
          ) : resources.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">No se encontraron recursos de este tipo.</p>
          ) : (
            <Select onValueChange={id => {
              const r = resources.find(res => res.terraformId === id)
              if (r) setSelectedResource(r)
            }}>
              <SelectTrigger id="mod-resource"><SelectValue placeholder="Selecciona recurso a modificar..." /></SelectTrigger>
              <SelectContent>
                {resources.map(r => (
                  <SelectItem key={r.terraformId} value={r.terraformId}>
                    {r.name}{r.environments ? ` (${r.environments.join(", ")})` : " (todos)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {/* Modification options */}
      {selectedResource && step === "modify" && (
        <>
          <Card>
            <CardContent className="pt-4 space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <Icon className="h-5 w-5 text-primary" />
                <span className="font-medium">{selectedResource.name}</span>
                <Badge variant="outline" className="text-[10px]">{RESOURCE_LABELS[resourceType] || resourceType}</Badge>
              </div>

              {/* Current environments */}
              <div className="text-xs text-muted-foreground">
                Entornos actuales: {selectedResource.environments?.join(", ") || "todos (dev, uat, prod)"}
              </div>

              {/* Operation-mode toggle (task 11.2). Only surfaced for resource
                  types the backend understands (rds/s3/iam_role). Squad-* and
                  other future types keep the AI branch as the only option. */}
              {TARGET_ENV_RESOURCE_TYPES.has(resourceType) && (
                <div className="flex flex-col gap-1.5">
                  <Label>Operación</Label>
                  <div className="flex gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={() => setOperationMode("resource")}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-all",
                        operationMode === "resource"
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-background text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                      )}
                    >
                      <Settings className="h-3.5 w-3.5" />
                      Cambios del recurso
                    </button>
                    <button
                      type="button"
                      onClick={() => setOperationMode("targetEnvironments")}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-all",
                        operationMode === "targetEnvironments"
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-background text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                      )}
                    >
                      <Globe className="h-3.5 w-3.5" />
                      Modificar entornos
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {operationMode === "resource"
                      ? "Solicita cambios en los atributos del recurso (asistido por IA)."
                      : "Añade o quita entornos donde vive el recurso (determinista, sin IA)."}
                  </p>
                </div>
              )}

              {/* ── AI-driven modifications (existing flow) ──────────────── */}
              {operationMode === "resource" && (
                <>
              {/* New environments — AI path (RDS/S3 only; IAM env changes use
                  the deterministic "Modificar entornos" operation) */}
              {resourceType !== "iam_role" && (
              <div className="space-y-1.5">
                <Label>Nuevos entornos</Label>
                <div className="flex gap-4">
                  {ALL_ENVS.map(env => (
                    <div key={env} className="flex items-center gap-1.5">
                      <Checkbox
                        id={`mod-env-${env}`}
                        checked={newEnvs.includes(env)}
                        onCheckedChange={() => toggleEnv(env)}
                      />
                      <Label htmlFor={`mod-env-${env}`} className="capitalize">{env}</Label>
                    </div>
                  ))}
                </div>
                {newEnvs.length === 0 && (
                  <p className="text-xs text-red-500">Selecciona al menos un entorno.</p>
                )}
              </div>
              )}

              {/* RDS-specific */}
              {resourceType === "rds" && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="mod-instance-class">Clase de instancia (opcional)</Label>
                    <Select value={newInstanceClass || "none"} onValueChange={v => setNewInstanceClass(v === "none" ? "" : v)}>
                      <SelectTrigger id="mod-instance-class"><SelectValue placeholder="Sin cambios" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Sin cambios</SelectItem>
                        {INSTANCE_CLASSES.map(ic => (
                          <SelectItem key={ic.value} value={ic.value}>{ic.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="mod-storage">Almacenamiento (GB)</Label>
                      <Input
                        id="mod-storage"
                        type="number"
                        min={20}
                        max={6144}
                        placeholder="Sin cambios"
                        value={newStorageGb}
                        onChange={e => setNewStorageGb(e.target.value)}
                      />
                      <p className="text-[10px] text-muted-foreground">Solo se puede ampliar, nunca reducir.</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="mod-max-storage">Máx. autoscaling (GB)</Label>
                      <Input
                        id="mod-max-storage"
                        type="number"
                        min={20}
                        max={6144}
                        placeholder="Sin cambios"
                        value={newMaxStorageGb}
                        onChange={e => setNewMaxStorageGb(e.target.value)}
                      />
                      <p className="text-[10px] text-muted-foreground">Debe ser ≥ almacenamiento.</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="mod-multiaz">Multi-AZ</Label>
                      <Select value={newMultiAz || "none"} onValueChange={v => setNewMultiAz(v === "none" ? "" : (v as "true" | "false"))}>
                        <SelectTrigger id="mod-multiaz"><SelectValue placeholder="Sin cambios" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Sin cambios</SelectItem>
                          <SelectItem value="true">Habilitado</SelectItem>
                          <SelectItem value="false">Deshabilitado</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="mod-perf-insights">Performance Insights</Label>
                      <Select value={newPerfInsights || "none"} onValueChange={v => setNewPerfInsights(v === "none" ? "" : (v as "true" | "false"))}>
                        <SelectTrigger id="mod-perf-insights"><SelectValue placeholder="Sin cambios" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Sin cambios</SelectItem>
                          <SelectItem value="true">Habilitado</SelectItem>
                          <SelectItem value="false">Deshabilitado</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="mod-engine-version">Versión PostgreSQL</Label>
                      <Select value={newEngineVersion || "none"} onValueChange={v => setNewEngineVersion(v === "none" ? "" : v)}>
                        <SelectTrigger id="mod-engine-version"><SelectValue placeholder="Sin cambios" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Sin cambios</SelectItem>
                          <SelectItem value="15">PostgreSQL 15</SelectItem>
                          <SelectItem value="16">PostgreSQL 16</SelectItem>
                          <SelectItem value="17">PostgreSQL 17</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-[10px] text-amber-600 dark:text-amber-400">Upgrade irreversible, puede requerir downtime.</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="mod-backup">Retención backup (días)</Label>
                      <Input
                        id="mod-backup"
                        type="number"
                        min={1}
                        max={35}
                        placeholder="Sin cambios"
                        value={newBackupRetention}
                        onChange={e => setNewBackupRetention(e.target.value)}
                      />
                    </div>
                  </div>
                </>
              )}

              {/* S3-specific: lifecycle rules */}
              {resourceType === "s3" && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="mod-lifecycle"
                      checked={lifecycleEnabled}
                      onCheckedChange={() => setLifecycleEnabled(v => !v)}
                    />
                    <Label htmlFor="mod-lifecycle">Configurar reglas de ciclo de vida</Label>
                  </div>
                  {lifecycleEnabled && (
                    <div className="space-y-3 pl-6">
                      <div className="space-y-1.5">
                        <Label htmlFor="mod-expiration">Expiración de objetos (días)</Label>
                        <Input
                          id="mod-expiration"
                          type="number"
                          min={1}
                          placeholder="Sin expiración"
                          value={expirationDays}
                          onChange={e => setExpirationDays(e.target.value)}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1.5">
                          <Label htmlFor="mod-transition-days">Transición (días)</Label>
                          <Input
                            id="mod-transition-days"
                            type="number"
                            min={1}
                            placeholder="Sin transición"
                            value={transitionDays}
                            onChange={e => setTransitionDays(e.target.value)}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="mod-transition-class">Clase destino</Label>
                          <Select value={transitionClass} onValueChange={setTransitionClass}>
                            <SelectTrigger id="mod-transition-class"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {S3_STORAGE_CLASSES.map(sc => (
                                <SelectItem key={sc.value} value={sc.value}>{sc.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* IAM-specific: catalog presets to add/remove + custom managed ARN */}
              {resourceType === "iam_role" && (
                <div className="space-y-4">
                  {/* Defensive: empty catalog blocks the flow (2.6) */}
                  {IAM_PRESET_OPTIONS.length === 0 ? (
                    <div role="alert" className="flex items-start gap-2 rounded-md bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-400">
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                      <div className="flex-1">{t("iam.catalog.unavailable")}</div>
                    </div>
                  ) : (
                    <>
                      {/* Remove current permissions (6.2) */}
                      <div className="space-y-1.5">
                        <Label>Quitar permisos actuales</Label>
                        {selectedResource.presetIds && selectedResource.presetIds.length > 0 ? (
                          <div className="space-y-1">
                            {selectedResource.presetIds.map(pid => (
                              <div key={pid} className="flex items-center gap-1.5">
                                <Checkbox
                                  id={`iam-remove-${pid}`}
                                  checked={iamRemoveIds.includes(pid)}
                                  onCheckedChange={() => toggleIamRemove(pid)}
                                />
                                <Label htmlFor={`iam-remove-${pid}`} className="text-xs">
                                  {t(`iam.preset.${pid}`, pid)}
                                </Label>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            No se han detectado permisos del catálogo en la política actual del rol.
                          </p>
                        )}
                      </div>

                      {/* Add catalog presets (6.3) — grouped by family → service */}
                      <div className="space-y-2">
                        <Label>Añadir permisos del catálogo</Label>
                        <div className="space-y-2">
                          {IAM_PRESET_OPTIONS.map(option => {
                            const checked = iamAddIds.includes(option.id)
                            const feedback = checked && option.scopable ? arnFeedback(option) : null
                            return (
                              <div key={option.id} className="rounded-md border border-border p-2 space-y-1.5">
                                <div className="flex items-center gap-1.5">
                                  <Checkbox
                                    id={`iam-add-${option.id}`}
                                    checked={checked}
                                    onCheckedChange={() => toggleIamAdd(option.id)}
                                  />
                                  <Label htmlFor={`iam-add-${option.id}`} className="text-xs">
                                    {t(`iam.preset.${option.id}`, option.id)}
                                  </Label>
                                  <Badge variant="outline" className="text-[9px] ml-auto">{option.service}</Badge>
                                </div>
                                {checked && option.scopable && (
                                  <div className="space-y-1 pl-6">
                                    <textarea
                                      aria-label={`ARNs para ${option.id}`}
                                      placeholder={"arn:aws:...\n(uno por línea; vacío = ámbito por defecto)"}
                                      value={iamArns[option.id] ?? ""}
                                      onChange={e => setIamArnText(option.id, e.target.value)}
                                      rows={2}
                                      className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs font-mono resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                    />
                                    {feedback?.tooMany && (
                                      <p className="text-[10px] text-red-500">{t("iam.arn.limit")}</p>
                                    )}
                                    {feedback?.rejected.map((r, i) => (
                                      <p key={`${r.arn}-${i}`} className="text-[10px] text-red-500">
                                        <span className="font-mono">{r.arn || "(vacío)"}</span>: {t(`iam.arn.${r.code ?? "bad_format"}`)}
                                      </p>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>

                      {/* Custom managed-policy ARN (6.4/6.5) */}
                      <div className="space-y-1.5">
                        <Label>ARN de managed policy personalizada</Label>
                        <div className="flex gap-2">
                          <Input
                            placeholder="arn:aws:iam::aws:policy/..."
                            value={customPolicy}
                            onChange={e => { setCustomPolicy(e.target.value); setCustomPolicyError(null) }}
                            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addCustomPolicy() } }}
                            className="text-xs font-mono"
                          />
                          <Button type="button" variant="outline" size="sm" onClick={addCustomPolicy} className="gap-1">
                            <Plus className="h-3 w-3" /> Añadir
                          </Button>
                        </div>
                        {customPolicyError && (
                          <p className="text-[10px] text-red-500">{customPolicyError}</p>
                        )}
                        {iamManagedArns.length > 0 && (
                          <div className="flex flex-wrap gap-1 pt-1">
                            {iamManagedArns.map(a => (
                              <Badge key={a} variant="secondary" className="text-[10px] gap-1 font-mono">
                                {a.split("/").pop()}
                                <button onClick={() => setIamManagedArns(prev => prev.filter(x => x !== a))}>
                                  <X className="h-2.5 w-2.5" />
                                </button>
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
                </>
              )}

              {/* ── Task 11.2 — deterministic targetEnvironments operation ── */}
              {operationMode === "targetEnvironments" && (
                <div className="space-y-3">
                  {envLoading && (
                    <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Cargando entornos actuales...
                    </div>
                  )}

                  {envError && (
                    <div
                      role="alert"
                      className="flex items-start gap-2 rounded-md bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-400"
                    >
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                      <div className="flex-1">{envError}</div>
                    </div>
                  )}

                  {!envLoading && !envError && envCurrent !== null && (
                    <>
                      <div className="space-y-1.5">
                        <Label>Entornos donde vivirá el recurso</Label>
                        <div className="flex gap-4">
                          {ALL_ENVS.map(env => (
                            <div key={env} className="flex items-center gap-1.5">
                              <Checkbox
                                id={`mod-target-env-${env}`}
                                checked={envSelection.includes(env)}
                                onCheckedChange={() => toggleEnvSelection(env)}
                              />
                              <Label
                                htmlFor={`mod-target-env-${env}`}
                                className="capitalize flex items-center gap-1"
                              >
                                {env}
                                {envCurrent.includes(env) && (
                                  <Badge variant="outline" className="text-[9px]">
                                    activo
                                  </Badge>
                                )}
                              </Label>
                            </div>
                          ))}
                        </div>
                        {envSelection.length === 0 && (
                          <p className="text-xs text-red-500">
                            Selecciona al menos un entorno.
                          </p>
                        )}
                        <p className="text-[10px] text-muted-foreground">
                          Actual: {envCurrent.length > 0 ? envCurrent.join(", ") : "(ninguno)"}
                        </p>
                      </div>

                      {envWarnings.length > 0 && (
                        <div
                          role="alert"
                          className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-700 dark:text-amber-400"
                        >
                          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                          <div className="flex-1 space-y-1">
                            {envWarnings.map((w, i) => (
                              <div key={`${w.code}-${i}`}>
                                <span className="font-medium">
                                  {w.code === "environment_removal_warning"
                                    ? "Retirada de entornos: "
                                    : `${w.code}: `}
                                </span>
                                {w.message ??
                                  "El próximo terraform apply destruirá el recurso en estos entornos; verifica antes de aprobar."}
                                {Array.isArray(w.removedEnvironments) &&
                                  w.removedEnvironments.length > 0 && (
                                    <span className="ml-1 font-mono text-[11px]">
                                      ({w.removedEnvironments.join(", ")})
                                    </span>
                                  )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Approver */}
          <div className="space-y-1.5">
            <Label htmlFor="mod-approver">Aprobador</Label>
            <Select value={approver} onValueChange={setApprover}>
              <SelectTrigger id="mod-approver"><SelectValue placeholder="Selecciona quién debe aprobar..." /></SelectTrigger>
              <SelectContent>
                {SELECTABLE_APPROVERS.map(a => (
                  <SelectItem key={a.email} value={a.email}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {!hasAnyChange() && operationMode === "resource" && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Indica al menos un cambio (entornos, recursos, permisos o ciclo de vida) antes de solicitar la modificación.
            </p>
          )}

          <Button
            onClick={handleSubmit}
            disabled={
              operationMode === "targetEnvironments"
                ? envSelection.length === 0 ||
                  !approver ||
                  envLoading ||
                  envCurrent === null ||
                  envError !== null ||
                  inFlight
                : resourceType === "iam_role"
                  ? !approver || !hasAnyChange() || inFlight
                  : newEnvs.length === 0 || !approver || !hasAnyChange() || inFlight
            }
            className="w-full gap-2"
          >
            <Send className="h-4 w-4" /> Solicitar modificación
          </Button>
        </>
      )}

      {inFlight && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {step === "processing" ? "Generando modificación..." : "Enviando solicitud..."}
        </div>
      )}
    </div>
  )
}
