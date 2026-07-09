"use client"

import { useState, useEffect, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Loader2, CheckCircle2, AlertTriangle, ExternalLink, Send, KeyRound, MessageSquare, Database, Network } from "lucide-react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { useSession } from "next-auth/react"
import { SELECTABLE_APPROVERS } from "@/lib/infra-approvers"
import { getApproversForTeam, type BusinessTeam } from "@/lib/team-approvers"

interface Squad { squad: string; displayName: string; businessTeam: string; environments: string[] }
interface ExistingResource { resourceType: string; name: string; filePath: string; tfLabel: string }

type ModType = "sqs" | "eventbridge" | "dynamodb" | "secret"
type Step = "select" | "edit" | "submitting" | "success"

const TYPE_META: Record<ModType, { label: string; icon: typeof Database }> = {
  sqs: { label: "SQS Queue", icon: MessageSquare },
  eventbridge: { label: "EventBridge Rule", icon: Network },
  dynamodb: { label: "DynamoDB Table", icon: Database },
  secret: { label: "Secret (rotar valor)", icon: KeyRound },
}

const PRINCIPAL_OPTIONS = ["sns.amazonaws.com", "events.amazonaws.com", "s3.amazonaws.com", "lambda.amazonaws.com"]

export function SquadModifyForm() {
  const { data: session } = useSession()
  const [squads, setSquads] = useState<Squad[]>([])
  const [squad, setSquad] = useState("")
  const [modType, setModType] = useState<ModType | "">("")
  const [resources, setResources] = useState<ExistingResource[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<ExistingResource | null>(null)
  const [approver, setApprover] = useState("")
  const [step, setStep] = useState<Step>("select")
  const [error, setError] = useState<string | null>(null)
  const [successId, setSuccessId] = useState<number | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  // SQS mods
  const [maxReceive, setMaxReceive] = useState("")
  const [principals, setPrincipals] = useState<string[]>([])
  const [editPrincipals, setEditPrincipals] = useState(false)
  // EventBridge mods
  const [detailTypes, setDetailTypes] = useState("")
  const [ebTarget, setEbTarget] = useState("")
  // DynamoDB mods
  const [ttlAttr, setTtlAttr] = useState("")
  // Secret
  const [ciVarKey, setCiVarKey] = useState("")
  const [newValue, setNewValue] = useState("")
  // generic
  const [freeText, setFreeText] = useState("")

  useEffect(() => {
    fetch("/api/squad-infra/squads").then(r => r.json()).then(d => setSquads(d.squads || [])).catch(() => setSquads([]))
  }, [])

  const selectedSquad = useMemo(() => squads.find(s => s.squad === squad), [squads, squad])
  const approverOptions = useMemo(() => {
    if (!selectedSquad) return []
    if (selectedSquad.businessTeam === "digital") return SELECTABLE_APPROVERS.map(a => ({ email: a.email, name: a.name }))
    return getApproversForTeam(selectedSquad.businessTeam as BusinessTeam, session?.user?.email || "")
  }, [selectedSquad, session?.user?.email])

  const resetMods = () => {
    setMaxReceive(""); setPrincipals([]); setEditPrincipals(false)
    setDetailTypes(""); setEbTarget(""); setTtlAttr(""); setCiVarKey(""); setNewValue(""); setFreeText("")
  }

  // Load resources of the chosen type
  useEffect(() => {
    if (!squad || !modType) { setResources([]); return }
    setLoading(true); setSelected(null); setApprover("")
    const apiType = modType // secret/sqs/dynamodb/eventbridge all valid for list-resources except eventbridge
    fetch("/api/squad-infra/list-resources", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ squad, resourceType: apiType === "eventbridge" ? undefined : apiType }),
    })
      .then(r => r.json())
      .then(d => {
        const all: ExistingResource[] = d.resources || []
        setResources(modType === "eventbridge" ? all.filter(r => r.resourceType === "eventbridge" || true) : all.filter(r => r.resourceType === modType))
      })
      .catch(() => setResources([]))
      .finally(() => setLoading(false))
  }, [squad, modType])

  useEffect(() => {
    if (selected) {
      resetMods()
      if (modType === "secret") {
        const lastSeg = selected.name.split("/").pop() || ""
        setCiVarKey("TF_VAR_" + lastSeg.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, ""))
      }
      setStep("edit")
    }
  }, [selected])

  const togglePrincipal = (p: string) => setPrincipals(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])

  const hasChange = (): boolean => {
    if (modType === "sqs") return maxReceive !== "" || (editPrincipals && principals.length > 0) || freeText.trim() !== ""
    if (modType === "eventbridge") return detailTypes.trim() !== "" || ebTarget.trim() !== "" || freeText.trim() !== ""
    if (modType === "dynamodb") return ttlAttr.trim() !== "" || freeText.trim() !== ""
    if (modType === "secret") return ciVarKey !== "" && newValue !== ""
    return false
  }

  const handleSubmit = async () => {
    if (!selected || !approver) return
    setStep("submitting"); setError(null)
    try {
      if (modType === "secret") {
        const res = await fetch("/api/squad-infra/update-secret", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ squad, secretName: selected.name, ciVarKey, newValue, approver }),
        })
        const data = await res.json()
        if (!res.ok) { setError(data.error || "Error enviando la solicitud."); setStep("edit"); return }
        setSuccessId(data.id); setStep("success"); return
      }

      const modifications: Record<string, unknown> = {}
      if (modType === "sqs") {
        if (maxReceive !== "") modifications.maxReceiveCount = Number(maxReceive)
        if (editPrincipals && principals.length > 0) modifications.principals = principals
      } else if (modType === "eventbridge") {
        if (detailTypes.trim()) modifications.detailTypes = detailTypes.split(",").map(s => s.trim()).filter(Boolean)
        if (ebTarget.trim()) modifications.targetSqsModuleId = ebTarget.trim()
      } else if (modType === "dynamodb") {
        if (ttlAttr.trim()) modifications.ttlAttribute = ttlAttr.trim()
      }
      if (freeText.trim()) modifications.freeText = freeText.trim()

      const res = await fetch("/api/squad-infra/modify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          squad, resourceType: modType, resourceName: selected.name,
          tfLabel: selected.tfLabel, filePath: selected.filePath, modifications, approver,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error + (data.unexpectedChanges ? ` (${data.unexpectedChanges.join(", ")})` : ""))
        setStep("edit"); return
      }
      setPreview(data.preview || null)
      setSuccessId(data.id); setStep("success")
    } catch {
      setError("Error procesando la solicitud."); setStep("edit")
    }
  }

  if (step === "success") {
    return (
      <Card>
        <CardContent className="py-8 text-center space-y-4">
          <CheckCircle2 className="h-12 w-12 text-emerald-500 mx-auto" />
          <h2 className="text-lg font-semibold">Solicitud enviada</h2>
          <p className="text-sm text-muted-foreground">La solicitud #{successId} está pendiente de aprobación.</p>
          <div className="flex items-center justify-center gap-2">
            <Link href="/infra-requests"><Button variant="outline" className="gap-1.5"><ExternalLink className="h-4 w-4" /> Ver solicitudes</Button></Link>
            <Button variant="ghost" onClick={() => { setStep("select"); setSquad(""); setModType(""); setSelected(null); resetMods(); setSuccessId(null); setPreview(null) }}>Otra modificación</Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  const Icon = modType ? TYPE_META[modType].icon : MessageSquare

  return (
    <div className="space-y-6">
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-400">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1">{error}</div>
          <button onClick={() => setError(null)} className="text-xs underline">Cerrar</button>
        </div>
      )}

      {/* Squad */}
      <div className="space-y-1.5">
        <Label htmlFor="sm-squad">Squad / Repositorio</Label>
        <Select value={squad} onValueChange={v => { setSquad(v); setModType("") }}>
          <SelectTrigger id="sm-squad"><SelectValue placeholder="Selecciona un squad..." /></SelectTrigger>
          <SelectContent>{squads.map(s => <SelectItem key={s.squad} value={s.squad}>{s.displayName}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {/* Type */}
      {squad && (
        <div className="space-y-1.5">
          <Label htmlFor="sm-type">Tipo de recurso a modificar</Label>
          <Select value={modType} onValueChange={v => setModType(v as ModType)}>
            <SelectTrigger id="sm-type"><SelectValue placeholder="Selecciona tipo..." /></SelectTrigger>
            <SelectContent>{(Object.keys(TYPE_META) as ModType[]).map(t => <SelectItem key={t} value={t}>{TYPE_META[t].label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      )}

      {/* Resource picker */}
      {squad && modType && (
        <div className="space-y-1.5">
          <Label htmlFor="sm-res">Recurso existente</Label>
          {loading ? (
            <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Buscando en el repo...</div>
          ) : resources.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">No se encontraron recursos de este tipo.</p>
          ) : (
            <Select onValueChange={id => { const r = resources.find(x => `${x.filePath}::${x.name}` === id); if (r) setSelected(r) }}>
              <SelectTrigger id="sm-res"><SelectValue placeholder="Selecciona el recurso..." /></SelectTrigger>
              <SelectContent>{resources.map(r => <SelectItem key={`${r.filePath}::${r.name}`} value={`${r.filePath}::${r.name}`}>{r.name}</SelectItem>)}</SelectContent>
            </Select>
          )}
        </div>
      )}

      {/* Edit */}
      {selected && step === "edit" && (
        <>
          <Card>
            <CardContent className="pt-4 space-y-4">
              <div className="flex items-center gap-2">
                <Icon className="h-5 w-5 text-primary" />
                <span className="font-medium">{selected.name}</span>
                <Badge variant="outline" className="text-[10px]">{selectedSquad?.displayName}</Badge>
              </div>

              {modType === "secret" && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="sm-civar">Variable CI/CD a actualizar</Label>
                    <Input id="sm-civar" value={ciVarKey} onChange={e => setCiVarKey(e.target.value.toUpperCase())} className="font-mono text-xs" placeholder="TF_VAR_MY_TOKEN" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sm-value">Nuevo valor</Label>
                    <Input id="sm-value" type="password" value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="••••••••" />
                    <p className="text-[10px] text-muted-foreground">Se guarda en GitLab (masked) y al aprobar se relanza la pipeline para que tome efecto.</p>
                  </div>
                </>
              )}

              {modType === "sqs" && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="sm-maxr">maxReceiveCount (reintentos antes de DLQ)</Label>
                    <Input id="sm-maxr" type="number" min={1} max={1000} value={maxReceive} onChange={e => setMaxReceive(e.target.value)} placeholder="Sin cambios" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox id="sm-editpr" checked={editPrincipals} onCheckedChange={() => setEditPrincipals(v => !v)} />
                    <Label htmlFor="sm-editpr">Cambiar servicios que pueden publicar</Label>
                  </div>
                  {editPrincipals && (
                    <div className="space-y-1 pl-6">
                      {PRINCIPAL_OPTIONS.map(p => (
                        <div key={p} className="flex items-center gap-1.5">
                          <Checkbox id={`sm-pr-${p}`} checked={principals.includes(p)} onCheckedChange={() => togglePrincipal(p)} />
                          <Label htmlFor={`sm-pr-${p}`} className="text-xs font-mono">{p}</Label>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {modType === "eventbridge" && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="sm-dt">detail-type (separados por coma)</Label>
                    <Input id="sm-dt" value={detailTypes} onChange={e => setDetailTypes(e.target.value)} placeholder="OrderCreated, OrderUpdated" />
                    <p className="text-[10px] text-muted-foreground">Reemplaza el detail-type de la regla.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sm-target">Nuevo SQS destino (module id, opcional)</Label>
                    <Input id="sm-target" value={ebTarget} onChange={e => setEbTarget(e.target.value)} placeholder="orders_events_sqs" />
                  </div>
                </>
              )}

              {modType === "dynamodb" && (
                <div className="space-y-1.5">
                  <Label htmlFor="sm-ttl">Atributo TTL</Label>
                  <Input id="sm-ttl" value={ttlAttr} onChange={e => setTtlAttr(e.target.value)} placeholder="expires_at" />
                  <p className="text-[10px] text-muted-foreground">Habilita TTL sobre el atributo indicado.</p>
                </div>
              )}

              {modType !== "secret" && (
                <div className="space-y-1.5">
                  <Label htmlFor="sm-free">Otro cambio (texto libre, opcional)</Label>
                  <Input id="sm-free" value={freeText} onChange={e => setFreeText(e.target.value)} placeholder="Ej: subir visibility_timeout a 120" />
                  <p className="text-[10px] text-muted-foreground">La IA aplica el cambio sobre este recurso, validando que no toque otros.</p>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="space-y-1.5">
            <Label htmlFor="sm-approver">Aprobador</Label>
            <Select value={approver} onValueChange={setApprover}>
              <SelectTrigger id="sm-approver"><SelectValue placeholder="Selecciona quién debe aprobar..." /></SelectTrigger>
              <SelectContent>
                {approverOptions.length === 0
                  ? <div className="px-2 py-1.5 text-xs text-muted-foreground">No hay aprobadores para este equipo</div>
                  : approverOptions.map(a => <SelectItem key={a.email} value={a.email}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <Button onClick={handleSubmit} disabled={!approver || !hasChange()} className="w-full gap-2">
            <Send className="h-4 w-4" /> Solicitar modificación
          </Button>
        </>
      )}

      {step === "submitting" && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {modType === "secret" ? "Enviando..." : "Generando modificación con IA..."}
        </div>
      )}
    </div>
  )
}
