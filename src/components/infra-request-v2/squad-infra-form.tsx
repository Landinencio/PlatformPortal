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
import { Loader2, CheckCircle2, AlertTriangle, ExternalLink, Send, Plus, X, MessageSquare, Database, KeyRound, Radio, Network } from "lucide-react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { useSession } from "next-auth/react"
import { SELECTABLE_APPROVERS } from "@/lib/infra-approvers"
import { getApproversForTeam, type BusinessTeam } from "@/lib/team-approvers"

interface Squad {
  squad: string
  displayName: string
  businessTeam: string
  environments: string[]
}

type ResourceType = "sqs" | "secret" | "dynamodb" | "sns" | "eventbridge"
type FormStep = "form" | "preview" | "submitting" | "success"

const RESOURCE_META: Record<ResourceType, { label: string; icon: typeof Database }> = {
  sqs: { label: "SQS Queue", icon: MessageSquare },
  secret: { label: "Secret", icon: KeyRound },
  dynamodb: { label: "DynamoDB Table", icon: Database },
  sns: { label: "SNS Topic", icon: Radio },
  eventbridge: { label: "EventBridge Rule", icon: Network },
}

const PRINCIPAL_OPTIONS = [
  "sns.amazonaws.com",
  "events.amazonaws.com",
  "s3.amazonaws.com",
  "lambda.amazonaws.com",
]

export function SquadInfraForm() {
  const { data: session } = useSession()
  const [squads, setSquads] = useState<Squad[]>([])
  const [squad, setSquad] = useState("")
  const [resourceType, setResourceType] = useState<ResourceType | "">("")
  const [environments, setEnvironments] = useState<string[]>([])
  const [approver, setApprover] = useState("")
  const [step, setStep] = useState<FormStep>("form")
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ hcl: string; filePath: string; ciVars: { key: string }[] } | null>(null)
  const [successId, setSuccessId] = useState<number | null>(null)

  // ── SQS ──
  const [sqsName, setSqsName] = useState("")
  const [sqsDlq, setSqsDlq] = useState(true)
  const [sqsMaxReceive, setSqsMaxReceive] = useState("3")
  const [sqsPrincipals, setSqsPrincipals] = useState<string[]>(["sns.amazonaws.com", "events.amazonaws.com"])

  // ── Secret ──
  const [secretName, setSecretName] = useState("")
  const [secretDesc, setSecretDesc] = useState("")
  const [secretKeys, setSecretKeys] = useState<{ jsonKey: string; tfVar: string; value: string }[]>([{ jsonKey: "", tfVar: "", value: "" }])

  // ── DynamoDB ──
  const [dynName, setDynName] = useState("")
  const [dynHashKey, setDynHashKey] = useState("")
  const [dynRangeKey, setDynRangeKey] = useState("")
  const [dynTtl, setDynTtl] = useState("")

  // ── SNS ──
  const [snsName, setSnsName] = useState("")

  // ── EventBridge ──
  const [ebName, setEbName] = useState("")
  const [ebBus, setEbBus] = useState("")
  const [ebRuleName, setEbRuleName] = useState("")
  const [ebDetailTypes, setEbDetailTypes] = useState("")
  const [ebTargetSqs, setEbTargetSqs] = useState("")
  const [ebTargetName, setEbTargetName] = useState("")
  const [availableBuses, setAvailableBuses] = useState<string[]>([])
  const [busMode, setBusMode] = useState<"existing" | "custom">("existing")

  useEffect(() => {
    fetch("/api/squad-infra/squads")
      .then(r => r.json())
      .then(d => setSquads(d.squads || []))
      .catch(() => setSquads([]))
  }, [])

  const selectedSquad = useMemo(() => squads.find(s => s.squad === squad), [squads, squad])

  const approverOptions = useMemo(() => {
    if (!selectedSquad) return []
    if (selectedSquad.businessTeam === "digital") {
      return SELECTABLE_APPROVERS.map(a => ({ email: a.email, name: a.name }))
    }
    return getApproversForTeam(selectedSquad.businessTeam as BusinessTeam, session?.user?.email || "")
  }, [selectedSquad, session?.user?.email])

  // Reset when squad changes
  useEffect(() => {
    setEnvironments(selectedSquad ? [...selectedSquad.environments] : [])
    setApprover("")
    setEbBus("")
    setAvailableBuses([])
    setBusMode("existing")
    if (squad) {
      fetch("/api/squad-infra/buses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ squad }),
      })
        .then(r => r.json())
        .then(d => {
          const buses: string[] = d.buses || []
          setAvailableBuses(buses)
          if (buses.length > 0) {
            setEbBus(buses[0])
            setBusMode("existing")
          } else {
            setBusMode("custom")
          }
        })
        .catch(() => { setAvailableBuses([]); setBusMode("custom") })
    }
  }, [squad])

  const toggleEnv = (env: string) => {
    setEnvironments(prev => prev.includes(env) ? prev.filter(e => e !== env) : [...prev, env])
  }
  const togglePrincipal = (p: string) => {
    setSqsPrincipals(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])
  }

  const buildConfig = (): any => {
    switch (resourceType) {
      case "sqs":
        return { name: sqsName, createDlq: sqsDlq, maxReceiveCount: Number(sqsMaxReceive) || 3, principals: sqsPrincipals }
      case "secret":
        return {
          name: secretName,
          description: secretDesc,
          keys: secretKeys.filter(k => k.jsonKey && k.tfVar).map(k => ({ jsonKey: k.jsonKey, tfVar: k.tfVar })),
        }
      case "dynamodb": {
        const attributes = [{ name: dynHashKey, type: "S" as const }]
        if (dynRangeKey) attributes.push({ name: dynRangeKey, type: "S" as const })
        return {
          name: dynName, hashKey: dynHashKey, rangeKey: dynRangeKey || undefined,
          attributes, billingMode: "PAY_PER_REQUEST", pitrProdOnly: true,
          ttlAttribute: dynTtl || undefined,
        }
      }
      case "sns":
        return { name: snsName }
      case "eventbridge":
        return {
          name: ebName, busName: ebBus, ruleName: ebRuleName,
          detailTypes: ebDetailTypes.split(",").map(s => s.trim()).filter(Boolean),
          targetSqsModuleId: ebTargetSqs, targetName: ebTargetName,
        }
      default:
        return {}
    }
  }

  const secretValues = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const k of secretKeys) {
      if (k.tfVar && k.value) out[`TF_VAR_${k.tfVar}`] = k.value
    }
    return out
  }

  const canPreview = (): boolean => {
    if (!squad || !resourceType || environments.length === 0) return false
    switch (resourceType) {
      case "sqs": return sqsName.trim() !== "" && sqsPrincipals.length > 0
      case "secret": return secretName.startsWith("dp/") && secretDesc.trim() !== "" && secretKeys.some(k => k.jsonKey && k.tfVar && k.value)
      case "dynamodb": return dynName.trim() !== "" && dynHashKey.trim() !== ""
      case "sns": return snsName.trim() !== ""
      case "eventbridge": return ebName.trim() !== "" && ebBus.trim() !== "" && ebRuleName.trim() !== "" && ebDetailTypes.trim() !== "" && ebTargetSqs.trim() !== "" && ebTargetName.trim() !== ""
      default: return false
    }
  }

  const handlePreview = async () => {
    setError(null)
    try {
      const res = await fetch("/api/squad-infra/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ squad, resourceType, environments, config: buildConfig() }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || "No se pudo generar la preview."); return }
      setPreview({ hcl: data.hcl, filePath: data.filePath, ciVars: data.ciVars || [] })
      setStep("preview")
    } catch {
      setError("Error generando la preview.")
    }
  }

  const handleSubmit = async () => {
    if (!approver) { setError("Selecciona un aprobador."); return }
    setStep("submitting")
    setError(null)
    try {
      const res = await fetch("/api/squad-infra/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          squad, resourceType, environments, config: buildConfig(), approver,
          secretValues: resourceType === "secret" ? secretValues() : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || "Error enviando la solicitud."); setStep("preview"); return }
      setSuccessId(data.id)
      setStep("success")
    } catch {
      setError("Error procesando la solicitud.")
      setStep("preview")
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
            <Link href="/infra-requests">
              <Button variant="outline" className="gap-1.5"><ExternalLink className="h-4 w-4" /> Ver solicitudes</Button>
            </Link>
            <Button variant="ghost" onClick={() => { setStep("form"); setResourceType(""); setPreview(null); setSuccessId(null) }}>Nueva solicitud</Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  const RIcon = resourceType ? RESOURCE_META[resourceType].icon : MessageSquare

  return (
    <div className="space-y-6">
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-400">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1">{error}</div>
          <button onClick={() => setError(null)} className="text-xs underline">Cerrar</button>
        </div>
      )}

      {step === "preview" && preview ? (
        <>
          <div className="space-y-2">
            <Label>Terraform a generar</Label>
            <p className="text-xs text-muted-foreground">Fichero: <code className="font-mono">{preview.filePath}</code></p>
            <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs font-mono">{preview.hcl}</pre>
            {preview.ciVars.length > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Se configurarán {preview.ciVars.length} variable(s) CI/CD en GitLab (valores nunca guardados en el portal): {preview.ciVars.map(v => v.key).join(", ")}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sq-approver">Aprobador</Label>
            <Select value={approver} onValueChange={setApprover}>
              <SelectTrigger id="sq-approver"><SelectValue placeholder="Selecciona quién debe aprobar..." /></SelectTrigger>
              <SelectContent>
                {approverOptions.length === 0
                  ? <div className="px-2 py-1.5 text-xs text-muted-foreground">No hay aprobadores para este equipo</div>
                  : approverOptions.map(a => <SelectItem key={a.email} value={a.email}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStep("form")} className="flex-1">Volver</Button>
            <Button onClick={handleSubmit} disabled={!approver} className="flex-1 gap-2"><Send className="h-4 w-4" /> Solicitar</Button>
          </div>
        </>
      ) : step === "submitting" ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Enviando solicitud...
        </div>
      ) : (
        <>
          {/* Squad */}
          <div className="space-y-1.5">
            <Label htmlFor="sq-squad">Squad / Repositorio</Label>
            <Select value={squad} onValueChange={v => { setSquad(v); setResourceType("") }}>
              <SelectTrigger id="sq-squad"><SelectValue placeholder="Selecciona un squad..." /></SelectTrigger>
              <SelectContent>
                {squads.map(s => <SelectItem key={s.squad} value={s.squad}>{s.displayName}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {/* Resource type */}
          {squad && (
            <div className="space-y-1.5">
              <Label htmlFor="sq-type">Tipo de recurso</Label>
              <Select value={resourceType} onValueChange={v => setResourceType(v as ResourceType)}>
                <SelectTrigger id="sq-type"><SelectValue placeholder="Selecciona tipo..." /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(RESOURCE_META) as ResourceType[]).map(rt => (
                    <SelectItem key={rt} value={rt}>{RESOURCE_META[rt].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Environments */}
          {resourceType && selectedSquad && (
            <div className="space-y-1.5">
              <Label>Entornos</Label>
              <div className="flex gap-4">
                {selectedSquad.environments.map(env => (
                  <div key={env} className="flex items-center gap-1.5">
                    <Checkbox id={`sq-env-${env}`} checked={environments.includes(env)} onCheckedChange={() => toggleEnv(env)} />
                    <Label htmlFor={`sq-env-${env}`} className="uppercase">{env}</Label>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Resource-specific forms */}
          {resourceType && (
            <Card>
              <CardContent className="pt-4 space-y-4">
                <div className="flex items-center gap-2">
                  <RIcon className="h-5 w-5 text-primary" />
                  <span className="font-medium">{RESOURCE_META[resourceType].label}</span>
                  <Badge variant="outline" className="text-[10px]">{selectedSquad?.displayName}</Badge>
                </div>

                {resourceType === "sqs" && (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="sqs-name">Nombre de la cola</Label>
                      <Input id="sqs-name" value={sqsName} onChange={e => setSqsName(e.target.value)} placeholder="orders-events" />
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox id="sqs-dlq" checked={sqsDlq} onCheckedChange={() => setSqsDlq(v => !v)} />
                      <Label htmlFor="sqs-dlq">Crear Dead Letter Queue (DLQ)</Label>
                    </div>
                    {sqsDlq && (
                      <div className="space-y-1.5">
                        <Label htmlFor="sqs-maxr">Reintentos antes de DLQ (maxReceiveCount)</Label>
                        <Input id="sqs-maxr" type="number" min={1} max={1000} value={sqsMaxReceive} onChange={e => setSqsMaxReceive(e.target.value)} />
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <Label>Servicios que pueden publicar</Label>
                      {PRINCIPAL_OPTIONS.map(p => (
                        <div key={p} className="flex items-center gap-1.5">
                          <Checkbox id={`pr-${p}`} checked={sqsPrincipals.includes(p)} onCheckedChange={() => togglePrincipal(p)} />
                          <Label htmlFor={`pr-${p}`} className="text-xs font-mono">{p}</Label>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {resourceType === "secret" && (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="sec-name">Path del secreto</Label>
                      <Input id="sec-name" value={secretName} onChange={e => setSecretName(e.target.value)} placeholder="dp/oms/my-service-credentials" />
                      <p className="text-[10px] text-muted-foreground">Convención: dp/&lt;dominio&gt;/&lt;nombre&gt;</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="sec-desc">Descripción</Label>
                      <Input id="sec-desc" value={secretDesc} onChange={e => setSecretDesc(e.target.value)} placeholder="Credenciales del servicio X" />
                    </div>
                    <div className="space-y-2">
                      <Label>Claves del secreto</Label>
                      <p className="text-[10px] text-muted-foreground">El valor se guarda como variable CI/CD en GitLab (masked), nunca en el portal.</p>
                      {secretKeys.map((k, i) => (
                        <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center">
                          <Input placeholder="json key" value={k.jsonKey} onChange={e => setSecretKeys(prev => prev.map((x, j) => j === i ? { ...x, jsonKey: e.target.value } : x))} className="text-xs" />
                          <Input placeholder="TF_VAR name" value={k.tfVar} onChange={e => setSecretKeys(prev => prev.map((x, j) => j === i ? { ...x, tfVar: e.target.value.toUpperCase() } : x))} className="text-xs font-mono" />
                          <Input type="password" placeholder="valor" value={k.value} onChange={e => setSecretKeys(prev => prev.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} className="text-xs" />
                          <button onClick={() => setSecretKeys(prev => prev.filter((_, j) => j !== i))} disabled={secretKeys.length === 1} className="text-muted-foreground disabled:opacity-30"><X className="h-4 w-4" /></button>
                        </div>
                      ))}
                      <Button type="button" variant="outline" size="sm" onClick={() => setSecretKeys(prev => [...prev, { jsonKey: "", tfVar: "", value: "" }])} className="gap-1">
                        <Plus className="h-3 w-3" /> Añadir clave
                      </Button>
                    </div>
                  </>
                )}

                {resourceType === "dynamodb" && (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="dyn-name">Nombre de la tabla</Label>
                      <Input id="dyn-name" value={dynName} onChange={e => setDynName(e.target.value)} placeholder="orders_v2" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="dyn-hash">Partition key (hash)</Label>
                        <Input id="dyn-hash" value={dynHashKey} onChange={e => setDynHashKey(e.target.value)} placeholder="hashKey" />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="dyn-range">Sort key (range, opcional)</Label>
                        <Input id="dyn-range" value={dynRangeKey} onChange={e => setDynRangeKey(e.target.value)} placeholder="sortKey" />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="dyn-ttl">Atributo TTL (opcional)</Label>
                      <Input id="dyn-ttl" value={dynTtl} onChange={e => setDynTtl(e.target.value)} placeholder="expires_at" />
                    </div>
                  </>
                )}

                {resourceType === "sns" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="sns-name">Nombre del topic</Label>
                    <Input id="sns-name" value={snsName} onChange={e => setSnsName(e.target.value)} placeholder="orders-notifications" />
                  </div>
                )}

                {resourceType === "eventbridge" && (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="eb-name">Nombre lógico</Label>
                      <Input id="eb-name" value={ebName} onChange={e => setEbName(e.target.value)} placeholder="order-created-listener" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="eb-bus">Bus de eventos</Label>
                        {availableBuses.length > 0 && busMode === "existing" ? (
                          <Select
                            value={ebBus}
                            onValueChange={v => {
                              if (v === "__custom__") { setBusMode("custom"); setEbBus("") }
                              else setEbBus(v)
                            }}
                          >
                            <SelectTrigger id="eb-bus"><SelectValue placeholder="Selecciona un bus..." /></SelectTrigger>
                            <SelectContent>
                              {availableBuses.map(b => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                              <SelectItem value="__custom__">+ Otro bus...</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="flex gap-1">
                            <Input id="eb-bus" value={ebBus} onChange={e => setEbBus(e.target.value)} placeholder="nombre-del-bus" />
                            {availableBuses.length > 0 && (
                              <Button type="button" variant="outline" size="sm" onClick={() => { setBusMode("existing"); setEbBus(availableBuses[0]) }}>Volver</Button>
                            )}
                          </div>
                        )}
                        {availableBuses.length === 0 && (
                          <p className="text-[10px] text-muted-foreground">No se detectaron buses en el repo; escribe el nombre.</p>
                        )}
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="eb-rule">Nombre de la regla</Label>
                        <Input id="eb-rule" value={ebRuleName} onChange={e => setEbRuleName(e.target.value)} placeholder="order_created" />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="eb-dt">detail-type (separados por coma)</Label>
                      <Input id="eb-dt" value={ebDetailTypes} onChange={e => setEbDetailTypes(e.target.value)} placeholder="OrderCreated, OrderUpdated" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="eb-target">SQS destino (module id)</Label>
                        <Input id="eb-target" value={ebTargetSqs} onChange={e => setEbTargetSqs(e.target.value)} placeholder="orders_events_sqs" />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="eb-tname">Nombre del target</Label>
                        <Input id="eb-tname" value={ebTargetName} onChange={e => setEbTargetName(e.target.value)} placeholder="orders-target" />
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          <Button onClick={handlePreview} disabled={!canPreview()} className="w-full gap-2">
            Previsualizar Terraform
          </Button>
        </>
      )}
    </div>
  )
}
