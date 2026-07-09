"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Cpu, Loader2, RefreshCcw, Server, Sparkles, TrendingDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// ──────────────────────────────────────────────────────────────────────────
// Types (mirror src/lib/k8s-nodes.ts — keep in sync)
// ──────────────────────────────────────────────────────────────────────────

type NodegroupRecommendationKind =
  | "ok"
  | "downsize_type"
  | "scale_in_count"
  | "scale_out_count"
  | "consider_spot"
  | "no_data";

interface NodegroupRecommendation {
  kind: NodegroupRecommendationKind;
  headline: string;
  detail: string;
  suggestedInstanceType: string | null;
  suggestedNodeCount: number | null;
  estimatedMonthlySavings: number;
  blockers: string[];
}

interface NodeAnalysis {
  cluster: string;
  nodegroup: string | null;
  node: string;
  instanceType: string;
  region: string;
  isSpot: boolean;
  cpuAllocatable: number;
  cpuRequested: number;
  cpuUsedP95: number;
  cpuRequestPct: number;
  cpuUsagePct: number;
  ramAllocatableBytes: number;
  ramRequestedBytes: number;
  ramUsedP95Bytes: number;
  ramRequestPct: number;
  ramUsagePct: number;
  podCount: number;
  costHourly: number;
  costMonthly: number;
}

interface NodegroupAnalysis {
  cluster: string;
  nodegroup: string;
  nodeCount: number;
  spotCount: number;
  primaryInstanceType: string;
  instanceTypes: Record<string, number>;
  totalCpuAllocatable: number;
  totalCpuRequested: number;
  peakCpuUsedP95: number;
  totalRamAllocatable: number;
  totalRamRequestedBytes: number;
  peakRamUsedP95Bytes: number;
  maxPodCpuRequest: number;
  maxPodRamRequest: number;
  avgCpuRequestPct: number;
  avgCpuUsagePct: number;
  avgRamRequestPct: number;
  avgRamUsagePct: number;
  totalCostMonthly: number;
  recommendation: NodegroupRecommendation;
  nodes: NodeAnalysis[];
}

interface NodesSummary {
  generatedAt: string;
  clusters: string[];
  totalNodes: number;
  totalSpotNodes: number;
  totalCostMonthly: number;
  estimatedMonthlySavings: number;
  nodegroups: NodegroupAnalysis[];
  warnings: string[];
}

interface AiResult {
  cluster: string;
  nodegroup: string;
  modelId: string;
  generatedAt: string;
  raw: string;
  headline: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Format helpers
// ──────────────────────────────────────────────────────────────────────────

function fmt$(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

function fmtBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)}Gi`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)}Mi`;
  return `${b}B`;
}

function fmtCores(c: number): string {
  if (!c || !Number.isFinite(c)) return "0";
  if (c >= 1) return `${c.toFixed(1)}`;
  return `${Math.round(c * 1000)}m`;
}

function pctTone(p: number): string {
  if (p < 30) return "text-emerald-700 dark:text-emerald-400";
  if (p < 60) return "text-amber-700 dark:text-amber-400";
  if (p < 85) return "text-blue-700 dark:text-blue-400";
  return "text-red-700 dark:text-red-400";
}

const KIND_BADGE: Record<NodegroupRecommendationKind, { label: string; className: string; emoji: string }> = {
  ok: { label: "OK", emoji: "🟢", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  downsize_type: { label: "Cambiar tipo", emoji: "💡", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  scale_in_count: { label: "Reducir nº nodos", emoji: "🔗", className: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400" },
  scale_out_count: { label: "Añadir nodo o subir tipo", emoji: "⚠", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  consider_spot: { label: "Probar Spot", emoji: "💸", className: "border-purple-500/40 bg-purple-500/10 text-purple-700 dark:text-purple-400" },
  no_data: { label: "Sin datos", emoji: "·", className: "border-border bg-muted text-muted-foreground" },
};

// ──────────────────────────────────────────────────────────────────────────
// Markdown helper — minimal renderer
// ──────────────────────────────────────────────────────────────────────────

function renderMarkdown(md: string) {
  // Very small renderer: bold, italics, code, headers and line breaks.
  // We don't pull a library for one panel.
  const escaped = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const html = escaped
    .replace(/^### (.*)$/gm, '<h4 class="font-semibold text-sm mt-3 mb-1">$1</h4>')
    .replace(/^## (.*)$/gm, '<h3 class="font-semibold text-base mt-3 mb-1">$1</h3>')
    .replace(/^# (.*)$/gm, '<h2 class="font-semibold text-lg mt-3 mb-1">$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*(?!\*)([^*]+?)\*(?!\*)/g, '<em>$1</em>')
    .replace(/`([^`]+?)`/g, '<code class="rounded bg-muted px-1 text-[11px]">$1</code>')
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc text-sm">$1</li>')
    .replace(/\n\n/g, '<br/><br/>');
  return { __html: html };
}

// ──────────────────────────────────────────────────────────────────────────
// Sub-component: nodegroup card
// ──────────────────────────────────────────────────────────────────────────

function NodegroupCard({ ng, defaultOpen, canUseAi }: { ng: NodegroupAnalysis; defaultOpen: boolean; canUseAi: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<AiResult | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  const instanceTypeLabel = Object.entries(ng.instanceTypes)
    .map(([t, n]) => (n === 1 ? t : `${t}×${n}`))
    .join(", ");

  const kb = KIND_BADGE[ng.recommendation.kind];

  const requestAi = async () => {
    setAiLoading(true);
    setAiError(null);
    setAiResult(null);
    try {
      const res = await fetch("/api/finops/k8s-nodes/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cluster: ng.cluster, nodegroup: ng.nodegroup }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setAiResult(json);
    } catch (err: any) {
      setAiError(err?.message || "Error invocando IA");
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-border/60 bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <Server className="h-4 w-4 text-primary shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold">{ng.nodegroup}</span>
              <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{ng.cluster}</Badge>
              <span className="text-xs text-muted-foreground">
                {ng.nodeCount} nodo{ng.nodeCount === 1 ? "" : "s"}
                {ng.spotCount > 0 && <> · {ng.spotCount} spot</>}
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground line-clamp-1">{instanceTypeLabel}</div>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <Badge variant="outline" className={cn("h-5 gap-1 text-[10px]", kb.className)}>
            {kb.emoji} {kb.label}
          </Badge>
          <div className="text-right">
            <div className="text-sm font-semibold">{fmt$(ng.totalCostMonthly)}</div>
            <div className="text-[10px] text-muted-foreground">/mes</div>
          </div>
          {ng.recommendation.estimatedMonthlySavings > 0 && (
            <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
              <TrendingDown className="mr-1 h-3 w-3" />
              −{fmt$(ng.recommendation.estimatedMonthlySavings)}
            </Badge>
          )}
          {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </button>
      {open && (
        <div className="border-t border-border/40 bg-card/50 px-4 py-3 space-y-3">
          {/* Recommendation box at NG level */}
          <div className={cn(
            "rounded-md border px-3 py-2 text-sm",
            ng.recommendation.kind === "downsize_type" || ng.recommendation.kind === "scale_in_count"
              ? "border-emerald-500/40 bg-emerald-500/5"
              : ng.recommendation.kind === "scale_out_count"
                ? "border-amber-500/40 bg-amber-500/5"
                : ng.recommendation.kind === "consider_spot"
                  ? "border-purple-500/40 bg-purple-500/5"
                  : "border-border/40 bg-muted/20",
          )}>
            <div className="flex items-start justify-between gap-2">
              <div className="font-semibold">{ng.recommendation.headline}</div>
              {ng.recommendation.estimatedMonthlySavings > 0 && (
                <span className="text-success font-semibold whitespace-nowrap">
                  Ahorro: {fmt$(ng.recommendation.estimatedMonthlySavings)}/mes
                </span>
              )}
            </div>
            <div className="mt-1 text-xs opacity-90">{ng.recommendation.detail}</div>
            {ng.recommendation.blockers.length > 0 && (
              <details className="mt-2 text-[11px] text-muted-foreground">
                <summary className="cursor-pointer">Por qué no se proponen tipos aún más pequeños ({ng.recommendation.blockers.length})</summary>
                <ul className="mt-1 ml-4 list-disc space-y-0.5">
                  {ng.recommendation.blockers.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </details>
            )}
          </div>

          {/* AI panel */}
          {canUseAi && (
            <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-sm font-medium text-primary">
                  <Sparkles className="h-3.5 w-3.5" /> Análisis IA (Sonnet 4)
                </div>
                {!aiResult && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      void requestAi();
                    }}
                    disabled={aiLoading}
                  >
                    {aiLoading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
                    Analizar con IA
                  </Button>
                )}
              </div>
              {aiError && (
                <div className="mt-2 text-[11px] text-destructive">{aiError}</div>
              )}
              {aiResult && (
                <div className="mt-2 space-y-1.5">
                  <div
                    className="prose prose-sm max-w-none dark:prose-invert text-foreground"
                    dangerouslySetInnerHTML={renderMarkdown(aiResult.raw)}
                  />
                  <div className="text-[10px] text-muted-foreground">
                    Modelo: {aiResult.modelId} · {new Date(aiResult.generatedAt).toLocaleString("es-ES")}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* NG aggregate metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
            <div className="rounded-md border border-border/40 bg-card/50 px-2 py-1.5">
              <div className="text-[10px] uppercase text-muted-foreground">CPU req agg</div>
              <div className={cn("font-mono", pctTone(ng.avgCpuRequestPct))}>{ng.avgCpuRequestPct}%</div>
              <div className="text-[10px] text-muted-foreground">{fmtCores(ng.totalCpuRequested)}/{fmtCores(ng.totalCpuAllocatable)}</div>
            </div>
            <div className="rounded-md border border-border/40 bg-card/50 px-2 py-1.5">
              <div className="text-[10px] uppercase text-muted-foreground">CPU uso p95</div>
              <div className={cn("font-mono", pctTone(ng.avgCpuUsagePct))}>{ng.avgCpuUsagePct}%</div>
              <div className="text-[10px] text-muted-foreground">{fmtCores(ng.peakCpuUsedP95)}</div>
            </div>
            <div className="rounded-md border border-border/40 bg-card/50 px-2 py-1.5">
              <div className="text-[10px] uppercase text-muted-foreground">RAM req agg</div>
              <div className={cn("font-mono", pctTone(ng.avgRamRequestPct))}>{ng.avgRamRequestPct}%</div>
              <div className="text-[10px] text-muted-foreground">{fmtBytes(ng.totalRamRequestedBytes)}/{fmtBytes(ng.totalRamAllocatable)}</div>
            </div>
            <div className="rounded-md border border-border/40 bg-card/50 px-2 py-1.5">
              <div className="text-[10px] uppercase text-muted-foreground">RAM uso p95</div>
              <div className={cn("font-mono", pctTone(ng.avgRamUsagePct))}>{ng.avgRamUsagePct}%</div>
              <div className="text-[10px] text-muted-foreground">{fmtBytes(ng.peakRamUsedP95Bytes)}</div>
            </div>
          </div>

          {/* Max pod size hint */}
          {(ng.maxPodCpuRequest > 0 || ng.maxPodRamRequest > 0) && (
            <div className="text-[11px] text-muted-foreground">
              Pod más grande del NG: <span className="font-mono">{fmtCores(ng.maxPodCpuRequest)} CPU / {fmtBytes(ng.maxPodRamRequest)} RAM</span> — limita a qué tipos podemos bajar.
            </div>
          )}

          {/* Per-node table (informative only — no per-node recommendation since
              you cannot change a single node in a managed nodegroup) */}
          <div>
            <div className="mb-1 text-[10px] uppercase text-muted-foreground">Detalle por nodo (informativo)</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-2 py-1.5 text-left">Nodo</th>
                    <th className="px-2 py-1.5 text-left">Tipo</th>
                    <th className="px-2 py-1.5 text-right">Pods</th>
                    <th className="px-2 py-1.5 text-right">CPU req</th>
                    <th className="px-2 py-1.5 text-right">CPU uso</th>
                    <th className="px-2 py-1.5 text-right">RAM req</th>
                    <th className="px-2 py-1.5 text-right">RAM uso</th>
                    <th className="px-2 py-1.5 text-right">Coste/mes</th>
                  </tr>
                </thead>
                <tbody>
                  {ng.nodes.map((n) => (
                    <tr key={n.node} className="border-b border-border/20 hover:bg-muted/20">
                      <td className="px-2 py-1.5 font-mono text-[10px]" title={n.node}>
                        {n.node.split(".")[0].replace(/^ip-/, "")}
                        {n.isSpot && (
                          <Badge variant="outline" className="ml-1 h-4 px-1 text-[9px] border-purple-500/40 bg-purple-500/10 text-purple-700">
                            spot
                          </Badge>
                        )}
                      </td>
                      <td className="px-2 py-1.5 font-mono">{n.instanceType}</td>
                      <td className="px-2 py-1.5 text-right">{n.podCount}</td>
                      <td className={cn("px-2 py-1.5 text-right font-mono", pctTone(n.cpuRequestPct))}>{n.cpuRequestPct}%</td>
                      <td className={cn("px-2 py-1.5 text-right font-mono", pctTone(n.cpuUsagePct))}>{n.cpuUsagePct}%</td>
                      <td className={cn("px-2 py-1.5 text-right font-mono", pctTone(n.ramRequestPct))}>{n.ramRequestPct}%</td>
                      <td className={cn("px-2 py-1.5 text-right font-mono", pctTone(n.ramUsagePct))}>{n.ramUsagePct}%</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmt$(n.costMonthly)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────

interface Props {
  availableClusters?: string[];
}

export function K8sNodesAnalysis({ availableClusters }: Props) {
  const [data, setData] = useState<NodesSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the current user can call the AI analyze endpoint. We probe lazily
  // by asking the API for /api/ai/status (the same one Iskay uses).
  const [aiAvailable, setAiAvailable] = useState(false);

  const [cluster, setCluster] = useState<string>("dp-dev");
  const [showOnlySavings, setShowOnlySavings] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("cluster", cluster);
      const res = await fetch(`/api/finops/k8s-nodes?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setData(json);
    } catch (err: any) {
      setError(err?.message || "Error loading data");
    } finally {
      setLoading(false);
    }
  };

  // Probe AI availability once
  useEffect(() => {
    let cancelled = false;
    fetch("/api/finops/k8s-nodes/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cluster: "__probe__", nodegroup: "__probe__" }),
    })
      .then(async (r) => {
        if (cancelled) return;
        // 403 = no perm; anything else (400/404/500) means we got past the
        // auth gate and the AI button can be shown. We still won't *call* the
        // model unless the user clicks.
        setAiAvailable(r.status !== 403 && r.status !== 401);
      })
      .catch(() => { if (!cancelled) setAiAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    void fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster]);

  const clusterOptions = useMemo(() => {
    const fallback = ["dp-dev", "dp-uat", "dp-prod", "dp-tooling"];
    return availableClusters && availableClusters.length > 0 ? availableClusters : fallback;
  }, [availableClusters]);

  const filteredNodegroups = useMemo(() => {
    if (!data) return [] as NodegroupAnalysis[];
    if (!showOnlySavings) return data.nodegroups;
    return data.nodegroups.filter((ng) => ng.recommendation.estimatedMonthlySavings > 0 || ng.recommendation.kind === "scale_out_count");
  }, [data, showOnlySavings]);

  return (
    <Card className="border-border/70">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Cpu className="h-4 w-4 text-primary" /> Análisis de nodos
            </CardTitle>
            <CardDescription>
              Recomendaciones a nivel <strong>nodegroup</strong> (un EKS managed NG = una instance type, no se cambia un nodo en aislado). Cada propuesta ha sido validada contra la composición real de pods con 30% de margen.
            </CardDescription>
          </div>
          {data && (
            <div className="text-right">
              <div className="text-2xl font-bold text-success">{fmt$(data.estimatedMonthlySavings)}</div>
              <div className="text-[10px] uppercase text-muted-foreground">ahorro potencial/mes</div>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select
            value={cluster}
            onChange={(e) => setCluster(e.target.value)}
            className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
          >
            {clusterOptions.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showOnlySavings}
              onChange={(e) => setShowOnlySavings(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border"
            />
            Solo nodegroups accionables
          </label>

          <Button variant="outline" size="sm" onClick={fetchData} disabled={loading} className="ml-auto">
            {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="mr-1 h-3.5 w-3.5" />}
            Refrescar
          </Button>
        </div>

        {data && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 text-xs">
            <div className="rounded-md border border-border/40 bg-card/50 px-3 py-2">
              <div className="text-[10px] uppercase text-muted-foreground">Nodos</div>
              <div className="text-lg font-bold">{data.totalNodes}</div>
              {data.totalSpotNodes > 0 && (
                <div className="text-[10px] text-muted-foreground">{data.totalSpotNodes} spot</div>
              )}
            </div>
            <div className="rounded-md border border-border/40 bg-card/50 px-3 py-2">
              <div className="text-[10px] uppercase text-muted-foreground">Coste/mes</div>
              <div className="text-lg font-bold">{fmt$(data.totalCostMonthly)}</div>
            </div>
            <div className="rounded-md border border-border/40 bg-card/50 px-3 py-2">
              <div className="text-[10px] uppercase text-muted-foreground">Nodegroups</div>
              <div className="text-lg font-bold">{data.nodegroups.length}</div>
            </div>
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
              <div className="text-[10px] uppercase text-muted-foreground">Ahorro potencial</div>
              <div className="text-lg font-bold text-success">{fmt$(data.estimatedMonthlySavings)}</div>
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" /> {error}
          </div>
        )}
        {!loading && !error && data && data.nodegroups.length === 0 && (
          <div className="rounded-md border border-border/40 bg-muted/20 p-6 text-center text-sm text-muted-foreground">
            Sin datos de nodos para <strong>{cluster}</strong>.
          </div>
        )}

        {filteredNodegroups.length > 0 && (
          <div className="space-y-2">
            {filteredNodegroups.map((ng, idx) => (
              <NodegroupCard
                key={`${ng.cluster}-${ng.nodegroup}`}
                ng={ng}
                defaultOpen={idx === 0 && ng.recommendation.estimatedMonthlySavings > 0}
                canUseAi={aiAvailable}
              />
            ))}
          </div>
        )}

        {data && (
          <div className="text-[11px] text-muted-foreground">
            Actualizado: {new Date(data.generatedAt).toLocaleString("es-ES")} · Fuente: OpenCost + kube-state-metrics (Grafana Cloud) · uso = p95 últimas 24h
          </div>
        )}
      </CardContent>
    </Card>
  );
}
