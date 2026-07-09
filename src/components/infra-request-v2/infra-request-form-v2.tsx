"use client"

import { useState, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Loader2, CheckCircle2, AlertTriangle, ExternalLink, Send } from "lucide-react"
import Link from "next/link"
import { useI18n } from "@/lib/i18n"

import { RdsFieldsPanel } from "./rds-fields"
import { SuccessTimeline } from "./success-timeline"
import { S3FieldsPanel } from "./s3-fields"
import { IamRoleFieldsPanel } from "./iam-role-fields"
import { CostEstimatePanel } from "./cost-estimate-panel"
import { SELECTABLE_APPROVERS } from "@/lib/infra-approvers"
import { BUSINESS_TEAMS, BUSINESS_TEAM_LABELS, getApproversForTeam, type BusinessTeam, INFRA_BUSINESS_TEAMS } from "@/lib/team-approvers"
import type { RdsFields, S3Fields, IamRoleFields } from "@/lib/infra-prompt-builder"

// ── Types ────────────────────────────────────────────────────────────────────

type FormStep = "form" | "processing" | "submitting" | "success"
type ResourceType = "rds" | "s3" | "iam_role"

interface FieldState {
  fields: (RdsFields | S3Fields | IamRoleFields) & { targetEnvironments: string[] }
  valid: boolean
}

export interface InfraRequestFormV2Props {
  teams: string[]
}

// ── Component ────────────────────────────────────────────────────────────────

export function InfraRequestFormV2({ teams }: InfraRequestFormV2Props) {
  const [step, setStep] = useState<FormStep>("form")
  const [team, setTeam] = useState("")
  const [resourceType, setResourceType] = useState<ResourceType | "">("")
  const [fieldState, setFieldState] = useState<FieldState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [approver, setApprover] = useState("")
  const [successId, setSuccessId] = useState<number | null>(null)

  const fieldStateRef = useRef(fieldState)
  fieldStateRef.current = fieldState

  const canSubmit = team && resourceType && fieldState?.valid && approver

  const handleResourceTypeChange = (val: string) => {
    setResourceType(val as ResourceType)
    setFieldState(null)
    setError(null)
  }

  const handleFieldChange = useCallback(
    (fields: any, valid: boolean) => { setFieldState({ fields, valid }) },
    [],
  )

  // ── Full flow: generate terraform + submit in one step ───────────────────

  const handleSubmit = async () => {
    if (!canSubmit || !fieldStateRef.current) return
    setStep("processing")
    setError(null)

    try {
      // Step 1: Generate Terraform via AI
      const { targetEnvironments, ...rest } = fieldStateRef.current.fields

      // R7.1 — transmit Motor (engine), Version_Motor (engineVersion) and
      // Entornos_Destino (targetEnvironments) without omitting any of the three.
      // `targetEnvironments` is always sent as a top-level field; for RDS we make
      // engine/engineVersion explicit so they can never be stripped (engine
      // defaults to "postgres" for backward compatibility per RdsFields).
      const fields =
        resourceType === "rds"
          ? {
              ...rest,
              engine: (rest as Partial<RdsFields>).engine ?? "postgres",
              engineVersion: (rest as Partial<RdsFields>).engineVersion ?? "",
            }
          : rest

      const genRes = await fetch("/api/infra-request-v2/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ team, resourceType, fields, targetEnvironments }),
      })

      const genData = await genRes.json()

      if (!genRes.ok) {
        setError(genData.error || `Error ${genRes.status}`)
        setStep("form")
        return
      }

      if (!genData.terraformPreview) {
        setError("No se pudo generar la configuración. Inténtalo de nuevo.")
        setStep("form")
        return
      }

      // Step 2: Submit for approval
      setStep("submitting")

      const conversationId = `v2-${Date.now()}`
      const conversation = [
        { role: "user", content: `[Form V2] ${resourceType} request`, timestamp: new Date().toISOString() },
        { role: "assistant", content: genData.aiReply || "", timestamp: new Date().toISOString() },
      ]

      const submitRes = await fetch("/api/infra-assistant/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          conversation,
          terraformPreview: genData.terraformPreview,
          team,
          approver,
        }),
      })

      const submitData = await submitRes.json()

      if (!submitRes.ok) {
        setError(submitData.error || `Error ${submitRes.status}`)
        setStep("form")
        return
      }

      setSuccessId(submitData.id)
      setStep("success")
    } catch (err) {
      setError("Error procesando la solicitud. Inténtalo de nuevo.")
      setStep("form")
    }
  }

  // ── Success state ────────────────────────────────────────────────────────

  const { t } = useI18n()

  if (step === "success") {
    const approverName = SELECTABLE_APPROVERS.find(a => a.email === approver)?.name || approver
    const resourceLabel = resourceType === "rds" ? "RDS (PostgreSQL)" : resourceType === "s3" ? "S3" : "IAM Role"
    const resourceName = fieldState?.fields
      ? (fieldState.fields as any).identifier || (fieldState.fields as any).bucketName || (fieldState.fields as any).roleName || "-"
      : "-"

    return (
      <Card>
        <CardContent className="py-8 space-y-6">
          <div className="text-center space-y-2">
            <CheckCircle2 className="h-12 w-12 text-emerald-500 mx-auto" />
            <h2 className="text-lg font-semibold">{t("infra.success.title", "Solicitud enviada")}</h2>
            <p className="text-sm text-muted-foreground">
              Tu solicitud #{successId} ha sido enviada para aprobación.
              Recibirás una notificación cuando sea revisada.
            </p>
          </div>

          {/* Summary card */}
          <div className="rounded-lg border bg-muted/30 p-4 space-y-2 text-sm">
            <h3 className="font-medium text-xs uppercase text-muted-foreground tracking-wide">
              {t("infra.success.summary", "Resumen de tu solicitud")}
            </h3>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="text-muted-foreground text-xs">Tipo de recurso</span>
                <p className="font-medium">{resourceLabel}</p>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">Nombre</span>
                <p className="font-medium">{resourceName}</p>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">Equipo</span>
                <p className="font-medium">{team}</p>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">Aprobador</span>
                <p className="font-medium">{approverName}</p>
              </div>
            </div>
          </div>

          {/* Timeline */}
          <SuccessTimeline activeStage="pending" />

          {/* Action buttons */}
          <div className="flex gap-3 justify-center">
            <Link href="/infra-requests">
              <Button variant="outline" className="gap-1.5">
                <ExternalLink className="h-4 w-4" />
                Ver solicitudes
              </Button>
            </Link>
            <Button variant="ghost" onClick={() => {
              setStep("form")
              setResourceType("")
              setFieldState(null)
              setApprover("")
              setError(null)
              setSuccessId(null)
            }}>
              Nueva solicitud
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  // ── Derive cost panel props ──────────────────────────────────────────────

  const costTargetEnvs = fieldState?.fields?.targetEnvironments ?? []
  const rdsFields = resourceType === "rds" ? fieldState?.fields as (RdsFields & { targetEnvironments: string[] }) : null

  // ── Form state ───────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {error && (
        <div className="flex items-start gap-2 rounded-md bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-400">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1">{error}</div>
          <button onClick={() => setError(null)} className="text-xs underline">Cerrar</button>
        </div>
      )}

      {/* Team selector */}
      <div className="space-y-1.5">
        <Label>Equipo</Label>
        <Select value={team} onValueChange={v => { setTeam(v); setResourceType(""); setFieldState(null); setApprover("") }}>
          <SelectTrigger><SelectValue placeholder="Selecciona un equipo..." /></SelectTrigger>
          <SelectContent>
            {INFRA_BUSINESS_TEAMS.map(t => (<SelectItem key={t} value={t}>{BUSINESS_TEAM_LABELS[t]}</SelectItem>))}
          </SelectContent>
        </Select>
      </div>

      {/* Resource type */}
      <div className="space-y-1.5">
        <Label>Tipo de recurso</Label>
        <Select value={resourceType} onValueChange={handleResourceTypeChange} disabled={!team}>
          <SelectTrigger><SelectValue placeholder="Selecciona tipo de recurso..." /></SelectTrigger>
          <SelectContent>
            <SelectItem value="rds">RDS (PostgreSQL)</SelectItem>
            <SelectItem value="s3">S3</SelectItem>
            <SelectItem value="iam_role">IAM Role</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Resource-specific fields */}
      {resourceType === "rds" && <RdsFieldsPanel team={team} onChange={handleFieldChange} />}
      {resourceType === "s3" && <S3FieldsPanel team={team} onChange={handleFieldChange} />}
      {resourceType === "iam_role" && <IamRoleFieldsPanel team={team} onChange={handleFieldChange} />}

      {/* Cost estimate */}
      {resourceType && (
        <CostEstimatePanel
          resourceType={resourceType as "rds" | "s3" | "iam_role"}
          rdsInstanceClass={rdsFields?.instanceClass}
          rdsStorageGb={rdsFields?.storageGb}
          rdsMultiAz={rdsFields?.multiAz}
          targetEnvironments={costTargetEnvs}
        />
      )}

      {/* Approver selector */}
      {resourceType && (
        <div className="space-y-1.5">
          <Label>Aprobador</Label>
          <Select value={approver} onValueChange={setApprover}>
            <SelectTrigger><SelectValue placeholder="Selecciona quién debe aprobar..." /></SelectTrigger>
            <SelectContent>
              {(team === "digital"
                ? SELECTABLE_APPROVERS
                : getApproversForTeam(team as BusinessTeam, "")
              ).map(a => (
                <SelectItem key={a.email} value={a.email}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Submit button */}
      <Button
        onClick={handleSubmit}
        disabled={!canSubmit || step === "processing" || step === "submitting"}
        className="w-full gap-2"
      >
        {step === "processing" ? (
          <><Loader2 className="h-4 w-4 animate-spin" /> Generando configuración...</>
        ) : step === "submitting" ? (
          <><Loader2 className="h-4 w-4 animate-spin" /> Enviando solicitud...</>
        ) : (
          <><Send className="h-4 w-4" /> Solicitar infraestructura</>
        )}
      </Button>
    </div>
  )
}
