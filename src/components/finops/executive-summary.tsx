"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  AreaChart,
  Area,
} from "recharts";
import { AlertTriangle, DollarSign, PiggyBank, Shield, TrendingDown, Zap } from "lucide-react";
import { MiniStat } from "@/components/metrics/shared";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { ExecutiveFinOpsData } from "@/types/finops";

const PIE_COLORS = [
  "hsl(var(--primary))",
  "hsl(var(--info))",
  "hsl(var(--success))",
  "hsl(var(--warning))",
  "hsl(210 15% 60%)",
  "hsl(var(--danger))",
];

const ENV_COLORS = [
  "hsl(var(--danger))",    // Production — red (most important)
  "hsl(var(--info))",      // Development — blue
  "hsl(var(--warning))",   // UAT — yellow
  "hsl(var(--success))",   // Tooling — green
  "hsl(210 15% 65%)",     // Sandbox — gray
  "hsl(280 40% 55%)",     // Management — purple
  "hsl(180 40% 50%)",     // Other — teal
];

function fmt(value: number) {
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${value.toFixed(0)}`;
}

function fmtFull(value: number) {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(value: number) {
  return `${value.toFixed(1)}%`;
}

export function FinOpsExecutiveSummary({ data }: { data: ExecutiveFinOpsData }) {
  const { netCost, pricingModel, savingsPlansDetail, dailyCosts, anomalies, topResources } = data;
  const [resourceSearch, setResourceSearch] = useState("");
  const [resourceServiceFilter, setResourceServiceFilter] = useState("all");
  const { t } = useI18n();

  // Pricing model pie data (only positive cost items)
  const pieData = pricingModel.breakdown
    .filter((m) => m.cost > 0 && !["Discount", "Tax"].includes(m.model))
    .map((m) => ({ name: m.model, value: Math.round(m.cost) }));

  return (
    <div className="space-y-6">
      {/* Row 1: Financial KPIs */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="relative overflow-hidden border-none bg-gradient-to-br from-primary to-primary/80 text-white shadow-lg">
          <CardContent className="p-5 space-y-2">
            <div className="flex items-center gap-2 text-xs opacity-80 uppercase tracking-wider">
              <DollarSign className="h-4 w-4" /> {t("finops.exec.costAws")}
            </div>
            <div className="text-3xl font-bold tracking-tight">{fmtFull(netCost.grossCost)}</div>
            {netCost.netCostAvailable && (
              <div className="text-sm opacity-90">
                {t("finops.exec.netReal")}: {fmtFull(netCost.netCost)}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden border-none bg-gradient-to-br from-success to-success/80 text-white shadow-lg">
          <CardContent className="p-5 space-y-2">
            <div className="flex items-center gap-2 text-xs opacity-80 uppercase tracking-wider">
              <PiggyBank className="h-4 w-4" /> {t("finops.exec.totalSavings")}
            </div>
            <div className="text-3xl font-bold tracking-tight">{fmtFull(netCost.realSavings)}</div>
            <div className="text-sm opacity-90">
              {pct(netCost.effectiveDiscountPct)} {t("finops.exec.vsOnDemand")}
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden border-none bg-gradient-to-br from-info to-info/80 text-white shadow-lg">
          <CardContent className="p-5 space-y-2">
            <div className="flex items-center gap-2 text-xs opacity-80 uppercase tracking-wider">
              <Shield className="h-4 w-4" /> {t("finops.exec.commitmentCoverage")}
            </div>
            <div className="text-3xl font-bold tracking-tight">
              {pct(pricingModel.orgCoverage?.coveragePct ?? pricingModel.commitmentCoverage)}
            </div>
            <div className="text-sm opacity-90">
              {t("finops.exec.spRiOnUsage")}
            </div>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden border-none bg-gradient-to-br from-warning to-warning/80 text-white shadow-lg">
          <CardContent className="p-5 space-y-2">
            <div className="flex items-center gap-2 text-xs opacity-80 uppercase tracking-wider">
              <Zap className="h-4 w-4" /> {t("finops.exec.onDemandExposed")}
            </div>
            <div className="text-3xl font-bold tracking-tight">
              {pct(pricingModel.orgCoverage?.onDemandExposedPct ?? pricingModel.onDemandPct)}
            </div>
            <div className="text-sm opacity-90">
              {fmtFull(pricingModel.onDemandCost)} {t("finops.exec.noCommitment")}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Row 2: Discount breakdown + Pricing model */}
      <div className="grid gap-4 xl:grid-cols-2">
        {/* Discount waterfall */}
        <Card className="border-border/70">
          <CardHeader>
            <CardTitle className="text-lg">{t("finops.exec.discountBreakdown")}</CardTitle>
            <CardDescription>{t("finops.exec.discountBreakdownDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2">
              <WaterfallRow label={t("finops.exec.onDemandEquiv")} value={netCost.onDemandEquivalent} tone="muted" />
              <WaterfallRow label={t("finops.exec.savingsPlans")} value={-savingsPlansDetail.savingsAmount} tone="success" />
              <WaterfallRow label={t("finops.exec.sppDiscount")} value={netCost.sppDiscount} tone="success" />
              <WaterfallRow label={t("finops.exec.creditsApplied")} value={netCost.creditsApplied} tone="success" />
              <WaterfallRow label={t("finops.exec.bundledDiscount")} value={netCost.bundledDiscount} tone="success" />
              <div className="border-t border-border/50 pt-2">
                <WaterfallRow label={t("finops.exec.realCostCur")} value={netCost.grossCost} tone="primary" bold />
              </div>
              {netCost.netCostAvailable && (
                <WaterfallRow label={t("finops.exec.netCostPostPartner")} value={netCost.netCost} tone="info" bold />
              )}
            </div>
          </CardContent>
        </Card>

        {/* Pricing model pie */}
        <Card className="border-border/70">
          <CardHeader>
            <CardTitle className="text-lg">{t("finops.exec.pricingModel")}</CardTitle>
            <CardDescription>{t("finops.exec.pricingModelDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-6">
              <ResponsiveContainer width="50%" height={200}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {pieData.map((_, idx) => (
                      <Cell key={idx} fill={PIE_COLORS[idx % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: any) => fmtFull(v)} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex-1 space-y-2">
                {pieData.map((entry, idx) => (
                  <div key={entry.name} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-3 w-3 rounded-full"
                        style={{ backgroundColor: PIE_COLORS[idx % PIE_COLORS.length] }}
                      />
                      <span className="text-muted-foreground">{entry.name}</span>
                    </div>
                    <span className="font-medium">{fmtFull(entry.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Row 3: Daily cost trend with anomalies */}
      {dailyCosts.length > 0 && (
        <Card className="border-border/70">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">{t("finops.exec.dailyCost")}</CardTitle>
                <CardDescription>{t("finops.exec.dailyCostDesc")}</CardDescription>
              </div>
              {anomalies.flaggedDays.length > 0 && (
                <Badge className="bg-warning/12 text-warning border-warning/25">
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  {anomalies.flaggedDays.length} anomalía{anomalies.flaggedDays.length > 1 ? "s" : ""}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={dailyCosts}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => fmt(v)} />
                <Tooltip formatter={(v: any) => fmtFull(v)} />
                <Area
                  type="monotone"
                  dataKey="cost"
                  stroke="hsl(var(--primary))"
                  fill="hsl(var(--primary) / 0.15)"
                  strokeWidth={2}
                  name={t("finops.exec.grossCost")}
                />
                {netCost.netCostAvailable && (
                  <Area
                    type="monotone"
                    dataKey="netCost"
                    stroke="hsl(var(--info))"
                    fill="hsl(var(--info) / 0.08)"
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    name={t("finops.exec.netCostPostPartner")}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
            {anomalies.flaggedDays.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border/40 space-y-1">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {t("finops.exec.anomalyDays")} ({">"}{fmtFull(anomalies.threshold)})
                </div>
                <div className="flex flex-wrap gap-2">
                  {anomalies.flaggedDays.map((a) => (
                    <Badge key={a.day} className="bg-warning/10 text-warning border-warning/20">
                      {a.day}: {fmtFull(a.cost)} ({a.deviation.toFixed(1)}σ)
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Row 4: Environment breakdown */}
      {(data as any).environmentBreakdown?.length > 0 && (
        <Card className="border-border/70">
          <CardHeader>
            <CardTitle className="text-lg">{t("finops.exec.costByEnv")}</CardTitle>
            <CardDescription>{t("finops.exec.costByEnvDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-6">
              <ResponsiveContainer width="45%" height={180}>
                <PieChart>
                  <Pie
                    data={(data as any).environmentBreakdown.map((e: any) => ({ name: e.environment, value: Math.round(e.cost) }))}
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={70}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {(data as any).environmentBreakdown.map((_: any, idx: number) => (
                      <Cell key={idx} fill={ENV_COLORS[idx % ENV_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: any) => fmtFull(v)} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex-1 space-y-2">
                {(data as any).environmentBreakdown.map((env: any, idx: number) => (
                  <div key={env.environment} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-3 w-3 rounded-full"
                        style={{ backgroundColor: ENV_COLORS[idx % ENV_COLORS.length] }}
                      />
                      <span className="text-muted-foreground">{env.environment}</span>
                      <span className="text-[10px] text-muted-foreground/60">({env.accounts} {t("finops.exec.accounts")})</span>
                    </div>
                    <div className="text-right">
                      <span className="font-medium">{fmtFull(env.cost)}</span>
                      <span className="text-xs text-muted-foreground ml-1">({env.pct}%)</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Row 5: Savings Plans detail + Top resources */}
      <div className="grid gap-4 xl:grid-cols-2">
        {/* SP detail */}
        {savingsPlansDetail.plans.length > 0 && (
          <Card className="border-border/70">
            <CardHeader>
              <CardTitle className="text-lg">{t("finops.exec.spDetail")}</CardTitle>
              <CardDescription>
                {t("finops.exec.spSavings")}: {fmtFull(savingsPlansDetail.savingsAmount)} ({pct(savingsPlansDetail.savingsPct)} {t("finops.exec.vsOnDemand")})
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {savingsPlansDetail.plans.map((sp, idx) => (
                <div key={idx} className="rounded-xl border border-border/50 bg-background/80 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">{sp.type}</div>
                    <Badge variant="outline">{sp.paymentOption}</Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <div className="text-muted-foreground">{t("finops.exec.effectiveCost")}</div>
                      <div className="font-semibold">{fmtFull(sp.effectiveCost)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">{t("finops.exec.onDemandEquivShort")}</div>
                      <div className="font-semibold">{fmtFull(sp.onDemandEquivalent)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">{t("finops.exec.accountsCovered")}</div>
                      <div className="font-semibold">{sp.accountsCovered}</div>
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Top resources — searchable and filterable */}
        <Card className="border-border/70">
          <CardHeader>
            <CardTitle className="text-lg">{t("finops.exec.resourceExplorer")}</CardTitle>
            <CardDescription>{t("finops.exec.resourceExplorerDesc")}</CardDescription>
            <div className="mt-2 grid gap-2 md:grid-cols-[180px_1fr]">
              <select
                value={resourceServiceFilter}
                onChange={(e) => setResourceServiceFilter(e.target.value)}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="all">{t("finops.exec.allServices")}</option>
                {[...new Set(topResources.map((r) => r.service))].sort().map((svc) => (
                  <option key={svc} value={svc}>{svc} ({topResources.filter((r) => r.service === svc).length})</option>
                ))}
              </select>
              <input
                type="text"
                placeholder={t("finops.exec.searchPlaceholder")}
                value={resourceSearch}
                onChange={(e) => setResourceSearch(e.target.value)}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-[500px] overflow-y-auto">
              {(() => {
                const q = resourceSearch.toLowerCase().trim();
                let filtered = topResources;
                
                if (resourceServiceFilter !== "all") {
                  filtered = filtered.filter((r) => r.service === resourceServiceFilter);
                }
                
                if (q) {
                  filtered = filtered.filter((r) =>
                    r.resourceId.toLowerCase().includes(q) ||
                    r.accountName.toLowerCase().includes(q) ||
                    (r.instanceType || "").toLowerCase().includes(q) ||
                    (r.region || "").toLowerCase().includes(q) ||
                    (r.usageType || "").toLowerCase().includes(q)
                  );
                }
                
                if (filtered.length === 0) {
                  return <div className="py-4 text-center text-sm text-muted-foreground">{t("finops.exec.noResults")}{resourceSearch ? ` "${resourceSearch}"` : ""}</div>;
                }

                const totalFilteredCost = filtered.reduce((sum, r) => sum + r.cost, 0);

                return (
                  <>
                    <div className="flex items-center justify-between text-xs text-muted-foreground pb-2 border-b border-border/40">
                      <span>{filtered.length} {t("finops.exec.resources")}</span>
                      <span className="font-semibold">${totalFilteredCost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    {filtered.map((r, idx) => (
                <div key={idx} className="rounded-xl border border-border/50 bg-background/80 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate" title={r.resourceId}>
                        {r.resourceId.length > 50 ? `...${r.resourceId.slice(-45)}` : r.resourceId}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {r.accountName} · {r.service}
                        {r.instanceType && ` · ${r.instanceType}`}
                        {r.region && ` · ${r.region}`}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-semibold">{fmtFull(r.cost)}</div>
                      {r.onDemandCost > r.cost && (
                        <div className="text-[10px] text-success">
                          <TrendingDown className="h-3 w-3 inline" /> {pct(((r.onDemandCost - r.cost) / r.onDemandCost) * 100)} {t("finops.exec.savings")}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
                  </>
                );
              })()}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function WaterfallRow({
  label,
  value,
  tone,
  bold = false,
}: {
  label: string;
  value: number;
  tone: "muted" | "success" | "primary" | "info";
  bold?: boolean;
}) {
  const toneClass = {
    muted: "text-muted-foreground",
    success: "text-success",
    primary: "text-primary",
    info: "text-info",
  }[tone];

  return (
    <div className={cn("flex items-center justify-between py-1", bold && "font-semibold")}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={cn("text-sm tabular-nums", toneClass)}>
        {value < 0 ? `-${fmtFull(Math.abs(value))}` : fmtFull(value)}
      </span>
    </div>
  );
}
