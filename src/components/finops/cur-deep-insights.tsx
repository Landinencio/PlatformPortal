"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Brain,
  ChevronDown,
  ChevronUp,
  Cloud,
  Database,
  HardDrive,
  Layers,
  Loader2,
  Lock,
  Network,
  Receipt,
  Server,
  Sparkles,
  TrendingDown,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FinOpsSection } from "@/components/finops/finops-section";
import { cn } from "@/lib/utils";
import { scopeSnapshotToAccounts } from "@/lib/finops-scope";
import type { CurFullSnapshot } from "@/lib/athena-cur";

export interface CurDeepInsights {
  totalCost: number;
  netInfraCost: number;
  marketplace: { cost: number; items: Array<{ productCode: string; description: string; cost: number; date: string | null }> };
  discounts: {
    sppDiscount: number;
    bundledDiscount: number;
    credits: number;
    refunds: number;
    savingsPlanNegation: number;
    tax: number;
  };
  savingsPlans: { coveredCost: number; onDemandEquivalent: number; savingsAmount: number; savingsPct: number };
  topResources: Array<{ accountId: string; service: string; resourceId: string; cost: number; instanceType: string }>;
  hiddenCosts: {
    gp2Volumes: { monthlyCost: number; estimatedSavings: number; resourceCount: number };
    gp2Detail: Array<{ resourceId: string; account: string; gbMonth: number; cost: number }>;
    extendedSupport: Array<{ engine: string; monthlyCost: number; usageType: string }>;
    extendedSupportDetail: Array<{ resourceId: string; account: string; engine: string; cost: number }>;
    cloudwatchLogs: { totalCost: number; topGroups: Array<{ logGroup: string; cost: number; account: string }> };
    natGateways: { totalCost: number; dataProcessedCost: number; hoursCost: number; topConsumers: Array<{ resourceId: string; account: string; cost: number }> };
    bedrock: { totalCost: number; byModel: Array<{ model: string; account: string; accountName?: string; cost: number }>; monthlyTrend: Array<{ month: string; cost: number }> };
    snapshotCost: number;
    interZoneTransfer: number;
  };
  ec2Fleet: Array<{ instanceType: string; accountId: string; accountName: string; resourceCount: number; cost: number }>;
  byAccount: Array<{ accountId: string; accountName: string; cost: number }>;
  tagCompliance?: Array<{
    tagKey: string;
    taggedCost: number;
    untaggedCost: number;
    coveragePct: number;
    distinctValues: number;
  }>;
}

interface Props {
  data: CurDeepInsights | null;
  /** Account set selected in the global Filtro_Cuentas. The snapshot is scoped
   *  to this set before rendering (defence-in-depth on top of the server-side
   *  scoping in /api/finops/cur-direct). */
  selectedAccountIds: string[];
  loading?: boolean;
}

function fmt$(v: number) {
  if (!Number.isFinite(v)) return "—";
  return `$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtK(v: number) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function shortRid(rid: string, maxLen = 50): string {
  if (!rid) return "";
  if (rid.length <= maxLen) return rid;
  return `…${rid.slice(rid.length - maxLen + 1)}`;
}

export function CurDeepInsights({ data, selectedAccountIds, loading }: Props) {
  // Defence-in-depth: re-scope the incoming snapshot to the selected accounts on
  // the client. The server already scopes (/api/finops/cur-direct), but this drops
  // any row that slipped through (stale cache / query regression) so nothing from
  // an unselected account is ever rendered. Memoised to avoid recomputing per render.
  const scopedData = useMemo(
    () =>
      data
        ? (scopeSnapshotToAccounts(
            data as unknown as CurFullSnapshot,
            selectedAccountIds,
          ) as unknown as CurDeepInsights)
        : null,
    [data, selectedAccountIds],
  );

  if (loading) {
    return (
      <Card className="border-border/70">
        <CardContent className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }
  if (!scopedData) return null;

  const data_ = scopedData;
  return (
    <div className="space-y-3">
      <NetCostBanner data={data_} />
      <FinOpsSection
        title="Costes ocultos detectados"
        description="Quick wins detectados automáticamente desde el CUR"
        icon={<AlertTriangle className="h-4 w-4 text-warning" />}
        badge={hiddenSavings(data_) > 0 ? <Badge variant="outline" className="border-success/40 text-success text-[10px]">Ahorro est. {fmtK(hiddenSavings(data_))}/mes</Badge> : null}
        defaultOpen
      >
        <HiddenCostsCard data={data_} />
      </FinOpsSection>

      {data_.tagCompliance && data_.tagCompliance.length > 0 && (
        <FinOpsSection
          title="Tagging Compliance"
          description="Cobertura de tags obligatorios sobre el coste"
          icon={<Database className="h-4 w-4 text-info" />}
        >
          <TagComplianceCard data={data_} />
        </FinOpsSection>
      )}

      <FinOpsSection
        title="EC2 fleet por instance type"
        description="Distribución de gasto por familia de instancia"
        icon={<Server className="h-4 w-4" />}
      >
        <Ec2FleetCard data={data_} />
      </FinOpsSection>

      <FinOpsSection
        title="CloudWatch Logs · top groups"
        description={`Total ${fmtMoneyBig(data_.hiddenCosts.cloudwatchLogs.totalCost)} · revisar retención`}
        icon={<Layers className="h-4 w-4" />}
      >
        <CloudwatchLogsCard data={data_} />
      </FinOpsSection>

      <FinOpsSection
        title="NAT Gateway · top consumidores"
        description={`Hours ${fmtMoneyBig(data_.hiddenCosts.natGateways.hoursCost)} · Data ${fmtMoneyBig(data_.hiddenCosts.natGateways.dataProcessedCost)}`}
        icon={<Network className="h-4 w-4" />}
      >
        <NatGatewayCard data={data_} />
      </FinOpsSection>

      {data_.hiddenCosts.extendedSupport.length > 0 && (
        <FinOpsSection
          title="RDS Extended Support"
          description="Pagamos a AWS por NO migrar bases de datos"
          icon={<Lock className="h-4 w-4 text-danger" />}
          badge={<Badge variant="outline" className="border-danger/40 text-danger text-[10px]">{fmtMoneyBig(data_.hiddenCosts.extendedSupport.reduce((s, e) => s + e.monthlyCost, 0))}/mes</Badge>}
        >
          <ExtendedSupportCard data={data_} />
        </FinOpsSection>
      )}

      {data_.hiddenCosts.gp2Detail.length > 0 && (
        <FinOpsSection
          title="Plan migración EBS gp2 → gp3"
          description={`${data_.hiddenCosts.gp2Detail.length} volúmenes detectados con ahorro ~20%`}
          icon={<HardDrive className="h-4 w-4 text-warning" />}
          badge={<Badge variant="outline" className="border-success/40 text-success text-[10px]">Ahorro {fmtMoneyBig(data_.hiddenCosts.gp2Detail.reduce((s, v) => s + v.cost, 0) * 0.2)}/mes</Badge>}
        >
          <Gp2MigrationCard data={data_} />
        </FinOpsSection>
      )}
    </div>
  );
}

function hiddenSavings(d: CurDeepInsights): number {
  return d.hiddenCosts.gp2Volumes.estimatedSavings + d.hiddenCosts.extendedSupport.reduce((s, x) => s + x.monthlyCost, 0);
}

function fmtMoneyBig(v: number) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Net cost waterfall banner
// ──────────────────────────────────────────────────────────────────────────
function NetCostBanner({ data }: { data: CurDeepInsights }) {
  const gross = data.totalCost;
  const market = data.marketplace.cost;
  const sp = Math.abs(data.discounts.savingsPlanNegation || 0);
  const spp = Math.abs(data.discounts.sppDiscount || 0);
  const bundle = Math.abs(data.discounts.bundledDiscount || 0);
  const credits = Math.abs(data.discounts.credits || 0);
  const refunds = Math.abs(data.discounts.refunds || 0);
  const net = gross - market;
  const netAfterDiscounts = net - spp - bundle - credits - refunds; // SP is informative, already in gross
  return (
    <Card className="border-border/60 bg-gradient-to-br from-primary/5 via-background to-info/5 shadow-sm">
      <CardContent className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="space-y-1">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Receipt className="h-3.5 w-3.5" />
              Coste Real (Net Cost Waterfall)
            </div>
            <div className="flex items-baseline gap-3">
              <div className="text-4xl font-bold text-foreground">{fmt$(net)}</div>
              <div className="text-sm text-muted-foreground">infra neta</div>
            </div>
            <p className="text-sm text-muted-foreground max-w-2xl">
              {fmt$(gross)} bruto AWS − {fmt$(market)} de Marketplace contracts = <strong>{fmt$(net)}</strong> de infraestructura real este periodo.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Pill label="Gross AWS" value={gross} tone="muted" />
            <Pill label="Marketplace" value={-market} tone="warning" />
            <Pill label="Savings Plans" value={-sp} tone="success" hint="ya incluido en gross" />
            <Pill label="SPP discount" value={-spp} tone="success" />
            <Pill label="Bundled" value={-bundle} tone="success" />
            <Pill label="Net (post desc.)" value={netAfterDiscounts} tone="primary" bold />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Pill({
  label,
  value,
  tone,
  hint,
  bold,
}: {
  label: string;
  value: number;
  tone: "muted" | "primary" | "success" | "warning" | "danger";
  hint?: string;
  bold?: boolean;
}) {
  const toneCls: Record<typeof tone, string> = {
    muted: "bg-muted/40 text-muted-foreground",
    primary: "bg-primary/10 text-primary border border-primary/20",
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
    danger: "bg-danger/10 text-danger",
  };
  return (
    <div className={cn("rounded-lg px-3 py-2 flex flex-col", toneCls[tone])}>
      <span className="text-[10px] uppercase tracking-wider opacity-80">{label}</span>
      <span className={cn("text-sm tabular-nums", bold && "font-bold text-base")}>
        {value < 0 ? "− " : ""}{fmt$(value)}
      </span>
      {hint && <span className="text-[9px] opacity-60">{hint}</span>}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Hidden costs (auto-detected quick wins)
// ──────────────────────────────────────────────────────────────────────────
function HiddenCostsCard({ data }: { data: CurDeepInsights }) {
  const items: Array<{
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    cost: number;
    saving?: number;
    description: string;
    severity: "low" | "medium" | "high";
  }> = [];

  if (data.hiddenCosts.gp2Volumes.monthlyCost > 50) {
    items.push({
      icon: HardDrive,
      title: "EBS gp2 detectado",
      cost: data.hiddenCosts.gp2Volumes.monthlyCost,
      saving: data.hiddenCosts.gp2Volumes.estimatedSavings,
      description: `${data.hiddenCosts.gp2Volumes.resourceCount} volúmenes en gp2 — migrar a gp3 ahorra ~20% manteniendo IOPS.`,
      severity: data.hiddenCosts.gp2Volumes.estimatedSavings > 200 ? "high" : "medium",
    });
  }
  for (const ext of data.hiddenCosts.extendedSupport || []) {
    items.push({
      icon: Lock,
      title: `Extended Support: ${ext.engine}`,
      cost: ext.monthlyCost,
      saving: ext.monthlyCost,
      description: `Pagas Extended Support por ${ext.engine}. Migrar a versión soportada elimina este coste.`,
      severity: ext.monthlyCost > 500 ? "high" : "medium",
    });
  }
  if (data.hiddenCosts.cloudwatchLogs.totalCost > 1000) {
    items.push({
      icon: Layers,
      title: "CloudWatch Logs caro",
      cost: data.hiddenCosts.cloudwatchLogs.totalCost,
      description: `Top log group: ${data.hiddenCosts.cloudwatchLogs.topGroups[0]?.logGroup.split("/").slice(-2).join("/") || "—"}. Revisar lifecycle/retention.`,
      severity: data.hiddenCosts.cloudwatchLogs.totalCost > 2500 ? "high" : "medium",
    });
  }
  if (data.hiddenCosts.natGateways.dataProcessedCost > 300) {
    items.push({
      icon: Network,
      title: "NAT Gateway data processing",
      cost: data.hiddenCosts.natGateways.totalCost,
      description: `${fmt$(data.hiddenCosts.natGateways.dataProcessedCost)} de tráfico procesado. Top: ${shortRid(data.hiddenCosts.natGateways.topConsumers[0]?.resourceId || "—", 30)}`,
      severity: "medium",
    });
  }
  if (data.hiddenCosts.bedrock.totalCost > 100) {
    items.push({
      icon: Sparkles,
      title: "Bedrock / GenAI",
      cost: data.hiddenCosts.bedrock.totalCost,
      description: `${data.hiddenCosts.bedrock.byModel.length} inference profiles. Top: ${data.hiddenCosts.bedrock.byModel[0]?.model.slice(0, 50) || "—"}`,
      severity: "low",
    });
  }
  if (data.hiddenCosts.snapshotCost > 100) {
    items.push({
      icon: Database,
      title: "Snapshots EBS",
      cost: data.hiddenCosts.snapshotCost,
      description: "Posibles snapshots viejos. Revisar lifecycle policy con AWS Backup.",
      severity: "low",
    });
  }
  if (data.hiddenCosts.interZoneTransfer > 100) {
    items.push({
      icon: Network,
      title: "Tráfico inter-AZ",
      cost: data.hiddenCosts.interZoneTransfer,
      description: "Coste por tráfico entre AZ. Revisar topología (RDS Multi-AZ, EKS pod scheduling).",
      severity: "low",
    });
  }

  const totalSaving = items.reduce((sum, i) => sum + (i.saving || 0), 0);

  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2 text-warning">
              <AlertTriangle className="h-4 w-4" />
              Costes ocultos detectados
            </CardTitle>
            <CardDescription>Ahorros y desperdicio detectados automáticamente desde el CUR</CardDescription>
          </div>
          {totalSaving > 0 && (
            <div className="text-right">
              <div className="text-2xl font-bold text-success">{fmtK(totalSaving)}</div>
              <div className="text-[10px] uppercase text-muted-foreground">ahorro est. /mes</div>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            ✓ No se detectaron costes ocultos significativos en el periodo seleccionado.
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map((item, idx) => {
              const Icon = item.icon;
              const sevCls = {
                low: "border-info/30 bg-info/5",
                medium: "border-warning/40 bg-warning/10",
                high: "border-danger/40 bg-danger/10",
              }[item.severity];
              return (
                <div key={idx} className={cn("rounded-xl border p-3", sevCls)}>
                  <div className="flex items-start gap-3">
                    <div className="rounded-lg bg-card p-2 shadow-sm">
                      <Icon className="h-4 w-4 text-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <div className="text-sm font-semibold text-foreground truncate">{item.title}</div>
                        <div className="text-sm font-bold whitespace-nowrap">{fmtK(item.cost)}</div>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground leading-snug">{item.description}</div>
                      {item.saving !== undefined && item.saving > 0 && (
                        <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">
                          <TrendingDown className="h-3 w-3" />
                          ahorro est. {fmtK(item.saving)}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Top resources (global)
// ──────────────────────────────────────────────────────────────────────────
function TopResourcesCard({ data }: { data: CurDeepInsights }) {
  const accountById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of data.byAccount) m.set(a.accountId, a.accountName);
    return m;
  }, [data]);
  const top = data.topResources.slice(0, 30);

  return (
    <Card className="border-border/70">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Server className="h-4 w-4" />
          Top 30 recursos por coste
        </CardTitle>
        <CardDescription>Vista global multi-cuenta — el filtro y drill-down siguen disponibles abajo</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/50 text-muted-foreground">
                <th className="px-2 py-1.5 text-left">#</th>
                <th className="px-2 py-1.5 text-left">Recurso</th>
                <th className="px-2 py-1.5 text-left">Cuenta</th>
                <th className="px-2 py-1.5 text-left">Servicio</th>
                <th className="px-2 py-1.5 text-right">Coste</th>
              </tr>
            </thead>
            <tbody>
              {top.map((r, idx) => (
                <tr key={`${r.accountId}::${r.resourceId}::${idx}`} className="border-b border-border/30 hover:bg-muted/30">
                  <td className="px-2 py-1.5 text-muted-foreground tabular-nums">{idx + 1}</td>
                  <td className="px-2 py-1.5 font-mono text-[11px] truncate max-w-[280px]" title={r.resourceId}>
                    {shortRid(r.resourceId, 50)}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground truncate max-w-[140px]">
                    {accountById.get(r.accountId) || r.accountId}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">{r.service}</td>
                  <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{fmt$(r.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Bedrock / GenAI
// ──────────────────────────────────────────────────────────────────────────
export function BedrockCard({ data }: { data: CurDeepInsights }) {
  const items = data.hiddenCosts.bedrock.byModel;
  const trend = data.hiddenCosts.bedrock.monthlyTrend || [];
  if (items.length === 0) return null;
  const trendDelta = trend.length >= 2 ? trend[trend.length - 1].cost - trend[trend.length - 2].cost : 0;
  return (
    <Card className="border-border/70">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Brain className="h-4 w-4 text-violet-500" />
              GenAI / Bedrock por modelo
            </CardTitle>
            <CardDescription>
              Total <strong>{fmt$(data.hiddenCosts.bedrock.totalCost)}</strong> · {items.length} inference profiles activos
            </CardDescription>
          </div>
          {trend.length > 1 && (
            <div className={cn(
              "rounded-full px-3 py-1 text-xs font-semibold",
              trendDelta > 0 ? "bg-warning/10 text-warning" : "bg-success/10 text-success",
            )}>
              {trendDelta > 0 ? "↑" : "↓"} {fmt$(Math.abs(trendDelta))} vs mes anterior
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {trend.length > 1 && (
          <div className="flex items-end gap-2 h-12 border-b border-border/40 pb-2">
            {trend.map((m, i) => {
              const max = Math.max(...trend.map((t) => t.cost), 1);
              const heightPct = Math.max(8, (m.cost / max) * 100);
              return (
                <div key={m.month} className="flex flex-col items-center gap-1 flex-1" title={`${m.month}: ${fmt$(m.cost)}`}>
                  <div className="w-full bg-violet-500/30 rounded-t" style={{ height: `${heightPct}%` }} />
                  <span className="text-[9px] text-muted-foreground">{m.month.slice(5)}</span>
                </div>
              );
            })}
          </div>
        )}
        <div className="space-y-1.5">
          {items.slice(0, 12).map((m, i) => {
            const max = items[0].cost || 1;
            const widthPct = Math.max(5, (m.cost / max) * 100);
            return (
              <div key={`${m.model}-${m.account}-${i}`} className="flex items-center gap-3">
                <span className="text-xs font-medium w-44 truncate text-right" title={m.model}>
                  {m.model.replace(/^eu\./, "").replace(/-v\d+:\d+$/, "")}
                </span>
                <div className="flex-1 h-6 bg-muted/30 rounded-md overflow-hidden relative">
                  <div
                    className="h-full bg-gradient-to-r from-violet-500/80 to-violet-500/40"
                    style={{ width: `${widthPct}%` }}
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold">
                    {fmt$(m.cost)}
                  </span>
                </div>
                <span className="text-[10px] text-muted-foreground w-20 text-right truncate" title={m.accountName || m.account}>
                  {m.accountName || m.account.slice(-12)}
                </span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// EC2 fleet
// ──────────────────────────────────────────────────────────────────────────
function Ec2FleetCard({ data }: { data: CurDeepInsights }) {
  const fleet = data.ec2Fleet.slice(0, 12);
  if (fleet.length === 0) return null;
  return (
    <Card className="border-border/70">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Server className="h-4 w-4" />
          EC2 fleet por instance type
        </CardTitle>
        <CardDescription>Distribución de gasto e instancias por familia</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/50 text-muted-foreground">
                <th className="px-2 py-1.5 text-left">Instance type</th>
                <th className="px-2 py-1.5 text-left">Cuenta</th>
                <th className="px-2 py-1.5 text-right">Recursos</th>
                <th className="px-2 py-1.5 text-right">Coste</th>
                <th className="px-2 py-1.5 text-right">Coste/recurso</th>
              </tr>
            </thead>
            <tbody>
              {fleet.map((f, idx) => (
                <tr key={`${f.instanceType}-${f.accountId}-${idx}`} className="border-b border-border/30 hover:bg-muted/30">
                  <td className="px-2 py-1.5 font-mono text-[11px]">{f.instanceType}</td>
                  <td className="px-2 py-1.5 text-muted-foreground truncate max-w-[160px]" title={f.accountName || f.accountId}>
                    {f.accountName || f.accountId}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{f.resourceCount}</td>
                  <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{fmt$(f.cost)}</td>
                  <td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">
                    {fmt$(f.cost / Math.max(1, f.resourceCount))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// CloudWatch Logs
// ──────────────────────────────────────────────────────────────────────────
function CloudwatchLogsCard({ data }: { data: CurDeepInsights }) {
  const top = data.hiddenCosts.cloudwatchLogs.topGroups;
  if (top.length === 0) return null;
  return (
    <Card className="border-border/70">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Layers className="h-4 w-4" />
          CloudWatch Logs · top groups
        </CardTitle>
        <CardDescription>
          Total <strong>{fmt$(data.hiddenCosts.cloudwatchLogs.totalCost)}</strong> · revisar retención y filtros
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {top.slice(0, 10).map((g, i) => {
            const max = top[0].cost || 1;
            const widthPct = Math.max(5, (g.cost / max) * 100);
            const friendly = g.logGroup.split(":").slice(-1)[0] || g.logGroup;
            return (
              <div key={`${g.logGroup}-${i}`} className="flex items-center gap-2">
                <span className="text-[11px] font-mono w-64 truncate text-right" title={g.logGroup}>
                  {friendly.length > 36 ? `…${friendly.slice(friendly.length - 35)}` : friendly}
                </span>
                <div className="flex-1 h-5 bg-muted/30 rounded overflow-hidden relative">
                  <div className="h-full bg-gradient-to-r from-info/80 to-info/40" style={{ width: `${widthPct}%` }} />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold">
                    {fmt$(g.cost)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// NAT Gateway top consumers
// ──────────────────────────────────────────────────────────────────────────
function NatGatewayCard({ data }: { data: CurDeepInsights }) {
  const tops = data.hiddenCosts.natGateways.topConsumers;
  if (tops.length === 0) return null;
  return (
    <Card className="border-border/70">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Network className="h-4 w-4" />
          NAT Gateway · top consumidores
        </CardTitle>
        <CardDescription>
          Hours {fmt$(data.hiddenCosts.natGateways.hoursCost)} · Data processed {fmt$(data.hiddenCosts.natGateways.dataProcessedCost)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {tops.map((nat, i) => {
            const max = tops[0].cost || 1;
            const widthPct = Math.max(5, (nat.cost / max) * 100);
            const id = nat.resourceId.split("/").pop() || nat.resourceId;
            return (
              <div key={nat.resourceId + i} className="flex items-center gap-2">
                <span className="text-[11px] font-mono w-40 truncate text-right" title={nat.resourceId}>
                  {id}
                </span>
                <div className="flex-1 h-5 bg-muted/30 rounded overflow-hidden relative">
                  <div className="h-full bg-gradient-to-r from-amber-500/80 to-amber-500/40" style={{ width: `${widthPct}%` }} />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold">
                    {fmt$(nat.cost)}
                  </span>
                </div>
                <span className="text-[10px] text-muted-foreground w-16 text-right">{nat.account.slice(-6)}</span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// RDS Extended support
// ──────────────────────────────────────────────────────────────────────────
function ExtendedSupportCard({ data }: { data: CurDeepInsights }) {
  const ext = data.hiddenCosts.extendedSupport;
  const detail = data.hiddenCosts.extendedSupportDetail;
  if (ext.length === 0) return null;
  return (
    <Card className="border-danger/30 bg-danger/5">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 text-danger">
          <Lock className="h-4 w-4" />
          RDS Extended Support
        </CardTitle>
        <CardDescription>
          Pagamos a AWS por NO migrar bases de datos a versiones soportadas
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1.5">
          {ext.map((e, i) => (
            <div key={`${e.usageType}-${i}`} className="flex items-center justify-between rounded-lg border border-border/40 bg-card p-2.5">
              <div>
                <div className="text-sm font-semibold">{e.engine}</div>
                <div className="text-[11px] text-muted-foreground font-mono">{e.usageType}</div>
              </div>
              <div className="text-right">
                <div className="text-sm font-bold text-danger">{fmt$(e.monthlyCost)}</div>
                <div className="text-[10px] text-muted-foreground">/ mes</div>
              </div>
            </div>
          ))}
        </div>
        {detail.length > 0 && (
          <details className="mt-3 group">
            <summary className="cursor-pointer text-xs text-primary hover:underline list-none flex items-center gap-1">
              <ChevronDown className="h-3 w-3 group-open:rotate-180 transition-transform" />
              Ver {detail.length} bases de datos afectadas
            </summary>
            <div className="mt-2 max-h-60 overflow-y-auto space-y-1">
              {detail.slice(0, 30).map((r, i) => (
                <div key={`${r.resourceId}-${i}`} className="flex items-center justify-between rounded border border-border/30 bg-card/50 p-2 text-[11px]">
                  <div className="flex-1 min-w-0">
                    <div className="font-mono truncate" title={r.resourceId}>
                      {r.resourceId.split(":db:")[1] || r.resourceId.split("/").pop() || r.resourceId}
                    </div>
                    <div className="text-muted-foreground">{r.engine} · {r.account}</div>
                  </div>
                  <span className="font-semibold ml-2 whitespace-nowrap">{fmt$(r.cost)}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function Gp2MigrationCard({ data }: { data: CurDeepInsights }) {
  const detail = data.hiddenCosts.gp2Detail;
  if (detail.length === 0) return null;
  const totalGb = detail.reduce((s, d) => s + d.gbMonth, 0);
  const totalCost = detail.reduce((s, d) => s + d.cost, 0);
  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2 text-warning">
              <HardDrive className="h-4 w-4" />
              Volúmenes EBS gp2 — plan de migración a gp3
            </CardTitle>
            <CardDescription>
              {detail.length} volúmenes · {Math.round(totalGb).toLocaleString()} GB-mes · {fmt$(totalCost)}/mes
            </CardDescription>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-success">{fmtK(totalCost * 0.2)}</div>
            <div className="text-[10px] uppercase text-muted-foreground">ahorro est. /mes</div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto max-h-72 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border/50 text-muted-foreground">
                <th className="px-2 py-1.5 text-left">Volume ID</th>
                <th className="px-2 py-1.5 text-left">Cuenta</th>
                <th className="px-2 py-1.5 text-right">GB-mes</th>
                <th className="px-2 py-1.5 text-right">Coste actual</th>
                <th className="px-2 py-1.5 text-right">Ahorro a gp3</th>
              </tr>
            </thead>
            <tbody>
              {detail.slice(0, 30).map((v, i) => (
                <tr key={`${v.resourceId}-${i}`} className="border-b border-border/30 hover:bg-muted/20">
                  <td className="px-2 py-1.5 font-mono text-[11px] truncate max-w-[200px]" title={v.resourceId}>
                    {v.resourceId.split("/").pop() || v.resourceId}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">{v.account}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{v.gbMonth.toLocaleString()}</td>
                  <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{fmt$(v.cost)}</td>
                  <td className="px-2 py-1.5 text-right text-success font-semibold tabular-nums">{fmt$(v.cost * 0.2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Comando: <code className="text-[10px] bg-muted px-1 rounded">aws ec2 modify-volume --volume-id &lt;id&gt; --volume-type gp3</code> (sin downtime)
        </p>
      </CardContent>
    </Card>
  );
}

function TagComplianceCard({ data }: { data: CurDeepInsights }) {
  if (!data.tagCompliance) return null;
  return (
    <Card className="border-border/70">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Database className="h-4 w-4" />
          Tagging Compliance · 3 tags obligatorios
        </CardTitle>
        <CardDescription>
          Cobertura por tag. Tag bajo cobertura → alocación de coste por equipo no es fiable.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-3">
          {data.tagCompliance.map((tc) => {
            const sevCls = tc.coveragePct > 60 ? "bg-success/10 border-success/30" : tc.coveragePct > 30 ? "bg-warning/10 border-warning/30" : "bg-danger/10 border-danger/30";
            const txtCls = tc.coveragePct > 60 ? "text-success" : tc.coveragePct > 30 ? "text-warning" : "text-danger";
            return (
              <div key={tc.tagKey} className={cn("rounded-xl border p-4", sevCls)}>
                <div className="flex items-baseline justify-between mb-2">
                  <code className="text-[11px] font-mono">{tc.tagKey}</code>
                  <span className={cn("text-2xl font-bold", txtCls)}>{tc.coveragePct.toFixed(1)}%</span>
                </div>
                <div className="h-2 bg-muted/40 rounded-full overflow-hidden mb-3">
                  <div className={cn("h-full rounded-full", tc.coveragePct > 60 ? "bg-success" : tc.coveragePct > 30 ? "bg-warning" : "bg-danger")} style={{ width: `${tc.coveragePct}%` }} />
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div>
                    <div className="text-muted-foreground">Tagged</div>
                    <div className="font-bold">{fmt$(tc.taggedCost)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Untagged</div>
                    <div className="font-bold">{fmt$(tc.untaggedCost)}</div>
                  </div>
                </div>
                <div className="mt-2 text-[10px] text-muted-foreground">
                  {tc.distinctValues} valores distintos
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
