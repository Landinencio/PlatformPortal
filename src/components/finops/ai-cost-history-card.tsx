"use client";

import { useMemo, useState } from "react";
import { LineChart as LineChartIcon, AlertTriangle, Sparkles, Building2 } from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceDot,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

interface AiCostByAccount {
  accountId: string;
  accountName: string;
  kiroCost: number;
  bedrockCost: number;
  totalCost: number;
}

interface AiCostDay {
  date: string; // YYYY-MM-DD
  kiroCost: number;
  bedrockCost: number;
  totalAiCost: number;
  byAccount: AiCostByAccount[];
}

export interface AiCostDaily {
  days: AiCostDay[];
  anomalyDays: string[];
  totals: { kiro: number; bedrock: number; total: number };
}

const KIRO_COLOR = "hsl(262 60% 58%)"; // violet — matches the Kiro licenses card
const BEDROCK_COLOR = "hsl(var(--info))";

function fmt$(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/** Short axis label for a YYYY-MM-DD date (DD/MM). */
function shortDate(date: string): string {
  const parts = date.split("-");
  if (parts.length === 3) return `${parts[2]}/${parts[1]}`;
  return date;
}

/**
 * AI cost history (Kiro + Bedrock). Reads the `aiCostDaily` series produced by the
 * same CUR-direct query that feeds the rest of the Costs tab — so it is reactive to
 * the selected accounts and date range (no separate fetch, no snapshot table).
 */
export function AiCostHistoryCard({ data }: { data?: AiCostDaily | null }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"daily" | "cumulative">("daily");

  const anomalySet = useMemo(() => new Set(data?.anomalyDays ?? []), [data?.anomalyDays]);

  const chartData = useMemo(
    () =>
      (data?.days ?? []).map((d) => ({
        date: d.date,
        label: shortDate(d.date),
        kiro: d.kiroCost,
        bedrock: d.bedrockCost,
        total: d.totalAiCost,
        anomaly: anomalySet.has(d.date),
      })),
    [data?.days, anomalySet],
  );

  // Cumulative series: each point sums every prior day, so the line keeps climbing
  // and the slope shows the spend rate at a glance.
  const cumulativeData = useMemo(() => {
    let kiroAcc = 0;
    let bedrockAcc = 0;
    return (data?.days ?? []).map((d) => {
      kiroAcc += d.kiroCost;
      bedrockAcc += d.bedrockCost;
      return {
        date: d.date,
        label: shortDate(d.date),
        kiro: Math.round(kiroAcc * 100) / 100,
        bedrock: Math.round(bedrockAcc * 100) / 100,
        total: Math.round((kiroAcc + bedrockAcc) * 100) / 100,
        anomaly: anomalySet.has(d.date),
      };
    });
  }, [data?.days, anomalySet]);

  const isCumulative = mode === "cumulative";
  const activeData = isCumulative ? cumulativeData : chartData;

  // Aggregate the per-account breakdown across the visible window, with friendly names.
  const byAccount = useMemo(() => {
    const map = new Map<string, AiCostByAccount>();
    for (const day of data?.days ?? []) {
      for (const acc of day.byAccount ?? []) {
        const entry = map.get(acc.accountId);
        if (entry) {
          entry.kiroCost += acc.kiroCost;
          entry.bedrockCost += acc.bedrockCost;
          entry.totalCost += acc.totalCost;
          if ((!entry.accountName || entry.accountName === entry.accountId) && acc.accountName) {
            entry.accountName = acc.accountName;
          }
        } else {
          map.set(acc.accountId, { ...acc });
        }
      }
    }
    return [...map.values()]
      .map((a) => ({
        ...a,
        kiroCost: Math.round(a.kiroCost * 100) / 100,
        bedrockCost: Math.round(a.bedrockCost * 100) / 100,
        totalCost: Math.round(a.totalCost * 100) / 100,
      }))
      .filter((a) => a.totalCost > 0)
      .sort((a, b) => b.totalCost - a.totalCost);
  }, [data?.days]);

  const hasData = !!data && data.days.length > 0;

  return (
    <Card className="border-border/70">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-violet-500" />
              {t("finops.aiCost.title", "Histórico de coste de IA")}
            </CardTitle>
            <CardDescription>
              {isCumulative
                ? t("finops.aiCost.descriptionCumulative", "Coste de IA acumulado en el periodo (Kiro + Bedrock) — la pendiente muestra el ritmo de gasto")
                : t("finops.aiCost.description", "Evolución diaria del coste de IA (Kiro + Bedrock) con detección de picos anómalos")}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {hasData && data.anomalyDays.length > 0 && (
              <Badge variant="outline" className="border-danger/40 text-danger text-[10px]">
                <AlertTriangle className="mr-1 h-3 w-3" />
                {data.anomalyDays.length} {t("finops.aiCost.anomalyDays", "día(s) con pico anómalo")}
              </Badge>
            )}
            {hasData && (
              <div className="flex items-center gap-0.5 rounded-lg border border-border/60 p-0.5">
                <button
                  type="button"
                  onClick={() => setMode("daily")}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] font-semibold transition",
                    !isCumulative ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/40",
                  )}
                >
                  {t("finops.aiCost.modeDaily", "Diario")}
                </button>
                <button
                  type="button"
                  onClick={() => setMode("cumulative")}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] font-semibold transition",
                    isCumulative ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/40",
                  )}
                >
                  {t("finops.aiCost.modeCumulative", "Acumulado")}
                </button>
              </div>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <LineChartIcon className="mb-3 h-10 w-10 text-primary/30" />
            <h4 className="text-sm font-semibold">{t("finops.aiCost.emptyTitle", "Sin datos en el rango seleccionado")}</h4>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              {t("finops.aiCost.emptyDescription", "No hay coste de IA (Kiro/Bedrock) en las cuentas y fechas seleccionadas.")}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Period totals */}
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-border/60 px-4 py-3">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: KIRO_COLOR }} />
                  {t("finops.aiCost.kiroPeriod", "Kiro (periodo)")}
                </div>
                <div className="mt-1 text-2xl font-bold">{fmt$(data.totals.kiro)}</div>
              </div>
              <div className="rounded-xl border border-border/60 px-4 py-3">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: BEDROCK_COLOR }} />
                  {t("finops.aiCost.bedrockPeriod", "Bedrock (periodo)")}
                </div>
                <div className="mt-1 text-2xl font-bold">{fmt$(data.totals.bedrock)}</div>
              </div>
              <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 px-4 py-3">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  {t("finops.aiCost.totalPeriod", "Total IA (periodo)")}
                </div>
                <div className="mt-1 text-2xl font-bold text-violet-600">{fmt$(data.totals.total)}</div>
              </div>
            </div>

            {/* Stacked area chart with anomaly markers */}
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={activeData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="aiCostKiro" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={KIRO_COLOR} stopOpacity={0.6} />
                    <stop offset="95%" stopColor={KIRO_COLOR} stopOpacity={0.1} />
                  </linearGradient>
                  <linearGradient id="aiCostBedrock" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={BEDROCK_COLOR} stopOpacity={0.6} />
                    <stop offset="95%" stopColor={BEDROCK_COLOR} stopOpacity={0.1} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={20} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => fmt$(v)} width={64} />
                <Tooltip
                  formatter={(value: any, name: any) => [fmt$(Number(value)), name]}
                  labelFormatter={(label: any, payload: any) => {
                    const point = payload && payload[0]?.payload;
                    const base = point?.date || label;
                    return point?.anomaly ? `${base} · ${t("finops.aiCost.anomalyTooltip", "pico anómalo")}` : base;
                  }}
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid hsl(var(--border))" }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Area
                  type="monotone"
                  dataKey="kiro"
                  stackId="1"
                  name={t("finops.aiCost.kiro", "Kiro")}
                  stroke={KIRO_COLOR}
                  fill="url(#aiCostKiro)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="bedrock"
                  stackId="1"
                  name={t("finops.aiCost.bedrock", "Bedrock")}
                  stroke={BEDROCK_COLOR}
                  fill="url(#aiCostBedrock)"
                  strokeWidth={2}
                />
                {/* Highlight anomalous days at the stacked total */}
                {activeData
                  .filter((d) => d.anomaly)
                  .map((d) => (
                    <ReferenceDot
                      key={d.date}
                      x={d.label}
                      y={d.total}
                      r={5}
                      fill="hsl(var(--danger))"
                      stroke="hsl(var(--background))"
                      strokeWidth={1.5}
                      ifOverflow="extendDomain"
                    />
                  ))}
              </AreaChart>
            </ResponsiveContainer>

            {/* Per-account breakdown (friendly names) */}
            {byAccount.length > 0 && (
              <div className="rounded-xl border border-border/60 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <Building2 className="h-3.5 w-3.5" />
                  {t("finops.aiCost.byAccount", "Coste de IA por cuenta")}
                </div>
                <div className="space-y-1.5">
                  {byAccount.slice(0, 12).map((acc) => {
                    const max = byAccount[0]?.totalCost || 1;
                    const widthPct = Math.max(4, (acc.totalCost / max) * 100);
                    return (
                      <div key={acc.accountId} className="flex items-center gap-3">
                        <span className="w-40 truncate text-right text-xs font-medium" title={`${acc.accountName} (${acc.accountId})`}>
                          {acc.accountName}
                        </span>
                        <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-muted/30">
                          <div className="h-full rounded-md bg-gradient-to-r from-violet-500/80 to-info/50" style={{ width: `${widthPct}%` }} />
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold">
                            {fmt$(acc.totalCost)}
                          </span>
                        </div>
                        <span className="w-28 text-right text-[10px] text-muted-foreground">
                          K {fmt$(acc.kiroCost)} · B {fmt$(acc.bedrockCost)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
