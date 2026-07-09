"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ClipboardCheck, Copy, HelpCircle, Loader2, RefreshCcw, Sparkles, TrendingDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// ──────────────────────────────────────────────────────────────────────────
// Types (mirror src/lib/k8s-vpa.ts — keep in sync)
// ──────────────────────────────────────────────────────────────────────────

type VpaStatus = "SOBRE" | "sobre" | "ok" | "infra" | "INFRA" | "unknown";

interface VpaRow {
  cluster: string;
  namespace: string;
  workload: string;
  workloadKind: string;
  container: string;
  squad: string | null;
  isSidecar: boolean;
  hasHpa: boolean;
  cpuRequest: number | null;
  cpuLimit: number | null;
  cpuTarget: number | null;
  cpuLower: number | null;
  cpuUpper: number | null;
  cpuRatio: number | null;
  cpuStatus: VpaStatus;
  memRequest: number | null;
  memLimit: number | null;
  memTarget: number | null;
  memLower: number | null;
  memUpper: number | null;
  memRatio: number | null;
  memStatus: VpaStatus;
  potentialMemSavingsMonthly: number;
  potentialCpuSavingsMonthly: number;
  potentialTotalSavingsMonthly: number;
  worstStatus: VpaStatus;
  worstRatio: number;
}

interface SquadAggregate {
  cluster: string;
  squad: string;
  rowCount: number;
  overprovisionedCount: number;
  underprovisionedCount: number;
  okCount: number;
  potentialMonthlySavings: number;
  totalMemRequestGb: number;
  totalMemTargetGb: number;
}

interface VpaSummary {
  generatedAt: string;
  clusters: string[];
  statusCounts: Record<VpaStatus, number>;
  totalPotentialMonthlySavings: number;
  rows: VpaRow[];
  bySquad: SquadAggregate[];
  warnings: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Format helpers
// ──────────────────────────────────────────────────────────────────────────

function fmtCpu(cores: number | null): string {
  if (cores == null) return "—";
  if (cores >= 1) return `${(Math.round(cores * 100) / 100).toFixed(2)}`;
  return `${Math.round(cores * 1000)}m`;
}

function fmtMem(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}Gi`;
  return `${Math.round(bytes / 1024 ** 2)}Mi`;
}

function fmt$(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

// "Safe" recommendation = what we'd actually paste into values.yaml.
// Memory uses upperBound to avoid OOMs; CPU uses target for efficiency.
function safeMemRec(r: VpaRow): number | null {
  return r.memUpper ?? r.memTarget;
}
function safeCpuRec(r: VpaRow): number | null {
  return r.cpuTarget;
}

// ──────────────────────────────────────────────────────────────────────────
// Status badges
// ──────────────────────────────────────────────────────────────────────────

const STATUS_DESCRIPTION: Record<VpaStatus, string> = {
  SOBRE: "Pides muchísimo más de lo que usas (≥3×). Bajar para ahorrar.",
  sobre: "Pides bastante más de lo que usas (1.5×–3×). Bajar.",
  ok: "Bien dimensionado. No hace falta tocar.",
  infra: "Pides menos de lo que necesitarías. Subir o riesgo de throttling/OOM bajo carga.",
  INFRA: "Pides muchísimo menos de lo recomendado. Subir, riesgo alto de OOM.",
  unknown: "Sin recomendación todavía (VPA aún calentando).",
};

function statusBadge(status: VpaStatus) {
  switch (status) {
    case "SOBRE":
      return { label: "Muy alto", emoji: "🔴", className: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400" };
    case "sobre":
      return { label: "Alto", emoji: "🟠", className: "border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-400" };
    case "ok":
      return { label: "OK", emoji: "🟢", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" };
    case "infra":
      return { label: "Bajo", emoji: "🟡", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" };
    case "INFRA":
      return { label: "Muy bajo", emoji: "🔴", className: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400" };
    default:
      return { label: "—", emoji: "·", className: "border-border bg-muted text-muted-foreground" };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Action message: what should the user actually do?
// ──────────────────────────────────────────────────────────────────────────

interface ActionMessage {
  verb: "Bajar" | "Subir" | "Mantener" | "Esperar";
  resource: "RAM" | "CPU" | "RAM+CPU";
  from: string;
  to: string;
  // Tone for styling
  tone: "save" | "warn" | "ok" | "neutral";
}

function buildAction(r: VpaRow): ActionMessage {
  const memSafe = safeMemRec(r);
  const cpuSafe = safeCpuRec(r);
  const memOver = r.memStatus === "SOBRE" || r.memStatus === "sobre";
  const memUnder = r.memStatus === "INFRA" || r.memStatus === "infra";
  const cpuOver = r.cpuStatus === "SOBRE" || r.cpuStatus === "sobre";
  const cpuUnder = r.cpuStatus === "INFRA" || r.cpuStatus === "infra";

  // Priority: memory first (OOM risk), then CPU.
  if (memUnder) {
    return {
      verb: "Subir",
      resource: "RAM",
      from: fmtMem(r.memRequest),
      to: memSafe != null ? fmtMem(memSafe) : "—",
      tone: "warn",
    };
  }
  if (cpuUnder) {
    return {
      verb: "Subir",
      resource: "CPU",
      from: fmtCpu(r.cpuRequest),
      to: cpuSafe != null ? fmtCpu(cpuSafe) : "—",
      tone: "warn",
    };
  }
  if (memOver && cpuOver) {
    return {
      verb: "Bajar",
      resource: "RAM+CPU",
      from: `${fmtMem(r.memRequest)} / ${fmtCpu(r.cpuRequest)}`,
      to: `${memSafe != null ? fmtMem(memSafe) : "—"} / ${cpuSafe != null ? fmtCpu(cpuSafe) : "—"}`,
      tone: "save",
    };
  }
  if (memOver) {
    return {
      verb: "Bajar",
      resource: "RAM",
      from: fmtMem(r.memRequest),
      to: memSafe != null ? fmtMem(memSafe) : "—",
      tone: "save",
    };
  }
  if (cpuOver) {
    return {
      verb: "Bajar",
      resource: "CPU",
      from: fmtCpu(r.cpuRequest),
      to: cpuSafe != null ? fmtCpu(cpuSafe) : "—",
      tone: "save",
    };
  }
  if (r.cpuStatus === "ok" || r.memStatus === "ok") {
    return { verb: "Mantener", resource: "RAM+CPU", from: "", to: "", tone: "ok" };
  }
  return { verb: "Esperar", resource: "RAM+CPU", from: "", to: "", tone: "neutral" };
}

// ──────────────────────────────────────────────────────────────────────────
// YAML preview helpers
// ──────────────────────────────────────────────────────────────────────────

function fmtBytesK8s(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${Math.ceil(bytes / (1024 * 1024 * 1024) * 10) / 10}Gi`;
  }
  const mib = bytes / (1024 * 1024);
  const stepped = Math.ceil(mib / 16) * 16;
  return `${stepped}Mi`;
}

function fmtCoresK8s(cores: number): string {
  if (cores >= 1) return `${Math.round(cores * 100) / 100}`;
  const milli = Math.ceil(cores * 1000 / 25) * 25;
  return `${milli}m`;
}

function buildYamlSnippet(row: VpaRow): string {
  const cpuReq = row.cpuTarget != null ? fmtCoresK8s(row.cpuTarget) : null;
  const memReq = row.memUpper != null
    ? fmtBytesK8s(row.memUpper)
    : row.memTarget != null
      ? fmtBytesK8s(row.memTarget)
      : null;
  const memLim = memReq;
  const lines = [
    `# VPA recommendation for ${row.namespace}/${row.workload} (${row.container})`,
    `# cluster=${row.cluster} status_cpu=${row.cpuStatus} status_mem=${row.memStatus}`,
    `resources:`,
    `  requests:`,
  ];
  if (cpuReq) lines.push(`    cpu: ${cpuReq}`);
  if (memReq) lines.push(`    memory: ${memReq}`);
  if (memLim) {
    lines.push(`  limits:`);
    lines.push(`    memory: ${memLim}`);
  }
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// How-to-read banner
// ──────────────────────────────────────────────────────────────────────────

function HowToReadBanner({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="rounded-md border border-border/60 bg-card/50">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted/30"
      >
        <span className="flex items-center gap-1.5">
          <HelpCircle className="h-3.5 w-3.5" />
          ¿Cómo se lee esta tabla?
        </span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border/40 px-3 py-3 text-xs leading-relaxed">
          <div>
            <strong>Lo que pides ahora</strong> ({" "}
            <span className="font-mono">RAM REQ</span>,{" "}
            <span className="font-mono">CPU REQ</span>) son los <em>requests</em> que tienes hoy en tu
            chart de Helm o Deployment.
          </div>
          <div>
            <strong>Lo que recomendamos poner</strong> ({" "}
            <span className="font-mono">RAM seguro</span>,{" "}
            <span className="font-mono">CPU seguro</span>) es el valor que el VPA dice que
            necesitas, ajustado al alza para evitar caídas: <strong>memoria = upperBound</strong> (no
            te quedas corto), <strong>CPU = target</strong> (eficiencia).
          </div>
          <div>
            <strong>El badge</strong> compara los dos:
            <ul className="ml-5 mt-1 list-disc space-y-0.5">
              <li><span className="text-red-600 dark:text-red-400">🔴 Muy alto</span>: pides 3× o más de lo que usas.</li>
              <li><span className="text-orange-600 dark:text-orange-400">🟠 Alto</span>: pides 1.5×–3× más.</li>
              <li><span className="text-emerald-600 dark:text-emerald-400">🟢 OK</span>: dimensión correcta.</li>
              <li><span className="text-amber-700 dark:text-amber-400">🟡 Bajo</span>: te falta margen, ajustar al alza.</li>
              <li><span className="text-red-600 dark:text-red-400">🔴 Muy bajo</span>: muy infra-dimensionado, riesgo OOM.</li>
            </ul>
          </div>
          <div>
            <strong>La columna "Acción"</strong> te dice qué cambio aplicar y dónde. Click en una
            fila para ver el bloque YAML listo para copiar.
          </div>
          <div className="text-muted-foreground">
            El ahorro estimado usa precios reales de OpenCost por cluster ($/GiB-mes y $/core-mes).
            Solo cuenta cuando se baja un workload sobredimensionado.
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
  /** Optional list of clusters to make available in the cluster selector. */
  availableClusters?: string[];
}

export function K8sVpaTable({ availableClusters }: Props) {
  const [data, setData] = useState<VpaSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [cluster, setCluster] = useState<string>("dp-dev");
  const [statusFilter, setStatusFilter] = useState<"all" | "over" | "under" | "ok">("all");
  const [namespaceQuery, setNamespaceQuery] = useState("");
  const [squadFilter, setSquadFilter] = useState<string>("all");
  const [includeSidecars, setIncludeSidecars] = useState(false);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<string | null>(null);
  const [howToOpen, setHowToOpen] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (cluster && cluster !== "all") params.set("cluster", cluster);
      params.set("includeSidecars", includeSidecars ? "true" : "false");
      const res = await fetch(`/api/finops/vpa?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setData(json);
    } catch (err: any) {
      setError(err?.message || "Error loading data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster, includeSidecars]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((r) => {
      if (statusFilter === "over" && !(r.worstStatus === "SOBRE" || r.worstStatus === "sobre")) return false;
      if (statusFilter === "under" && !(r.worstStatus === "INFRA" || r.worstStatus === "infra")) return false;
      if (statusFilter === "ok" && r.worstStatus !== "ok") return false;
      if (squadFilter !== "all" && r.squad !== squadFilter) return false;
      if (namespaceQuery && !r.namespace.toLowerCase().includes(namespaceQuery.toLowerCase())) return false;
      return true;
    });
  }, [data, statusFilter, squadFilter, namespaceQuery]);

  const totalSavingsFiltered = filtered.reduce((s, r) => s + r.potentialTotalSavingsMonthly, 0);

  const squadOptions = useMemo(() => {
    if (!data) return [] as string[];
    const set = new Set<string>();
    for (const r of data.rows) if (r.squad) set.add(r.squad);
    return Array.from(set).sort();
  }, [data]);

  const clusterOptions = useMemo(() => {
    if (availableClusters && availableClusters.length > 0) return availableClusters;
    if (!data) return ["dp-dev"];
    return data.clusters.length > 0 ? data.clusters : ["dp-dev"];
  }, [availableClusters, data]);

  const handleCopy = async (key: string, yaml: string) => {
    try {
      await navigator.clipboard.writeText(yaml);
      setCopyState(key);
      setTimeout(() => setCopyState(null), 1500);
    } catch (err) {
      console.warn("clipboard write failed", err);
    }
  };

  return (
    <Card className="border-border/70">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> Ajuste de recursos (VPA)
            </CardTitle>
            <CardDescription>
              Cada fila te dice qué <strong>request</strong> tienes hoy y qué <strong>valor seguro</strong>
              recomendamos para ahorrar (sin riesgo de OOM). El ahorro está en <strong>USD/mes</strong>.
            </CardDescription>
          </div>
          {data && (
            <div className="text-right">
              <div className="text-2xl font-bold text-success">{fmt$(totalSavingsFiltered)}</div>
              <div className="text-[10px] uppercase text-muted-foreground">ahorro potencial/mes</div>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* How-to-read collapsible help */}
        <HowToReadBanner open={howToOpen} onToggle={() => setHowToOpen((v) => !v)} />

        {/* Filters */}
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

          <div className="flex items-center gap-1 rounded-md border border-border bg-card px-1 py-1">
            {(["all", "over", "under", "ok"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={cn(
                  "rounded px-2 py-0.5 text-xs transition",
                  statusFilter === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                )}
              >
                {s === "all" ? "Todos" : s === "over" ? "🔴 Reducir" : s === "under" ? "🟡 Subir" : "🟢 Ok"}
              </button>
            ))}
          </div>

          <select
            value={squadFilter}
            onChange={(e) => setSquadFilter(e.target.value)}
            className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
          >
            <option value="all">Todos los squads</option>
            {squadOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <input
            type="text"
            value={namespaceQuery}
            onChange={(e) => setNamespaceQuery(e.target.value)}
            placeholder="namespace…"
            className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
          />

          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeSidecars}
              onChange={(e) => setIncludeSidecars(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border"
            />
            Incluir sidecars
          </label>

          <Button variant="outline" size="sm" onClick={fetchData} disabled={loading} className="ml-auto">
            {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="mr-1 h-3.5 w-3.5" />}
            Refrescar
          </Button>
        </div>

        {/* Status counters */}
        {data && (
          <div className="flex flex-wrap gap-2 text-xs">
            {(["SOBRE", "sobre", "ok", "infra", "INFRA"] as VpaStatus[]).map((s) => {
              const sb = statusBadge(s);
              const count = data.statusCounts[s];
              if (!count) return null;
              return (
                <Badge key={s} variant="outline" className={cn("gap-1", sb.className)} title={STATUS_DESCRIPTION[s]}>
                  {sb.emoji} {sb.label} <span className="font-mono">{count}</span>
                </Badge>
              );
            })}
            {data.warnings.length > 0 && (
              <Badge variant="outline" className="gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3" /> {data.warnings.length} aviso{data.warnings.length === 1 ? "" : "s"}
              </Badge>
            )}
          </div>
        )}

        {/* Squad summary */}
        {data && data.bySquad.length > 0 && (
          <div className="rounded-md border border-border/60 bg-card/50 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <TrendingDown className="h-3.5 w-3.5" /> Ahorro estimado por squad
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {data.bySquad.slice(0, 12).map((s) => (
                <div
                  key={`${s.cluster}-${s.squad}`}
                  className="flex items-center justify-between rounded border border-border/40 bg-card px-3 py-1.5 text-xs"
                >
                  <div>
                    <div className="font-medium">{s.squad}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {s.rowCount} workloads · {s.overprovisionedCount} sobre · {s.underprovisionedCount} infra
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-success">{fmt$(s.potentialMonthlySavings)}</div>
                    <div className="text-[10px] text-muted-foreground">/mes</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error / empty / loading */}
        {error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" /> {error}
          </div>
        )}

        {!loading && !error && data && data.rows.length === 0 && (
          <div className="rounded-md border border-border/40 bg-muted/20 p-6 text-center text-sm text-muted-foreground">
            <div className="mb-1 font-medium">Sin recomendaciones VPA disponibles</div>
            <div className="text-xs">
              Verifica que el VPA recommender está desplegado en el cluster y que las métricas
              <code className="mx-1 rounded bg-muted px-1 text-[11px]">kube_customresource_verticalpodautoscaler_*</code>
              llegan a Grafana Cloud.
            </div>
          </div>
        )}

        {/* Table */}
        {filtered.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-2 text-left">Deployment</th>
                  <th className="px-2 py-2 text-left">Squad</th>
                  <th className="px-2 py-2 text-right" title="Lo que pides hoy en values.yaml">Tienes (RAM/CPU)</th>
                  <th className="px-2 py-2 text-right" title="Lo que deberías poner para ir seguro">Recomendado</th>
                  <th className="px-2 py-2 text-left">Estado</th>
                  <th className="px-2 py-2 text-left">Acción</th>
                  <th className="px-2 py-2 text-right">Ahorro/mes</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((r, idx) => {
                  const key = `${r.cluster}|${r.namespace}|${r.workload}|${r.container}|${idx}`;
                  const expanded = expandedRow === key;
                  const memSb = statusBadge(r.memStatus);
                  const cpuSb = statusBadge(r.cpuStatus);
                  const action = buildAction(r);
                  const memSafeVal = safeMemRec(r);
                  const cpuSafeVal = safeCpuRec(r);

                  return (
                    <>
                      <tr
                        key={key}
                        onClick={() => setExpandedRow(expanded ? null : key)}
                        className={cn(
                          "cursor-pointer border-b border-border/30 transition hover:bg-muted/30",
                          expanded && "bg-muted/40",
                        )}
                      >
                        {/* Deployment + container */}
                        <td className="px-2 py-2">
                          <div className="font-medium">{r.workload}</div>
                          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                            <span className="font-mono">{r.namespace}</span>
                            <span>·</span>
                            <span>{r.container}</span>
                            {r.isSidecar && <Badge variant="outline" className="h-4 px-1 text-[9px]">sidecar</Badge>}
                            {r.hasHpa && (
                              <Badge variant="outline" className="h-4 border-amber-500/40 bg-amber-500/10 px-1 text-[9px] text-amber-700" title="Este workload tiene HPA. VPA en Auto/Initial puede chocar con el HPA.">
                                ⚠ HPA
                              </Badge>
                            )}
                          </div>
                        </td>

                        {/* Squad */}
                        <td className="px-2 py-2 text-xs text-muted-foreground">
                          {r.squad ?? "—"}
                        </td>

                        {/* Tienes */}
                        <td className="px-2 py-2 text-right font-mono text-xs">
                          <div>{fmtMem(r.memRequest)}</div>
                          <div className="text-[10px] text-muted-foreground">{fmtCpu(r.cpuRequest)}</div>
                        </td>

                        {/* Recomendado */}
                        <td className="px-2 py-2 text-right font-mono text-xs">
                          <div className={cn(
                            memSafeVal != null && r.memRequest != null && memSafeVal < r.memRequest && "text-emerald-700 dark:text-emerald-400",
                            memSafeVal != null && r.memRequest != null && memSafeVal > r.memRequest && "text-amber-700 dark:text-amber-400",
                          )}>
                            {fmtMem(memSafeVal)}
                          </div>
                          <div className={cn("text-[10px]",
                            cpuSafeVal != null && r.cpuRequest != null && cpuSafeVal < r.cpuRequest && "text-emerald-700 dark:text-emerald-400",
                            cpuSafeVal != null && r.cpuRequest != null && cpuSafeVal > r.cpuRequest && "text-amber-700 dark:text-amber-400",
                            !(cpuSafeVal != null && r.cpuRequest != null && cpuSafeVal !== r.cpuRequest) && "text-muted-foreground",
                          )}>
                            {fmtCpu(cpuSafeVal)}
                          </div>
                        </td>

                        {/* Estado: dos badges, RAM y CPU */}
                        <td className="px-2 py-2">
                          <div className="flex flex-col gap-1">
                            <Badge variant="outline" className={cn("h-5 gap-1 text-[10px]", memSb.className)}
                              title={`RAM: ${STATUS_DESCRIPTION[r.memStatus]}${r.memRatio ? ` (ratio ${r.memRatio.toFixed(1)}×)` : ""}`}>
                              <span className="font-mono">RAM</span>{" "}
                              <span>{memSb.emoji} {memSb.label}</span>
                            </Badge>
                            <Badge variant="outline" className={cn("h-5 gap-1 text-[10px]", cpuSb.className)}
                              title={`CPU: ${STATUS_DESCRIPTION[r.cpuStatus]}${r.cpuRatio ? ` (ratio ${r.cpuRatio.toFixed(1)}×)` : ""}`}>
                              <span className="font-mono">CPU</span>{" "}
                              <span>{cpuSb.emoji} {cpuSb.label}</span>
                            </Badge>
                          </div>
                        </td>

                        {/* Acción */}
                        <td className="px-2 py-2">
                          {action.verb === "Mantener" || action.verb === "Esperar" ? (
                            <span className={cn("text-xs",
                              action.tone === "ok" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground",
                            )}>
                              {action.verb === "Mantener" ? "✓ No tocar" : "Esperando datos"}
                            </span>
                          ) : (
                            <div className={cn("text-xs",
                              action.tone === "save" ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400",
                            )}>
                              <strong>{action.verb} {action.resource}</strong>
                              <div className="text-[10px] font-mono">
                                {action.from} <span className="opacity-60">→</span> {action.to}
                              </div>
                            </div>
                          )}
                        </td>

                        {/* Ahorro */}
                        <td className={cn("px-2 py-2 text-right font-medium",
                          r.potentialTotalSavingsMonthly > 0 ? "text-success" : "text-muted-foreground")}
                        >
                          {fmt$(r.potentialTotalSavingsMonthly)}
                        </td>

                        {/* Expand */}
                        <td className="px-2 py-2 text-right text-muted-foreground">
                          {expanded ? "▾" : "▸"}
                        </td>
                      </tr>

                      {expanded && (
                        <tr key={`${key}-expanded`} className="bg-muted/10">
                          <td colSpan={8} className="px-3 py-3">
                            {/* TL;DR action box */}
                            {(action.verb === "Bajar" || action.verb === "Subir") && (
                              <div className={cn(
                                "mb-3 rounded-md border px-3 py-2 text-sm",
                                action.tone === "save"
                                  ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300"
                                  : "border-amber-500/40 bg-amber-500/5 text-amber-800 dark:text-amber-300",
                              )}>
                                <div className="font-semibold">
                                  {action.verb} <span className="font-mono">{action.resource}</span>:
                                  <span className="ml-1 font-mono">{action.from}</span>
                                  <span className="mx-1 opacity-70">→</span>
                                  <span className="font-mono">{action.to}</span>
                                </div>
                                <div className="mt-1 text-xs opacity-80">
                                  Edita el bloque <code className="rounded bg-card px-1 text-[11px]">resources.requests</code> en el
                                  <code className="ml-1 rounded bg-card px-1 text-[11px]">values.yaml</code> de tu chart (o el Deployment) con los valores nuevos.
                                  Para memoria, sube también <code className="rounded bg-card px-1 text-[11px]">resources.limits.memory</code> al mismo valor.
                                </div>
                              </div>
                            )}

                            <div className="grid gap-3 lg:grid-cols-2">
                              <div className="space-y-2 text-xs">
                                <div className="font-semibold uppercase tracking-wide text-muted-foreground">Por qué este valor</div>
                                <div className="space-y-1.5">
                                  <div>
                                    <span className="text-muted-foreground">RAM:</span>{" "}
                                    el VPA observó tu uso real durante 7 días.
                                    Recomendamos <strong>upperBound</strong> ({fmtMem(r.memUpper)}) en lugar de <em>target</em> ({fmtMem(r.memTarget)})
                                    para que tengas margen ante picos y no haya riesgo de OOM.
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">CPU:</span>{" "}
                                    recomendamos <strong>target</strong> ({fmtCpu(r.cpuTarget)}) — la CPU es elástica, no causa
                                    crashes (solo throttling), así que ir al valor justo es eficiente.
                                  </div>
                                </div>

                                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border/30">
                                  <div>
                                    <div className="text-[10px] uppercase text-muted-foreground">Mínimo seguro</div>
                                    <div className="font-mono">{fmtMem(r.memLower)} / {fmtCpu(r.cpuLower)}</div>
                                  </div>
                                  <div>
                                    <div className="text-[10px] uppercase text-muted-foreground">Target VPA</div>
                                    <div className="font-mono">{fmtMem(r.memTarget)} / {fmtCpu(r.cpuTarget)}</div>
                                  </div>
                                  <div>
                                    <div className="text-[10px] uppercase text-muted-foreground">Máximo seguro</div>
                                    <div className="font-mono">{fmtMem(r.memUpper)} / {fmtCpu(r.cpuUpper)}</div>
                                  </div>
                                </div>

                                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border/30">
                                  <div>
                                    <div className="text-[10px] uppercase text-muted-foreground">Limit actual</div>
                                    <div className="font-mono">{fmtMem(r.memLimit)} / {fmtCpu(r.cpuLimit)}</div>
                                  </div>
                                  <div>
                                    <div className="text-[10px] uppercase text-muted-foreground">Container</div>
                                    <div className="font-mono">{r.container}</div>
                                  </div>
                                </div>

                                {r.hasHpa && (
                                  <div className="rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                                    ⚠ Este workload también tiene un HPA. Si VPA está en
                                    <code className="mx-1 text-[10px]">Auto</code> o
                                    <code className="text-[10px]">Initial</code>, ambos pueden chocar al ajustar la misma dimensión.
                                    Mantén VPA en <code className="text-[10px]">Off</code> aquí y aplica los valores a mano.
                                  </div>
                                )}
                              </div>

                              <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                    Pegar en values.yaml
                                  </div>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleCopy(key, buildYamlSnippet(r));
                                    }}
                                  >
                                    {copyState === key ? (
                                      <><ClipboardCheck className="mr-1 h-3.5 w-3.5" /> Copiado</>
                                    ) : (
                                      <><Copy className="mr-1 h-3.5 w-3.5" /> Copiar YAML</>
                                    )}
                                  </Button>
                                </div>
                                <pre className="overflow-x-auto rounded border border-border/50 bg-muted/40 p-3 text-[11px] leading-snug">
                                  {buildYamlSnippet(r)}
                                </pre>
                                {r.potentialTotalSavingsMonthly > 0 && (
                                  <div className="text-[11px] text-muted-foreground">
                                    Ahorro estimado:
                                    <span className="ml-1 font-semibold text-success">{fmt$(r.potentialTotalSavingsMonthly)}/mes</span>
                                    {r.potentialMemSavingsMonthly > 0 && (
                                      <> · RAM: <span className="font-mono">{fmt$(r.potentialMemSavingsMonthly)}</span></>
                                    )}
                                    {r.potentialCpuSavingsMonthly > 0 && (
                                      <> · CPU: <span className="font-mono">{fmt$(r.potentialCpuSavingsMonthly)}</span></>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {filtered.length > 200 && (
          <div className="text-xs text-muted-foreground">
            Mostrando 200 de {filtered.length} filas. Filtra por namespace o squad para acotar.
          </div>
        )}

        {data && (
          <div className="text-[11px] text-muted-foreground">
            Actualizado: {new Date(data.generatedAt).toLocaleString("es-ES")} · Fuente: VPA recommender + OpenCost (Grafana Cloud)
          </div>
        )}
      </CardContent>
    </Card>
  );
}
