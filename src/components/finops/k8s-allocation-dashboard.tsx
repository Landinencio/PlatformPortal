"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCcw, Server, Layers, TrendingDown, AlertTriangle, Boxes, Globe, Network } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { K8sVpaTable } from "@/components/finops/k8s-vpa-table";
import { K8sNodesAnalysis } from "@/components/finops/k8s-nodes-analysis";
import { FinOpsSection } from "@/components/finops/finops-section";

// ──────────────────────────────────────────────────────────────────────────
// Types (mirror server response)
// ──────────────────────────────────────────────────────────────────────────

interface ClusterCostBreakdown {
  cluster: string;
  nodeCpuCostHourly: number;
  nodeRamCostHourly: number;
  nodeTotalCostHourly: number;
  mgmtCostHourly: number;
  loadBalancerCostHourly: number;
  egressCostHourly: number;
  egressInternetHourly: number;
  egressRegionHourly: number;
  egressZoneHourly: number;
  totalCostHourly: number;
  totalCostMonthly: number;
  nodeCount: number;
  spotNodeCount: number;
  spotCoveragePct: number;
  cpuAllocatableCores: number;
  cpuAllocatedCores: number;
  cpuUsedCores: number;
  cpuEfficiencyPct: number;
  ramAllocatableGb: number;
  ramAllocatedGb: number;
  ramUsedGb: number;
  ramEfficiencyPct: number;
}

interface NamespaceAllocation {
  cluster: string;
  namespace: string;
  cpuCostHourly: number;
  ramCostHourly: number;
  totalCostHourly: number;
  totalCostMonthly: number;
  cpuAllocatedCores: number;
  cpuUsedCores: number;
  cpuEfficiencyPct: number;
  ramAllocatedGb: number;
  ramUsedGb: number;
  ramEfficiencyPct: number;
  wasteCostMonthly: number;
}

interface WorkloadAllocation {
  cluster: string;
  namespace: string;
  workload: string;
  cpuCostHourly: number;
  ramCostHourly: number;
  totalCostHourly: number;
  totalCostMonthly: number;
  podCount: number;
}

interface LoadBalancerCost {
  cluster: string;
  ingress: string;
  hourly: number;
  monthly: number;
}

interface RightsizingCandidate {
  cluster: string;
  namespace: string;
  workload: string;
  cpuAllocatedCores: number;
  cpuUsedCores: number;
  cpuEfficiencyPct: number;
  ramAllocatedGb: number;
  ramUsedGb: number;
  ramEfficiencyPct: number;
  monthlyCost: number;
  potentialMonthlySavings: number;
}

interface K8sFinOpsSummary {
  generatedAt: string;
  totalHourly: number;
  totalMonthly: number;
  totalEgressMonthly: number;
  totalLoadBalancersMonthly: number;
  totalMgmtMonthly: number;
  clusters: ClusterCostBreakdown[];
  topNamespaces: NamespaceAllocation[];
  topWorkloads: WorkloadAllocation[];
  topLoadBalancers: LoadBalancerCost[];
  rightsizingCandidates: RightsizingCandidate[];
  warnings: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function fmt$(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return "—";
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function fmtK(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function fmtNum(v: number, decimals = 1): string {
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function efficiencyTone(pct: number): string {
  if (pct >= 60) return "text-success";
  if (pct >= 30) return "text-warning";
  return "text-danger";
}

function efficiencyBg(pct: number): string {
  if (pct >= 60) return "bg-success/15 border-success/30";
  if (pct >= 30) return "bg-warning/15 border-warning/30";
  return "bg-danger/15 border-danger/30";
}

// ──────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────

export function K8sAllocationDashboard() {
  const [data, setData] = useState<K8sFinOpsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterCluster, setFilterCluster] = useState<string>("all");

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/finops/k8s-allocation");
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
  }, []);

  const filteredNamespaces = useMemo(() => {
    if (!data) return [];
    return filterCluster === "all"
      ? data.topNamespaces
      : data.topNamespaces.filter((n) => n.cluster === filterCluster);
  }, [data, filterCluster]);

  const filteredWorkloads = useMemo(() => {
    if (!data) return [];
    return filterCluster === "all"
      ? data.topWorkloads
      : data.topWorkloads.filter((w) => w.cluster === filterCluster);
  }, [data, filterCluster]);

  const filteredRightsizing = useMemo(() => {
    if (!data) return [];
    return filterCluster === "all"
      ? data.rightsizingCandidates
      : data.rightsizingCandidates.filter((r) => r.cluster === filterCluster);
  }, [data, filterCluster]);

  const filteredLBs = useMemo(() => {
    if (!data) return [];
    return filterCluster === "all"
      ? data.topLoadBalancers
      : data.topLoadBalancers.filter((lb) => lb.cluster === filterCluster);
  }, [data, filterCluster]);

  const totalRightsizingSavings = filteredRightsizing.reduce(
    (sum, r) => sum + r.potentialMonthlySavings,
    0,
  );

  if (loading && !data) {
    return (
      <Card className="border-border/70">
        <CardContent className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error && !data) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-8 text-center space-y-3">
          <AlertTriangle className="mx-auto h-8 w-8 text-destructive" />
          <div className="text-sm text-destructive">{error}</div>
          <Button size="sm" variant="outline" onClick={fetchData}>
            <RefreshCcw className="mr-1 h-3.5 w-3.5" /> Reintentar
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs text-muted-foreground">
            Actualizado: {new Date(data.generatedAt).toLocaleString("es-ES")} · Fuente: Grafana Cloud (OpenCost)
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={filterCluster}
            onChange={(e) => setFilterCluster(e.target.value)}
            className="rounded-md border border-border bg-card px-3 py-2 text-sm"
          >
            <option value="all">Todos los clusters</option>
            {data.clusters.map((c) => (
              <option key={c.cluster} value={c.cluster}>
                {c.cluster}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
            {loading ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="mr-1 h-3.5 w-3.5" />
            )}
            Refrescar
          </Button>
        </div>
      </div>

      {/* KPI bar */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <Card className="border-none bg-gradient-to-br from-primary to-primary/80 text-white">
          <CardContent className="space-y-1 p-5">
            <div className="text-xs uppercase tracking-wider opacity-80">Coste EKS / mes</div>
            <div className="text-3xl font-bold">{fmtK(data.totalMonthly)}</div>
            <div className="text-xs opacity-80">{fmt$(data.totalHourly)}/h · {data.clusters.length} clusters</div>
          </CardContent>
        </Card>
        <Card className="border-border/60">
          <CardContent className="space-y-1 p-5">
            <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
              <Server className="h-3 w-3" /> Compute (nodos)
            </div>
            <div className="text-2xl font-bold">
              {fmtK(data.clusters.reduce((s, c) => s + c.nodeTotalCostHourly * 730, 0))}
            </div>
            <div className="text-xs text-muted-foreground">
              {data.clusters.reduce((s, c) => s + c.nodeCount, 0)} nodos
            </div>
          </CardContent>
        </Card>
        <Card className="border-border/60">
          <CardContent className="space-y-1 p-5">
            <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
              <Network className="h-3 w-3" /> Network egress
            </div>
            <div className="text-2xl font-bold">{fmtK(data.totalEgressMonthly)}</div>
            <div className="text-xs text-muted-foreground">Internet + region + AZ</div>
          </CardContent>
        </Card>
        <Card className="border-border/60">
          <CardContent className="space-y-1 p-5">
            <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
              <Globe className="h-3 w-3" /> Load Balancers
            </div>
            <div className="text-2xl font-bold">{fmtK(data.totalLoadBalancersMonthly)}</div>
            <div className="text-xs text-muted-foreground">{data.topLoadBalancers.length} ELB</div>
          </CardContent>
        </Card>
        <Card className="border-success/40 bg-success/5">
          <CardContent className="space-y-1 p-5">
            <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-success">
              <TrendingDown className="h-3 w-3" /> Ahorro potencial
            </div>
            <div className="text-2xl font-bold text-success">
              {fmtK(totalRightsizingSavings)}
            </div>
            <div className="text-xs text-muted-foreground">
              {filteredRightsizing.length} workloads
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Detalle por cluster */}
      <FinOpsSection
        title="Detalle por cluster"
        description="Coste mensual desglosado, eficiencia CPU/RAM y cobertura spot."
        icon={<Server className="h-4 w-4" />}
        defaultOpen={true}
      >
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 text-left">Cluster</th>
                  <th className="px-3 py-2 text-right">Nodos</th>
                  <th className="px-3 py-2 text-right">Spot</th>
                  <th className="px-3 py-2 text-right">CPU eff.</th>
                  <th className="px-3 py-2 text-right">RAM eff.</th>
                  <th className="px-3 py-2 text-right">Compute</th>
                  <th className="px-3 py-2 text-right">Mgmt</th>
                  <th className="px-3 py-2 text-right">LB</th>
                  <th className="px-3 py-2 text-right">Egress</th>
                  <th className="px-3 py-2 text-right font-semibold">Total/mes</th>
                </tr>
              </thead>
              <tbody>
                {data.clusters.map((c) => (
                  <tr key={c.cluster} className="border-b border-border/30 hover:bg-muted/30">
                    <td className="px-3 py-2 font-medium">{c.cluster}</td>
                    <td className="px-3 py-2 text-right">{c.nodeCount}</td>
                    <td className="px-3 py-2 text-right">
                      {c.spotNodeCount > 0 ? (
                        <span className="text-success">{c.spotCoveragePct}%</span>
                      ) : (
                        <span className="text-muted-foreground">0%</span>
                      )}
                    </td>
                    <td className={cn("px-3 py-2 text-right", efficiencyTone(c.cpuEfficiencyPct))}>
                      {c.cpuEfficiencyPct}%
                    </td>
                    <td className={cn("px-3 py-2 text-right", efficiencyTone(c.ramEfficiencyPct))}>
                      {c.ramEfficiencyPct}%
                    </td>
                    <td className="px-3 py-2 text-right">{fmtK(c.nodeTotalCostHourly * 730)}</td>
                    <td className="px-3 py-2 text-right">{fmtK(c.mgmtCostHourly * 730)}</td>
                    <td className="px-3 py-2 text-right">{fmtK(c.loadBalancerCostHourly * 730)}</td>
                    <td className="px-3 py-2 text-right">{fmtK(c.egressCostHourly * 730)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{fmtK(c.totalCostMonthly)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
      </FinOpsSection>

      {/* Top namespaces */}
      <FinOpsSection
        title="Top namespaces"
        description="Coste mensual y eficiencia CPU/RAM (allocated vs usado real)."
        icon={<Layers className="h-4 w-4" />}
        badge={<Badge variant="outline" className="text-[10px]">{filteredNamespaces.length}</Badge>}
        defaultOpen={false}
      >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 text-left">Cluster</th>
                  <th className="px-3 py-2 text-left">Namespace</th>
                  <th className="px-3 py-2 text-right">CPU alloc</th>
                  <th className="px-3 py-2 text-right">CPU usado</th>
                  <th className="px-3 py-2 text-right">CPU eff.</th>
                  <th className="px-3 py-2 text-right">RAM alloc (GB)</th>
                  <th className="px-3 py-2 text-right">RAM usado (GB)</th>
                  <th className="px-3 py-2 text-right">RAM eff.</th>
                  <th className="px-3 py-2 text-right">Waste/mes</th>
                  <th className="px-3 py-2 text-right font-semibold">Total/mes</th>
                </tr>
              </thead>
              <tbody>
                {filteredNamespaces.slice(0, 30).map((ns) => (
                  <tr key={`${ns.cluster}::${ns.namespace}`} className="border-b border-border/30 hover:bg-muted/30">
                    <td className="px-3 py-2 text-muted-foreground">{ns.cluster}</td>
                    <td className="px-3 py-2 font-medium">{ns.namespace}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(ns.cpuAllocatedCores)}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(ns.cpuUsedCores)}</td>
                    <td className={cn("px-3 py-2 text-right", efficiencyTone(ns.cpuEfficiencyPct))}>
                      {ns.cpuEfficiencyPct}%
                    </td>
                    <td className="px-3 py-2 text-right">{fmtNum(ns.ramAllocatedGb)}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(ns.ramUsedGb)}</td>
                    <td className={cn("px-3 py-2 text-right", efficiencyTone(ns.ramEfficiencyPct))}>
                      {ns.ramEfficiencyPct}%
                    </td>
                    <td className="px-3 py-2 text-right text-warning">{fmtK(ns.wasteCostMonthly)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{fmtK(ns.totalCostMonthly)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
      </FinOpsSection>

      {/* Workloads sobredimensionados (heuristic) */}
      {filteredRightsizing.length > 0 && (
        <FinOpsSection
          title="Workloads sobredimensionados (heurístico)"
          description="Candidatos a rightsizing basados en p95 de uso 7d. Para recomendaciones VPA reales, ver sección 'Ajuste de recursos (VPA)' más abajo."
          icon={<TrendingDown className="h-4 w-4" />}
          badge={<Badge variant="outline" className="text-[10px] border-success/40 bg-success/10 text-success">{fmtK(totalRightsizingSavings)}/mes</Badge>}
          defaultOpen={false}
        >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 text-left">Cluster</th>
                    <th className="px-3 py-2 text-left">Namespace</th>
                    <th className="px-3 py-2 text-left">Workload</th>
                    <th className="px-3 py-2 text-right">CPU alloc</th>
                    <th className="px-3 py-2 text-right">CPU usado</th>
                    <th className="px-3 py-2 text-right">CPU eff.</th>
                    <th className="px-3 py-2 text-right">RAM alloc</th>
                    <th className="px-3 py-2 text-right">RAM eff.</th>
                    <th className="px-3 py-2 text-right">Coste/mes</th>
                    <th className="px-3 py-2 text-right font-semibold text-success">Ahorro/mes</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRightsizing.slice(0, 25).map((r, idx) => (
                    <tr
                      key={`${r.cluster}::${r.namespace}::${r.workload}::${idx}`}
                      className="border-b border-border/30 hover:bg-muted/30"
                    >
                      <td className="px-3 py-2 text-muted-foreground">{r.cluster}</td>
                      <td className="px-3 py-2">{r.namespace}</td>
                      <td className="px-3 py-2 font-medium">{r.workload}</td>
                      <td className="px-3 py-2 text-right">{fmtNum(r.cpuAllocatedCores)}</td>
                      <td className="px-3 py-2 text-right">{fmtNum(r.cpuUsedCores, 2)}</td>
                      <td className={cn("px-3 py-2 text-right", efficiencyTone(r.cpuEfficiencyPct))}>
                        {r.cpuEfficiencyPct}%
                      </td>
                      <td className="px-3 py-2 text-right">{fmtNum(r.ramAllocatedGb)}</td>
                      <td className={cn("px-3 py-2 text-right", efficiencyTone(r.ramEfficiencyPct))}>
                        {r.ramEfficiencyPct}%
                      </td>
                      <td className="px-3 py-2 text-right">{fmtK(r.monthlyCost)}</td>
                      <td className="px-3 py-2 text-right font-semibold text-success">{fmtK(r.potentialMonthlySavings)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
        </FinOpsSection>
      )}

      {/* Top workloads */}
      <FinOpsSection
        title="Top workloads"
        description="Coste mensual por deployment/statefulset (agrupado por nombre de pod)."
        icon={<Boxes className="h-4 w-4" />}
        badge={<Badge variant="outline" className="text-[10px]">{filteredWorkloads.length}</Badge>}
        defaultOpen={false}
      >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 text-left">Cluster</th>
                  <th className="px-3 py-2 text-left">Namespace</th>
                  <th className="px-3 py-2 text-left">Workload</th>
                  <th className="px-3 py-2 text-right">Pods</th>
                  <th className="px-3 py-2 text-right">CPU/mes</th>
                  <th className="px-3 py-2 text-right">RAM/mes</th>
                  <th className="px-3 py-2 text-right font-semibold">Total/mes</th>
                </tr>
              </thead>
              <tbody>
                {filteredWorkloads.slice(0, 30).map((w, idx) => (
                  <tr
                    key={`${w.cluster}::${w.namespace}::${w.workload}::${idx}`}
                    className="border-b border-border/30 hover:bg-muted/30"
                  >
                    <td className="px-3 py-2 text-muted-foreground">{w.cluster}</td>
                    <td className="px-3 py-2 text-muted-foreground">{w.namespace}</td>
                    <td className="px-3 py-2 font-medium">{w.workload}</td>
                    <td className="px-3 py-2 text-right">{w.podCount}</td>
                    <td className="px-3 py-2 text-right">{fmtK(w.cpuCostHourly * 730)}</td>
                    <td className="px-3 py-2 text-right">{fmtK(w.ramCostHourly * 730)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{fmtK(w.totalCostMonthly)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
      </FinOpsSection>

      {/* Load balancers */}
      {filteredLBs.length > 0 && (
        <FinOpsSection
          title="Load Balancers"
          description="Coste por ELB asociado a un Service de Kubernetes."
          icon={<Globe className="h-4 w-4" />}
          badge={<Badge variant="outline" className="text-[10px]">{filteredLBs.length}</Badge>}
          defaultOpen={false}
        >
          <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 text-left">Cluster</th>
                    <th className="px-3 py-2 text-left">Ingress</th>
                    <th className="px-3 py-2 text-right">$/h</th>
                    <th className="px-3 py-2 text-right font-semibold">$/mes</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLBs.slice(0, 20).map((lb, idx) => (
                    <tr key={`${lb.cluster}::${lb.ingress}::${idx}`} className="border-b border-border/30 hover:bg-muted/30">
                      <td className="px-3 py-2 text-muted-foreground">{lb.cluster}</td>
                      <td className="px-3 py-2 font-mono text-[11px]">{lb.ingress}</td>
                      <td className="px-3 py-2 text-right">{fmt$(lb.hourly, 4)}</td>
                      <td className="px-3 py-2 text-right font-semibold">{fmtK(lb.monthly)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
        </FinOpsSection>
      )}

      {data.warnings.length > 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs text-warning">
          <div className="font-semibold mb-1">Avisos:</div>
          {data.warnings.map((w, i) => (
            <div key={i}>· {w}</div>
          ))}
        </div>
      )}

      {/* Análisis de nodos (NEW) */}
      <K8sNodesAnalysis availableClusters={data.clusters.map((c) => c.cluster)} />

      {/* Ajuste de recursos (VPA recommendations) */}
      <K8sVpaTable availableClusters={data.clusters.map((c) => c.cluster)} />
    </div>
  );
}
