"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  AreaChart,
  Area,
  ComposedChart,
  Line,
} from "recharts";
import { Loader2, RefreshCcw, TrendingUp, Zap, Shield, DollarSign } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

type ForecastMonth = { start: string; end: string; mean: number; low: number; high: number };
type ForecastData = {
  generatedAt: string;
  forecast: { period: { start: string; end: string }; totalMean: number; currency: string; byMonth: ForecastMonth[] } | null;
  spCoverage: { period: { start: string; end: string }; averageCoveragePct: number; daily: Array<{ start: string; coveragePct: number; spendCoveredBySP: number; onDemandCost: number; totalCost: number }> } | null;
  errors: Array<{ area: string; message: string }>;
};

function fmt(v: number) { return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`; }
function fmtK(v: number) { return v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`; }

export function ForecastPanel({ accountIds }: { accountIds?: string[] }) {
  const [data, setData] = useState<ForecastData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();

  const fetchForecast = async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      params.set("months", "3");
      if (accountIds && accountIds.length > 0) params.set("accountIds", accountIds.join(","));
      const res = await fetch(`/api/finops/forecast?${params.toString()}`);
      if (!res.ok) throw new Error("Failed");
      setData(await res.json());
    } catch (err) { setError(err instanceof Error ? err.message : "Error"); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchForecast(); }, [accountIds?.join(",")]);

  if (loading) return (
    <Card className="border-border/70"><CardContent className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></CardContent></Card>
  );
  if (error || !data) return (
    <Card className="border-border/70"><CardContent className="py-8 text-center"><p className="text-sm text-muted-foreground">{error || "Sin datos"}</p><Button variant="ghost" size="sm" onClick={fetchForecast} className="mt-2"><RefreshCcw className="h-3.5 w-3.5 mr-1" /> Reintentar</Button></CardContent></Card>
  );

  const chartData = data.forecast?.byMonth.map((m) => ({
    month: new Date(m.start).toLocaleDateString("es-ES", { month: "short", year: "numeric" }),
    mean: m.mean,
    low: m.low,
    high: m.high,
    range: m.high - m.low,
  })) || [];

  const spDaily = data.spCoverage?.daily || [];
  const spAvg = data.spCoverage?.averageCoveragePct || 0;
  const nextMonth = data.forecast?.byMonth[0]?.mean || 0;
  const total3m = data.forecast?.totalMean || 0;

  // SP expiration alert
  const spCommitment = (data as any).spCommitment || (data as any).commitment;
  const spExpirationDays = spCommitment?.nextExpirationDays;

  return (
    <div className="space-y-4">
      {/* SP Expiration Alert */}
      {spExpirationDays != null && spExpirationDays <= 90 && (
        <div className={cn(
          "flex items-center gap-3 rounded-xl border px-4 py-3 text-sm",
          spExpirationDays <= 30 ? "border-danger/40 bg-danger/10 text-danger" : "border-warning/40 bg-warning/10 text-warning"
        )}>
          <Zap className="h-4 w-4 shrink-0" />
          <span><strong>Savings Plan expira en {spExpirationDays} días.</strong> Revisa la renovación para mantener cobertura.</span>
        </div>
      )}

      {/* Main grid: Forecast + SP Coverage side by side */}
      <div className="grid gap-4 xl:grid-cols-5">
        {/* Forecast — 3 columns */}
        {chartData.length > 0 && (
          <Card className="border-border/70 xl:col-span-3 overflow-hidden">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-info" />
                    Proyección de costes
                  </CardTitle>
                  <CardDescription>Estimación AWS próximos 3 meses (NET cost)</CardDescription>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold text-foreground">{fmtK(total3m)}</div>
                  <div className="text-[10px] text-muted-foreground uppercase">Total 3 meses</div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pb-4">
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={chartData}>
                  <defs>
                    <linearGradient id="forecastGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--info))" stopOpacity={0.8} />
                      <stop offset="100%" stopColor="hsl(var(--info))" stopOpacity={0.3} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtK} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: any) => fmt(v)} contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }} />
                  <Bar dataKey="mean" fill="url(#forecastGrad)" radius={[8, 8, 0, 0]} name="Estimación" />
                  {chartData[0]?.high > 0 && (
                    <Line type="monotone" dataKey="high" stroke="hsl(var(--info))" strokeDasharray="4 4" strokeWidth={1.5} dot={false} name="Máximo" />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
              {/* Monthly breakdown */}
              <div className="mt-3 grid grid-cols-3 gap-3">
                {chartData.map((m, i) => (
                  <div key={m.month} className={cn(
                    "rounded-xl p-3 text-center transition-all",
                    i === 0 ? "bg-info/10 border border-info/20" : "bg-muted/30"
                  )}>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{m.month}</div>
                    <div className={cn("text-lg font-bold mt-0.5", i === 0 ? "text-info" : "text-foreground")}>{fmtK(m.mean)}</div>
                    {m.low > 0 && m.high > 0 && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">{fmtK(m.low)} — {fmtK(m.high)}</div>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* SP Coverage — 2 columns */}
        {spDaily.length > 5 && (
          <Card className="border-border/70 xl:col-span-2 overflow-hidden">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Shield className="h-4 w-4 text-success" />
                    Savings Plans
                  </CardTitle>
                  <CardDescription>Cobertura últimos 30 días</CardDescription>
                </div>
                <div className="text-right">
                  <div className={cn(
                    "text-2xl font-bold",
                    spAvg >= 60 ? "text-success" : spAvg >= 40 ? "text-warning" : "text-danger"
                  )}>{spAvg}%</div>
                  <div className="text-[10px] text-muted-foreground uppercase">Cobertura media</div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pb-4">
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={spDaily}>
                  <defs>
                    <linearGradient id="spGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--success))" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="hsl(var(--success))" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="start" tick={{ fontSize: 9 }} tickFormatter={(v) => v?.slice(5, 10)} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9 }} domain={[0, 100]} tickFormatter={(v) => `${v}%`} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: any) => `${v}%`} contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }} />
                  <Area type="monotone" dataKey="coveragePct" stroke="hsl(var(--success))" fill="url(#spGrad)" strokeWidth={2.5} name="Cobertura" />
                </AreaChart>
              </ResponsiveContainer>
              {/* SP KPIs */}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-success/10 p-2.5 text-center">
                  <div className="text-[10px] text-muted-foreground uppercase">Cubierto por SP</div>
                  <div className="text-sm font-bold text-success mt-0.5">
                    {fmtK(spDaily.reduce((s, d) => s + (d.spendCoveredBySP || 0), 0))}
                  </div>
                </div>
                <div className="rounded-lg bg-warning/10 p-2.5 text-center">
                  <div className="text-[10px] text-muted-foreground uppercase">On-Demand expuesto</div>
                  <div className="text-sm font-bold text-warning mt-0.5">
                    {fmtK(spDaily.reduce((s, d) => s + (d.onDemandCost || 0), 0))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Errors */}
      {data.errors.length > 0 && (
        <div className="space-y-1">
          {data.errors.map((err, idx) => (
            <div key={idx} className="text-xs text-muted-foreground">⚠️ {err.area}: {err.message}</div>
          ))}
        </div>
      )}
    </div>
  );
}
