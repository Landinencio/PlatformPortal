"use client"

import { useState, useEffect, useCallback } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import type { S3Fields } from "@/lib/infra-prompt-builder"

// ── Validation ───────────────────────────────────────────────────────────────

const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
// AWS reserves bucket names containing "aws"/"amazon" — mirror server validateS3Fields.
const BUCKET_RESERVED_RE = /aws|amazon/i

function bucketNameError(name: string): string | null {
  if (!BUCKET_NAME_RE.test(name)) {
    return "Solo minúsculas, números, puntos y guiones. Entre 3 y 63 caracteres."
  }
  if (BUCKET_RESERVED_RE.test(name)) {
    return 'El nombre no puede contener "aws" ni "amazon".'
  }
  return null
}

const STANDARD_ENVS = ["dev", "uat", "prod"]

// ── Props ────────────────────────────────────────────────────────────────────

export interface S3FieldsProps {
  team: string
  onChange: (fields: S3Fields & { targetEnvironments: string[] }, valid: boolean) => void
}

// ── Component ────────────────────────────────────────────────────────────────

export function S3FieldsPanel({ team, onChange }: S3FieldsProps) {
  const [bucketName, setBucketName] = useState("")
  const [versioning, setVersioning] = useState(false)
  const [lifecycleEnabled, setLifecycleEnabled] = useState(false)
  const [lifecycleExpirationDays, setLifecycleExpirationDays] = useState("")
  const [lifecycleTransitionDays, setLifecycleTransitionDays] = useState("")
  const [lifecycleTransitionClass, setLifecycleTransitionClass] = useState("STANDARD_IA")
  const [envs, setEnvs] = useState<string[]>([])
  const [bucketTouched, setBucketTouched] = useState(false)

  const isTooling = team === "Tooling" || team === "tooling"

  useEffect(() => {
    if (isTooling) setEnvs(["tooling"])
  }, [isTooling])

  const bucketError = bucketTouched && bucketName ? bucketNameError(bucketName) : null

  const targetEnvironments = isTooling ? ["tooling"] : envs

  // Build lifecycle rules string from form fields
  const lifecycleRules = lifecycleEnabled
    ? [
        lifecycleExpirationDays ? `Expiración: ${lifecycleExpirationDays} días` : "",
        lifecycleTransitionDays ? `Transición a ${lifecycleTransitionClass}: ${lifecycleTransitionDays} días` : "",
      ].filter(Boolean).join(". ") || undefined
    : undefined

  const notify = useCallback(() => {
    const bucketValid = BUCKET_NAME_RE.test(bucketName) && !BUCKET_RESERVED_RE.test(bucketName)
    const envsValid = targetEnvironments.length > 0
    const valid = bucketValid && envsValid

    onChange(
      {
        bucketName,
        versioning,
        encryptionType: "AES-256", // Always AES-256
        lifecycleRules,
        targetEnvironments,
      },
      valid,
    )
  }, [bucketName, versioning, lifecycleRules, targetEnvironments, onChange])

  useEffect(() => { notify() }, [notify])

  const toggleEnv = (env: string) => {
    setEnvs(prev => prev.includes(env) ? prev.filter(e => e !== env) : [...prev, env])
  }

  return (
    <div className="space-y-4">
      {/* Bucket name */}
      <div className="space-y-1.5">
        <Label htmlFor="s3-bucket">Nombre del bucket</Label>
        <Input
          id="s3-bucket"
          placeholder="mi-bucket-datos"
          value={bucketName}
          onChange={e => setBucketName(e.target.value)}
          onBlur={() => setBucketTouched(true)}
        />
        {bucketError && <p className="text-xs text-red-500">{bucketError}</p>}
      </div>

      {/* Versioning with explanation */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Checkbox
            id="s3-versioning"
            checked={versioning}
            onCheckedChange={v => setVersioning(v === true)}
          />
          <Label htmlFor="s3-versioning">Versionado</Label>
        </div>
        <p className="text-xs text-muted-foreground ml-6">
          {versioning
            ? "⚠️ Activado: Cada versión de un objeto se conserva. Útil para recuperación ante borrados accidentales. Incrementa costes de almacenamiento (cada versión ocupa espacio). Recomendado combinar con reglas de ciclo de vida para expirar versiones antiguas."
            : "Desactivado: Solo se conserva la última versión de cada objeto. Menor coste pero sin posibilidad de recuperar versiones anteriores."}
        </p>
      </div>

      {/* Encryption — fixed AES-256, informational only */}
      <div className="space-y-1.5">
        <Label>Cifrado</Label>
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
          <span className="font-medium">AES-256</span>
          <span className="text-xs text-muted-foreground">(cifrado por defecto, sin coste adicional)</span>
        </div>
      </div>

      {/* Lifecycle rules — structured form */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id="s3-lifecycle-toggle"
            checked={lifecycleEnabled}
            onCheckedChange={v => setLifecycleEnabled(v === true)}
          />
          <Label htmlFor="s3-lifecycle-toggle">Reglas de ciclo de vida (opcional)</Label>
        </div>

        {lifecycleEnabled && (
          <div className="ml-6 space-y-3 rounded-md border border-border bg-muted/20 p-3">
            <div className="space-y-1.5">
              <Label htmlFor="s3-expiration" className="text-xs">Expirar objetos después de (días)</Label>
              <Input
                id="s3-expiration"
                type="number"
                min="1"
                placeholder="90"
                value={lifecycleExpirationDays}
                onChange={e => setLifecycleExpirationDays(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">Los objetos se eliminan automáticamente tras este período.</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="s3-transition" className="text-xs">Transicionar a storage class después de (días)</Label>
              <div className="flex gap-2">
                <Input
                  id="s3-transition"
                  type="number"
                  min="1"
                  placeholder="30"
                  value={lifecycleTransitionDays}
                  onChange={e => setLifecycleTransitionDays(e.target.value)}
                  className="w-24"
                />
                <Select value={lifecycleTransitionClass} onValueChange={setLifecycleTransitionClass}>
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="STANDARD_IA">Standard-IA (acceso infrecuente)</SelectItem>
                    <SelectItem value="GLACIER">Glacier (archivo)</SelectItem>
                    <SelectItem value="DEEP_ARCHIVE">Deep Archive (archivo profundo)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-[11px] text-muted-foreground">Mueve objetos a un storage más barato tras este período.</p>
            </div>
          </div>
        )}
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
                  id={`s3-env-${env}`}
                  checked={envs.includes(env)}
                  onCheckedChange={() => toggleEnv(env)}
                />
                <Label htmlFor={`s3-env-${env}`} className="capitalize">{env}</Label>
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
