"use client";

import { useState } from "react";
import { Loader2, DollarSign, TrendingUp, TrendingDown, Building2, Calendar, Database, ChevronDown, ChevronRight, Search, BarChart2, AlertTriangle, Wrench, Boxes, PieChart as PieChartIcon, Sparkles, Receipt, Tags } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ResponsiveContainer, PieChart, Pie, Cell, AreaChart, Area, BarChart, Bar,
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { AccountMultiSelect } from "./AccountMultiSelect";
import { TrendIndicator } from "./TrendIndicator";
import { ExcelExportButton } from "./ExcelExportButton";
import { MonthlyCostTrendChart } from "./MonthlyCostTrendChart";
import { ForecastPanel } from "./forecast-panel";
import { CurDeepInsights, BedrockCard } from "@/components/finops/cur-deep-insights";
import { ComparisonExplorerDialog } from "@/components/finops/comparison-explorer";
import { CostMoversCard } from "@/components/finops/cost-movers-card";
import { AnomalyTimelineCard } from "@/components/finops/anomaly-timeline-card";
import { AwsRightsizingCard } from "@/components/finops/aws-rightsizing-card";
import { KiroLicensesCard } from "@/components/finops/kiro-licenses-card";
import { AiCostHistoryCard } from "@/components/finops/ai-cost-history-card";
import { FinOpsSection } from "@/components/finops/finops-section";
import { useAwsAccounts } from "@/hooks/use-aws-accounts";
import type { AthenaFinOpsResponse, AccountSummary } from "@/types/finops";
import { formatAwsServiceName } from "@/lib/finops-format";
import { useI18n } from "@/lib/i18n";

const PIE_COLORS = ["hsl(var(--primary))", "hsl(var(--info))", "hsl(var(--success))", "hsl(var(--warning))", "hsl(210 15% 60%)", "hsl(var(--danger))"];
const ENV_COLORS = ["hsl(var(--danger))", "hsl(var(--info))", "hsl(var(--warning))", "hsl(var(--success))", "hsl(210 15% 65%)", "hsl(280 40% 55%)"];

function fmt$(v: number) { return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function fmtK(v: number) { return Math.abs(v) >= 1000 ? `$${(v/1000).toFixed(1)}k` : `$${v.toFixed(0)}`; }
function pct(v: number) { return `${v.toFixed(1)}%`; }

const getFirstOfMonth = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-01`; };
const getToday = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`; };

export function CostsDashboard() {
  const { accounts: availableAccounts, loading: accountsLoading } = useAwsAccounts();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<AthenaFinOpsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [startDate, setStartDate] = useState(getFirstOfMonth());
  const [endDate, setEndDate] = useState(getToday());
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());
  const [expandedServices, setExpandedServices] = useState<Set<string>>(new Set());
  const [serviceLimits, setServiceLimits] = useState<Map<string, number>>(new Map());
  const [comparisonOpen, setComparisonOpen] = useState(false);

  const exec = (data as any)?.executive;
  const resourceCosts: any[] = (data as any)?.resourceCosts || [];
  const { t } = useI18n();

  // New: tag-based insights from direct CUR query
  const [tagData, setTagData] = useState<any>(null);

  const fetchData = async () => {
    if (selectedAccountIds.length === 0) { setError(t("finops.selectAccount")); return; }
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      params.append("accountIds", selectedAccountIds.join(","));
      params.append("startDate", startDate);
      params.append("endDate", endDate);
      params.append("includeTrends", "true");
      params.append("includeResourceCosts", "true");

      // Fetch both in parallel: Lambda (main data) + CUR direct (tag insights)
      const [mainRes, tagRes] = await Promise.all([
        fetch(`/api/finops/athena?${params.toString()}`),
        fetch(`/api/finops/cur-direct?accountIds=${selectedAccountIds.join(",")}&startDate=${startDate}&endDate=${endDate}`).catch(() => null),
      ]);

      if (!mainRes.ok) throw new Error(t("costs.athenaError"));
      setData(await mainRes.json());

      if (tagRes?.ok) {
        setTagData(await tagRes.json());
      }

      setLastFetched(new Date());
    } catch (err) { setError(t("finops.errorLoading")); console.error(err); }
    finally { setLoading(false); }
  };

  const toggleAccount = (id: string) => {
    const s = new Set(expandedAccounts);
    s.has(id) ? s.delete(id) : s.add(id);
    setExpandedAccounts(s);
  };
  const toggleService = (key: string) => {
    const s = new Set(expandedServices);
    s.has(key) ? s.delete(key) : s.add(key);
    setExpandedServices(s);
  };
  const getServiceResources = (accountId: string, service: string) =>
    resourceCosts.filter((r) => r.accountId === accountId && r.service === service).sort((a: any, b: any) => b.cost - a.cost);

  const q = searchTerm.toLowerCase().trim();
  const filteredAccounts = (data?.accounts || []).filter((a) =>
    !q || a.accountName.toLowerCase().includes(q) || a.accountId.includes(q) ||
    a.services.some((s) => formatAwsServiceName(s.name).toLowerCase().includes(q))
  );

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="sticky top-0 z-10 rounded-2xl border bg-background/80 shadow-lg backdrop-blur-xl p-3">
        <div className="flex flex-col lg:flex-row gap-2">
          <div className="flex flex-1 items-center gap-2 bg-muted/40 p-2 rounded-xl">
            <Calendar className="w-4 h-4 text-muted-foreground" />
            <div className="flex flex-1 items-center gap-2">
              <div className="grid gap-0.5 flex-1">
                <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">{t("common.from")}</label>
                <input type="date" className="bg-transparent border-none p-0 text-sm font-semibold focus:ring-0 w-full" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <span className="text-muted-foreground/50">→</span>
              <div className="grid gap-0.5 flex-1">
                <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">{t("common.to")}</label>
                <input type="date" className="bg-transparent border-none p-0 text-sm font-semibold focus:ring-0 w-full" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            </div>
          </div>
          <div className="flex-[2] flex items-center gap-2 bg-muted/40 p-2 rounded-xl">
            <Building2 className="w-4 h-4 text-muted-foreground" />
            <div className="grid gap-0.5 flex-1">
              <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">{t("common.accounts")}</label>
              <AccountMultiSelect accounts={availableAccounts} selectedIds={selectedAccountIds} onChange={setSelectedAccountIds} placeholder={accountsLoading ? t("finops.loadingAccounts") : t("finops.selectAccounts")} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="lg" onClick={fetchData} disabled={loading || selectedAccountIds.length === 0} className="h-auto px-6 rounded-xl bg-gradient-to-r from-primary to-info hover:from-primary/90 hover:to-info/90 shadow-md">
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <><Database className="mr-2 h-4 w-4" />{t("common.analyze")}</>}
            </Button>
            <Button size="lg" variant="outline" onClick={() => setComparisonOpen(true)} className="h-auto px-6 rounded-xl">
              <BarChart2 className="mr-2 h-4 w-4" />Comparar meses
            </Button>
            {lastFetched && <span className="text-[10px] text-muted-foreground/60">{lastFetched.toLocaleTimeString()}</span>}
          </div>
        </div>
      </div>

      {error && <div className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div>}

      {!data && !loading && !error && (
        <div className="h-[300px] flex flex-col items-center justify-center text-center">
          <DollarSign className="w-12 h-12 text-primary/40 mb-4" />
          <h3 className="text-xl font-bold">{t("finops.readyTitle")}</h3>
          <p className="text-muted-foreground mt-1">{t("finops.readyDescription")}</p>
        </div>
      )}

      {data && (
        <div className="space-y-3 animate-in fade-in duration-300">

          {/* Row 1: Executive KPIs (always visible) */}
          {exec && (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <Card className="border-none bg-gradient-to-br from-primary to-primary/80 text-white shadow-lg">
                <CardContent className="p-5 space-y-1">
                  <div className="text-xs opacity-80 uppercase tracking-wider flex items-center gap-1"><DollarSign className="h-3.5 w-3.5" /> {t("finops.costAws")}</div>
                  <div className="text-3xl font-bold">{fmt$(exec.netCost.grossCost)}</div>
                  {data.summary.trend && <TrendIndicator trend={data.summary.trend} size="sm" className="text-white" />}
                </CardContent>
              </Card>
              <Card className="border-none bg-gradient-to-br from-success to-success/80 text-white shadow-lg">
                <CardContent className="p-5 space-y-1">
                  <div className="text-xs opacity-80 uppercase tracking-wider">{t("finops.savingsVsOnDemand")}</div>
                  <div className="text-3xl font-bold">{fmt$(exec.netCost.realSavings)}</div>
                  <div className="text-sm opacity-90">{pct(exec.netCost.effectiveDiscountPct)}</div>
                </CardContent>
              </Card>
              <Card className="border-none bg-gradient-to-br from-info to-info/80 text-white shadow-lg">
                <CardContent className="p-5 space-y-1">
                  <div className="text-xs opacity-80 uppercase tracking-wider">{t("finops.spCoverage")}</div>
                  <div className="text-3xl font-bold">{pct(exec.pricingModel.orgCoverage?.coveragePct ?? exec.pricingModel.commitmentCoverage)}</div>
                </CardContent>
              </Card>
              <Card className="border-none bg-gradient-to-br from-warning to-warning/80 text-white shadow-lg">
                <CardContent className="p-5 space-y-1">
                  <div className="text-xs opacity-80 uppercase tracking-wider">{t("finops.onDemandExposed")}</div>
                  <div className="text-3xl font-bold">{pct(exec.pricingModel.orgCoverage?.onDemandExposedPct ?? exec.pricingModel.onDemandPct)}</div>
                  <div className="text-sm opacity-90">{fmt$(exec.pricingModel.onDemandCost)}</div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* SECTION 1: Coste neto y descuentos */}
          {tagData && (
            <FinOpsSection
              title="Coste neto y descuentos"
              description="Waterfall completo: gross AWS, marketplace separado, descuentos reales (SP, SPP, créditos)"
              icon={<Receipt className="h-4 w-4" />}
              defaultOpen
            >
              {/* Waterfall + Pricing model + Environment */}
              {exec && (
                <div className="grid gap-4 xl:grid-cols-3">
                  <Card className="border-border/70">
                    <CardHeader className="pb-2"><CardTitle className="text-base">{t("finops.discountBreakdown")}</CardTitle></CardHeader>
                    <CardContent className="space-y-1 text-sm">
                      <div className="flex justify-between py-1 text-muted-foreground"><span>{t("costs.waterfall.onDemandEquiv")}</span><span>{fmt$(exec.netCost.onDemandEquivalent)}</span></div>
                      <div className="flex justify-between py-1 text-success"><span>{t("costs.waterfall.savingsPlans")}</span><span>-{fmt$(exec.savingsPlansDetail.savingsAmount)}</span></div>
                      <div className="flex justify-between py-1 text-success"><span>{t("costs.waterfall.spp")}</span><span>{fmt$(exec.netCost.sppDiscount)}</span></div>
                      <div className="flex justify-between py-1 text-success"><span>{t("costs.waterfall.credits")}</span><span>{fmt$(exec.netCost.creditsApplied)}</span></div>
                      <div className="border-t pt-1 flex justify-between font-semibold text-primary"><span>{t("costs.waterfall.realCost")}</span><span>{fmt$(exec.netCost.grossCost)}</span></div>
                    </CardContent>
                  </Card>
                  <Card className="border-border/70">
                    <CardHeader className="pb-2"><CardTitle className="text-base">{t("finops.pricingModel")}</CardTitle></CardHeader>
                    <CardContent>
                      <div className="flex items-center gap-4">
                        <ResponsiveContainer width="45%" height={150}>
                          <PieChart>
                            <Pie data={exec.pricingModel.breakdown.filter((m: any) => m.cost > 0 && !["Discount","Tax"].includes(m.model)).map((m: any) => ({ name: m.model, value: Math.round(m.cost) }))} cx="50%" cy="50%" innerRadius={35} outerRadius={60} paddingAngle={2} dataKey="value">
                              {exec.pricingModel.breakdown.filter((m: any) => m.cost > 0).map((_: any, i: number) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                            </Pie>
                            <Tooltip formatter={(v: any) => fmt$(v)} />
                          </PieChart>
                        </ResponsiveContainer>
                        <div className="flex-1 space-y-1 text-xs">
                          {exec.pricingModel.breakdown.filter((m: any) => m.cost > 0 && !["Discount","Tax"].includes(m.model)).map((m: any, i: number) => (
                            <div key={m.model} className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} /><span className="text-muted-foreground">{m.model}</span></div>
                              <span className="font-medium">{fmt$(m.cost)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  {exec.environmentBreakdown?.length > 0 && (
                    <Card className="border-border/70">
                      <CardHeader className="pb-2"><CardTitle className="text-base">{t("finops.costByEnvironment")}</CardTitle></CardHeader>
                      <CardContent className="space-y-2 text-sm">
                        {exec.environmentBreakdown.map((env: any, i: number) => (
                          <div key={env.environment} className="flex items-center justify-between">
                            <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ENV_COLORS[i % ENV_COLORS.length] }} /><span className="text-muted-foreground">{env.environment}</span><span className="text-[10px] text-muted-foreground/50">({env.accounts})</span></div>
                            <div><span className="font-medium">{fmt$(env.cost)}</span><span className="text-xs text-muted-foreground ml-1">({env.pct}%)</span></div>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}
                </div>
              )}
            </FinOpsSection>
          )}

          {/* SECTION 2: Tendencias y forecast (scoped to selected accounts) */}
          <FinOpsSection
            title="Tendencias y proyección"
            description="Coste diario, evolución mensual y proyección para las cuentas seleccionadas"
            icon={<BarChart2 className="h-4 w-4" />}
          >
            <div className="grid gap-4 xl:grid-cols-2">
              {exec?.dailyCosts?.length > 0 && (
                <Card className="border-border/70">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">{t("finops.dailyCost")}</CardTitle>
                      {exec.anomalies?.flaggedDays?.length > 0 && <Badge className="bg-warning/12 text-warning border-warning/25 text-[10px]">{exec.anomalies.flaggedDays.length} anomalía(s)</Badge>}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={exec.dailyCosts}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtK} />
                        <Tooltip formatter={(v: any) => fmt$(v)} />
                        <Area type="monotone" dataKey="cost" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.15)" strokeWidth={2} name={t("costs.costName")} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              )}
              {data.monthlyTrend && data.monthlyTrend.length > 0 && (
                <MonthlyCostTrendChart points={data.monthlyTrend} />
              )}
            </div>
            <ForecastPanel accountIds={selectedAccountIds} />
          </FinOpsSection>

          {/* SECTION 3: Anomalías y top movers */}
          {((data.topMovers && (data.topMovers.increases.length > 0 || data.topMovers.decreases.length > 0)) ||
            (tagData?.anomalyAttribution && tagData.anomalyAttribution.length > 0)) && (
            <FinOpsSection
              title="Anomalías y top movers"
              description="Días con coste anómalo y servicios que más han subido o bajado vs periodo anterior"
              icon={<AlertTriangle className="h-4 w-4 text-warning" />}
              badge={tagData?.anomalyAttribution?.length > 0 ? <Badge variant="outline" className="border-danger/40 text-danger text-[10px]">{tagData.anomalyAttribution.length} día{tagData.anomalyAttribution.length > 1 ? "s" : ""}</Badge> : null}
            >
              {tagData?.anomalyAttribution && tagData.anomalyAttribution.length > 0 && (
                <AnomalyTimelineCard anomalies={tagData.anomalyAttribution} dailyCosts={exec?.dailyCosts || []} />
              )}
              {data.topMovers && (data.topMovers.increases.length > 0 || data.topMovers.decreases.length > 0) && (
                <CostMoversCard topMovers={data.topMovers} />
              )}
            </FinOpsSection>
          )}

          {/* SECTION 4: Optimización (rightsizing oficial AWS + insights deep CUR) */}
          <FinOpsSection
            title="Optimización y costes ocultos"
            description="Recomendaciones AWS y quick wins detectados desde el CUR"
            icon={<Wrench className="h-4 w-4 text-success" />}
            defaultOpen
          >
            <AwsRightsizingCard selectedAccountIds={selectedAccountIds} />
            {tagData && <CurDeepInsights data={tagData} selectedAccountIds={selectedAccountIds} />}
          </FinOpsSection>

          {/* SECTION 5: Allocation por dominio/equipo y tags */}
          {tagData && (tagData.byDomain?.length > 0 || tagData.tagCoverage) && (
            <FinOpsSection
              title="Allocation por dominio / equipo"
              description="Coste por user_domain, user_environment y cobertura de tagging"
              icon={<Tags className="h-4 w-4" />}
            >
              <div className="grid gap-4 xl:grid-cols-3">
                {tagData.byDomain?.length > 0 && (
                  <Card className="border-border/70 xl:col-span-2">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base">Coste por dominio</CardTitle>
                      <CardDescription>Tag <code className="text-[10px] bg-muted px-1 rounded">user_domain</code></CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-1.5">
                        {tagData.byDomain.slice(0, 15).map((d: any) => {
                          const maxCost = tagData.byDomain[0]?.cost || 1;
                          const widthPct = Math.max(5, (d.cost / maxCost) * 100);
                          return (
                            <div key={d.domain} className="flex items-center gap-3">
                              <span className="text-xs font-medium w-32 truncate text-right">{d.domain}</span>
                              <div className="flex-1 h-6 bg-muted/30 rounded-md overflow-hidden relative">
                                <div className="h-full rounded-md bg-gradient-to-r from-primary/80 to-primary/40" style={{ width: `${widthPct}%` }} />
                                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold">{fmt$(d.cost)}</span>
                              </div>
                              <span className="text-[10px] text-muted-foreground w-16 text-right">{d.resources} rec.</span>
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                )}
                <div className="space-y-3 flex flex-col">
                  {tagData.byEnvironment?.length > 0 && (
                    <Card className="border-border/70">
                      <CardHeader className="pb-2"><CardTitle className="text-base">Coste por entorno</CardTitle></CardHeader>
                      <CardContent className="space-y-1.5">
                        {tagData.byEnvironment.map((env: any, i: number) => (
                          <div key={env.environment} className="flex items-center justify-between py-1">
                            <div className="flex items-center gap-2">
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ENV_COLORS[i % ENV_COLORS.length] }} />
                              <span className="text-sm font-medium">{env.environment}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold">{fmt$(env.cost)}</span>
                              <span className="text-[10px] text-muted-foreground">({env.resources} rec.)</span>
                            </div>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}
                  {tagData.spDetails?.length > 0 && (
                    <Card className="border-border/70 flex-1">
                      <CardHeader className="pb-2"><CardTitle className="text-base">Savings Plans activos</CardTitle></CardHeader>
                      <CardContent className="space-y-2 text-xs">
                        {tagData.spDetails.map((sp: any) => (
                          <div key={sp.arn} className="rounded-lg border border-border/50 p-2.5 space-y-1">
                            <div className="flex items-center justify-between">
                              <Badge variant="outline" className="text-[10px]">{sp.type}</Badge>
                              <span className="font-bold text-success">{sp.savingsPct}% ahorro</span>
                            </div>
                            <div className="flex justify-between text-muted-foreground"><span>Coste efectivo:</span><span className="font-medium text-foreground">{fmt$(sp.effectiveCost)}</span></div>
                            <div className="flex justify-between text-muted-foreground"><span>Expira:</span><span className="font-medium text-foreground">{sp.endTime ? new Date(sp.endTime).toLocaleDateString("es-ES") : "N/A"}</span></div>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}
                </div>
              </div>
            </FinOpsSection>
          )}

          {/* SECTION 6: Costes de IA (Bedrock + Kiro) */}
          <FinOpsSection
            title="Costes de IA"
            description="Bedrock por modelo y licencias Kiro por usuario"
            icon={<Sparkles className="h-4 w-4 text-violet-500" />}
          >
            <AiCostHistoryCard data={tagData?.aiCostDaily} />
            {tagData?.hiddenCosts?.bedrock && tagData.hiddenCosts.bedrock.byModel.length > 0 && (
              <BedrockCard data={tagData} />
            )}
            <KiroLicensesCard accountIds={selectedAccountIds} />
          </FinOpsSection>

          {/* SECTION 7: Drill-down por cuenta y servicio */}
          <FinOpsSection
            title="Drill-down por cuenta y servicio"
            description="Explora cuenta → servicio → recurso individual"
            icon={<Boxes className="h-4 w-4" />}
          >
            <Card className="border-border/70">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">{t("finops.accountBreakdown")}</CardTitle>
                    <CardDescription>{t("finops.accountBreakdownDesc")}</CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <input type="text" placeholder={t("costs.searchPlaceholder")} value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="rounded-md border border-border bg-background py-1.5 pl-8 pr-3 text-xs w-48 focus:outline-none focus:ring-1 focus:ring-ring" />
                    </div>
                    <ExcelExportButton data={data} accounts={filteredAccounts} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border/50">
                  {filteredAccounts.map((account) => {
                    const isExpanded = expandedAccounts.has(account.accountId);
                    return (
                      <div key={account.accountId}>
                        <button className="flex w-full items-center justify-between px-5 py-3 hover:bg-muted/30 transition-colors text-left" onClick={() => toggleAccount(account.accountId)}>
                          <div className="flex items-center gap-3">
                            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            <div>
                              <div className="font-semibold text-sm">{account.accountName}</div>
                              <div className="text-[10px] text-muted-foreground font-mono">{account.accountId}</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-4">
                            <TrendIndicator trend={account.trend} size="sm" />
                            <div className="text-right">
                              <div className="font-bold">{fmt$(account.totalCost)}</div>
                              <div className="text-[10px] text-muted-foreground">Top: {formatAwsServiceName(account.topService.name)}</div>
                            </div>
                          </div>
                        </button>
                        {isExpanded && (
                          <div className="bg-muted/10 px-5 pb-4 space-y-1">
                            {account.services.map((svc, idx) => {
                              const svcKey = `${account.accountId}::${svc.name}`;
                              const isSvcExpanded = expandedServices.has(svcKey);
                              const resources = isSvcExpanded ? getServiceResources(account.accountId, svc.name) : [];
                              const limit = serviceLimits.get(svcKey) || 50;
                              return (
                                <div key={svc.name}>
                                  <button className="flex w-full items-center justify-between p-2.5 rounded-lg hover:bg-background/80 transition-colors text-left" onClick={() => toggleService(svcKey)}>
                                    <div className="flex items-center gap-2">
                                      <span className="w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[10px] font-bold">{idx+1}</span>
                                      <span className="text-sm font-medium">{formatAwsServiceName(svc.name)}</span>
                                      {svc.percentage && <span className="text-[10px] text-muted-foreground">{svc.percentage.toFixed(1)}%</span>}
                                      <span className="text-[10px] text-muted-foreground/50">{isSvcExpanded ? "▲" : "▼"}</span>
                                    </div>
                                    <div className="flex items-center gap-3">
                                      {svc.trend && <TrendIndicator trend={svc.trend} size="sm" />}
                                      <span className="font-semibold text-sm">{fmt$(svc.cost)}</span>
                                    </div>
                                  </button>
                                  {isSvcExpanded && (
                                    <div className="ml-8 space-y-0.5 mt-1 mb-2">
                                      {resources.length === 0 && <div className="text-[10px] text-muted-foreground py-2">{t("finops.noResourceBreakdown")}</div>}
                                      {resources.slice(0, limit).map((r: any) => (
                                        <div key={r.resourceId} className="flex items-center justify-between px-3 py-1.5 bg-muted/20 rounded text-xs">
                                          <span className="truncate text-muted-foreground flex-1 mr-3" title={r.resourceId}>{r.resourceId.length > 65 ? `...${r.resourceId.slice(-60)}` : r.resourceId}</span>
                                          <span className="font-semibold shrink-0">{fmt$(r.cost)}</span>
                                        </div>
                                      ))}
                                      {resources.length > limit && (
                                        <button className="w-full text-center text-xs text-primary hover:text-primary/80 py-1.5 hover:bg-muted/20 rounded transition-colors" onClick={(e) => { e.stopPropagation(); setServiceLimits((p) => { const n = new Map(p); n.set(svcKey, limit+50); return n; }); }}>
                                          {t("common.loadMore")} ({resources.length - limit} {t("finops.remaining")})
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {filteredAccounts.length === 0 && <div className="py-8 text-center text-sm text-muted-foreground">{t("common.noResults")}</div>}
                </div>
              </CardContent>
            </Card>
          </FinOpsSection>

        </div>
      )}

      <ComparisonExplorerDialog
        open={comparisonOpen}
        onOpenChange={setComparisonOpen}
        selectedAccountIds={selectedAccountIds}
      />
    </div>
  );
}
