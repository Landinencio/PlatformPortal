"use client"

import { useState, useEffect, useCallback } from "react"
import { AlertTriangle } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import type { RdsFields } from "@/lib/infra-prompt-builder"
import {
  SUPPORTED_ENGINES,
  versionsForEngine,
  defaultVersionForEngine,
  familyForVersion,
  isValidEngineVersion,
  reconcileVersionOnEngineChange,
  type RdsEngine,
} from "@/lib/rds/version-catalog"

// ── Validation ───────────────────────────────────────────────────────────────

// Identifier: starts with a letter, ends with alphanumeric (no leading/trailing
// hyphen — matches the server-side validateRdsFields rule), 3–63 chars total.
const IDENTIFIER_RE = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/
const DB_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/

// ── Instance class options ───────────────────────────────────────────────────

const INSTANCE_CLASSES = [
  { value: "db.t4g.micro",  label: "db.t4g.micro  (2 vCPU, 1 GB)" },
  { value: "db.t4g.small",  label: "db.t4g.small  (2 vCPU, 2 GB)" },
  { value: "db.t4g.medium", label: "db.t4g.medium (2 vCPU, 4 GB)" },
  { value: "db.t4g.large",  label: "db.t4g.large  (2 vCPU, 8 GB)" },
]

const STANDARD_ENVS = ["dev", "uat", "prod"]

// ── Engine / version labelling ────────────────────────────────────────────────

/** Human-readable engine name for the Motor selector and labels (R7.4). */
function engineLabel(engine: RdsEngine): string {
  // PostgreSQL is the only supported engine for new RDS instances.
  return engine === "postgres" ? "PostgreSQL" : engine
}

/** Label for a version option, marking the per-engine Version_Estandar. */
function versionOptionLabel(engine: RdsEngine, version: string): string {
  const isDefault = version === defaultVersionForEngine(engine)
  return `${engineLabel(engine)} ${version}${isDefault ? " (recomendada)" : ""}`
}

// ── Props ────────────────────────────────────────────────────────────────────

export interface RdsFieldsProps {
  team: string
  onChange: (fields: RdsFields & { targetEnvironments: string[] }, valid: boolean) => void
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_ENGINE: RdsEngine = "postgres"

const DEFAULTS = {
  identifier: "",
  dbName: "",
  instanceClass: "db.t4g.micro",
  storageGb: 20,
  multiAz: false,
  engine: DEFAULT_ENGINE,
  // Version_Estandar of the default engine (R2.2).
  engineVersion: defaultVersionForEngine(DEFAULT_ENGINE),
}

// ── Component ────────────────────────────────────────────────────────────────

export function RdsFieldsPanel({ team, onChange }: RdsFieldsProps) {
  const [identifier, setIdentifier] = useState(DEFAULTS.identifier)
  const [dbName, setDbName] = useState(DEFAULTS.dbName)
  const [instanceClass, setInstanceClass] = useState(DEFAULTS.instanceClass)
  const [storageGb, setStorageGb] = useState(DEFAULTS.storageGb)
  const [multiAz, setMultiAz] = useState(DEFAULTS.multiAz)
  const [engine, setEngine] = useState<RdsEngine>(DEFAULTS.engine)
  // engineVersion may be "" ("sin selección") when the engine catalog is empty.
  const [engineVersion, setEngineVersion] = useState<string>(DEFAULTS.engineVersion)
  const [envs, setEnvs] = useState<string[]>([])

  const [identifierTouched, setIdentifierTouched] = useState(false)
  const [dbNameTouched, setDbNameTouched] = useState(false)

  // ── Catalogo_Dinamico stale notice (task 11.1, Req 1.9) ─────────────────────
  // We fetch the dynamic catalog only to detect `stale: true` in the response.
  // Version selection itself still uses the static `versionsForEngine()` here
  // to preserve the baseline behaviour byte-exact (Req 7.3). If the endpoint
  // returns 404 (feature flag off), 502 (AWS unavailable) or any error, we
  // simply skip the notice — the form remains fully usable.
  //
  // `staleSince` is an ISO 8601 UTC string emitted by the Catalogo_Dinamico;
  // we format it with the browser's locale (`es-ES`) so requestors see the
  // fecha + hora locales del navegador (Req 1.9 acceptance criterion).
  const [staleSince, setStaleSince] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setStaleSince(null) // reset when engine changes; the effect below repopulates
    const controller = new AbortController()
    fetch(`/api/infra-request-v2/rds-engines?engine=${encodeURIComponent(engine)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok) return null // 404 (flag off) / 502 / 4xx → silent no-op
        const body = (await res.json()) as {
          ok?: boolean
          options?: Array<{ stale?: boolean; staleSince?: string }>
        }
        if (!body?.ok || !Array.isArray(body.options)) return null
        // Req 1.7: when the response is served as Fallback_Catalogo, every
        // option carries `stale: true` and the same `staleSince`. We surface
        // the first non-empty `staleSince` we find; if none is present we
        // clear the notice.
        const staleOpt = body.options.find(
          (o) => o?.stale === true && typeof o.staleSince === "string" && o.staleSince.length > 0,
        )
        return staleOpt?.staleSince ?? null
      })
      .then((iso) => {
        if (!cancelled) setStaleSince(iso ?? null)
      })
      .catch(() => {
        // Aborted or network error → keep the notice hidden, form stays usable.
        if (!cancelled) setStaleSince(null)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [engine])

  // Format `staleSince` (ISO 8601 UTC) as browser-local es-ES date + time.
  // Kept memoisation trivial: the string only changes when the API call
  // resolves, which is at most once per engine change.
  const staleSinceFormatted = staleSince
    ? (() => {
        const d = new Date(staleSince)
        return Number.isNaN(d.getTime())
          ? staleSince
          : d.toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" })
      })()
    : null

  const isTooling = team === "Tooling"

  // Auto-select tooling env when team is Tooling
  useEffect(() => {
    if (isTooling) setEnvs(["tooling"])
  }, [isTooling])

  // Version options driven by the catalog for the selected engine (R1.3, R2.1).
  const versionOptions = versionsForEngine(engine)
  const catalogEmpty = versionOptions.length === 0

  // Reset/reconcile the selected version when the engine changes (R1.4).
  const handleEngineChange = (value: string) => {
    if (!SUPPORTED_ENGINES.includes(value as RdsEngine)) return
    const nextEngine = value as RdsEngine
    setEngine(nextEngine)
    // Keep the version if it belongs to the new engine's catalog, otherwise fall
    // back to the engine default (or "" when the catalog is empty).
    setEngineVersion(prev => reconcileVersionOnEngineChange(nextEngine, prev) ?? "")
  }

  const identifierError = identifierTouched && identifier && !IDENTIFIER_RE.test(identifier)
    ? "Solo minúsculas, números y guiones. Entre 3 y 63 caracteres, empieza con letra."
    : null

  const dbNameError = dbNameTouched && dbName && !DB_NAME_RE.test(dbName)
    ? "Solo minúsculas, números y guiones bajos. Entre 1 y 63 caracteres, empieza con letra."
    : null

  const targetEnvironments = isTooling ? ["tooling"] : envs

  // Derived family from the catalog (R2.4); undefined when there is no valid pair.
  const family = familyForVersion(engine, engineVersion) ?? undefined

  // Notify parent on every change
  const notify = useCallback(() => {
    const identifierValid = IDENTIFIER_RE.test(identifier)
    const dbNameValid = DB_NAME_RE.test(dbName)
    const envsValid = targetEnvironments.length > 0
    // Block submit when the engine catalog is empty (R2.6) or no valid version
    // is selected (R1.4).
    const versionValid = !catalogEmpty && isValidEngineVersion(engine, engineVersion)
    const valid = identifierValid && dbNameValid && envsValid && versionValid

    onChange(
      {
        identifier, dbName, instanceClass, storageGb, multiAz,
        engine, engineVersion, family, targetEnvironments,
      },
      valid,
    )
  }, [
    identifier, dbName, instanceClass, storageGb, multiAz,
    engine, engineVersion, family, catalogEmpty, targetEnvironments, onChange,
  ])

  useEffect(() => { notify() }, [notify])

  const toggleEnv = (env: string) => {
    setEnvs(prev => prev.includes(env) ? prev.filter(e => e !== env) : [...prev, env])
  }

  return (
    <div className="space-y-4">
      {/* Identifier */}
      <div className="space-y-1.5">
        <Label htmlFor="rds-identifier">Identificador</Label>
        <Input
          id="rds-identifier"
          placeholder="mi-base-datos"
          value={identifier}
          onChange={e => setIdentifier(e.target.value)}
          onBlur={() => setIdentifierTouched(true)}
        />
        {identifierError && <p className="text-xs text-red-500">{identifierError}</p>}
      </div>

      {/* Database name */}
      <div className="space-y-1.5">
        <Label htmlFor="rds-dbname">Nombre de base de datos</Label>
        <Input
          id="rds-dbname"
          placeholder="mi_base"
          value={dbName}
          onChange={e => setDbName(e.target.value)}
          onBlur={() => setDbNameTouched(true)}
        />
        {dbNameError && <p className="text-xs text-red-500">{dbNameError}</p>}
      </div>

      {/* Instance class */}
      <div className="space-y-1.5">
        <Label>Clase de instancia</Label>
        <Select value={instanceClass} onValueChange={setInstanceClass}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INSTANCE_CLASSES.map(ic => (
              <SelectItem key={ic.value} value={ic.value}>{ic.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Engine (Motor) — exactly postgres / mysql, default postgres (R1.1, R1.2) */}
      <div className="space-y-1.5">
        <Label>Motor</Label>
        <Select value={engine} onValueChange={handleEngineChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPORTED_ENGINES.map(e => (
              <SelectItem key={e} value={e}>{engineLabel(e)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Engine version — driven by the catalog for the selected engine (R2.1, R2.2, R2.3) */}
      <div className="space-y-1.5">
        <Label>Versión del motor</Label>
        <Select
          value={engineVersion}
          onValueChange={setEngineVersion}
          disabled={catalogEmpty}
        >
          <SelectTrigger>
            <SelectValue placeholder="Selecciona una versión..." />
          </SelectTrigger>
          <SelectContent>
            {versionOptions.map(v => (
              <SelectItem key={v.version} value={v.version}>
                {versionOptionLabel(engine, v.version)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/*
          Stale notice (task 11.1, Req 1.9). Non-blocking: no `role="alert"`,
          no `aria-live="assertive"`, and it does not toggle `disabled` on the
          version selector. The submit path is untouched.
        */}
        {staleSinceFormatted && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 p-2 text-xs text-amber-700 dark:text-amber-400"
          >
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              Estás viendo la última lista conocida (actualizada por última vez el {staleSinceFormatted})
            </span>
          </div>
        )}
        {catalogEmpty ? (
          <p className="text-xs text-red-500">
            No hay versiones disponibles para {engineLabel(engine)}.
          </p>
        ) : (
          // Show the selected engine + version continuously before submit (R2.7).
          <p className="text-xs text-muted-foreground">
            Seleccionado: {engineLabel(engine)} {engineVersion}
            {family ? ` · familia ${family}` : ""}
          </p>
        )}
      </div>

      {/* Storage */}
      <div className="space-y-1.5">
        <Label htmlFor="rds-storage">Almacenamiento (GB)</Label>
        <Input
          id="rds-storage"
          type="number"
          min={20}
          max={1000}
          value={storageGb}
          onChange={e => setStorageGb(Number(e.target.value) || 20)}
        />
      </div>

      {/* Multi-AZ */}
      <div className="flex items-center gap-2">
        <Checkbox
          id="rds-multiaz"
          checked={multiAz}
          onCheckedChange={v => setMultiAz(v === true)}
        />
        <Label htmlFor="rds-multiaz">Multi-AZ</Label>
      </div>

      {/* Target environments */}
      <div className="space-y-1.5">
        <Label>Entornos destino</Label>
        {isTooling ? (
          <p className="text-sm text-muted-foreground">Entorno: tooling (auto-seleccionado)</p>
        ) : (
          <div className="flex gap-4">
            {STANDARD_ENVS.map(env => (
              <div key={env} className="flex items-center gap-1.5">
                <Checkbox
                  id={`rds-env-${env}`}
                  checked={envs.includes(env)}
                  onCheckedChange={() => toggleEnv(env)}
                />
                <Label htmlFor={`rds-env-${env}`} className="capitalize">{env}</Label>
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
