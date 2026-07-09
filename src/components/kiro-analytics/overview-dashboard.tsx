"use client";

import { useState } from "react";
import { Users, MessageSquare, Code2, Clock, Coins, Sparkles, FileText } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { StatCard } from "./stat-card";
import { TrendLineChart, RankingChart } from "./charts";
import { useKiroData } from "./use-kiro-data";

interface OverviewStats {
  totalUniqueUsers: number;
  totalPrompts: number;
  totalAiCodeLines: number;
  totalChatMessages: number;
  weeklyActiveUsers: number;
  estimatedHoursSaved: number;
  estimatedSavingsEur: number;
}
interface TrendPoint { date: string; value: number }
interface UserRanking { displayName: string; value: number }
interface Distribution { name: string; value: number }

export function KiroOverviewDashboard() {
  const { t } = useI18n();
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const dateParams = { startDate: startDate || undefined, endDate: endDate || undefined };
  const stats = useKiroData<OverviewStats>("/overview", dateParams);
  const wauTrend = useKiroData<TrendPoint[]>("/user-activity/wau-trend", {});
  const topByPrompts = useKiroData<UserRanking[]>("/classified/top-by-prompts", {});
  const topByCode = useKiroData<UserRanking[]>("/user-activity/top-by-code", {});
  const byGroup = useKiroData<Distribution[]>("/user-activity/by-group", {});

  const empty = t("kiroAnalytics.empty", "Sin datos para los filtros seleccionados");

  return (
    <div className="space-y-5">
      {/* Date range */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
        <label className="text-sm font-medium">{t("kiroAnalytics.dateRange", "Rango de fechas")}</label>
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
        />
        <span className="text-muted-foreground">→</span>
        <input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
        />
        {(startDate || endDate) && (
          <button
            onClick={() => { setStartDate(""); setEndDate(""); }}
            className="rounded-md border border-border bg-background px-3 py-1 text-sm hover:bg-muted"
          >
            {t("kiroAnalytics.clear", "Limpiar")}
          </button>
        )}
      </div>

      {/* KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <StatCard title={t("kiroAnalytics.kpi.wau", "Usuarios activos (semana)")} value={stats.data?.weeklyActiveUsers ?? 0} loading={stats.loading} icon={<Users className="h-3.5 w-3.5" />} description={t("kiroAnalytics.kpi.wau.desc", "Usuarios únicos que han usado Kiro en los últimos 7 días.")} />
        <StatCard title={t("kiroAnalytics.kpi.totalUsers", "Usuarios únicos")} value={stats.data?.totalUniqueUsers ?? 0} loading={stats.loading} icon={<Users className="h-3.5 w-3.5" />} description={t("kiroAnalytics.kpi.totalUsers.desc", "Total de usuarios distintos que han usado Kiro.")} />
        <StatCard title={t("kiroAnalytics.kpi.prompts", "Total prompts")} value={stats.data?.totalPrompts ?? 0} loading={stats.loading} icon={<FileText className="h-3.5 w-3.5" />} description={t("kiroAnalytics.kpi.prompts.desc", "Número total de mensajes enviados a Kiro.")} />
        <StatCard title={t("kiroAnalytics.kpi.aiLines", "Líneas de código IA")} value={stats.data?.totalAiCodeLines ?? 0} loading={stats.loading} icon={<Code2 className="h-3.5 w-3.5" />} description={t("kiroAnalytics.kpi.aiLines.desc", "Líneas de código generadas por IA aceptadas por los usuarios.")} />
        <StatCard title={t("kiroAnalytics.kpi.chat", "Mensajes de chat")} value={stats.data?.totalChatMessages ?? 0} loading={stats.loading} icon={<MessageSquare className="h-3.5 w-3.5" />} description={t("kiroAnalytics.kpi.chat.desc", "Total de mensajes en conversaciones de chat con Kiro.")} />
        <StatCard title={t("kiroAnalytics.kpi.hours", "Horas ahorradas")} value={stats.data?.estimatedHoursSaved ?? 0} loading={stats.loading} icon={<Clock className="h-3.5 w-3.5" />} description={t("kiroAnalytics.kpi.hours.desc", "Estimación del tiempo ahorrado gracias a la asistencia de IA.")} />
        <StatCard title={t("kiroAnalytics.kpi.savings", "Ahorro estimado (€)")} value={`${(stats.data?.estimatedSavingsEur ?? 0).toLocaleString()}€`} loading={stats.loading} icon={<Coins className="h-3.5 w-3.5" />} highlight description={t("kiroAnalytics.kpi.savings.desc", "Horas ahorradas × tarifa horaria configurable (26€/h por defecto).")} />
      </div>

      <TrendLineChart
        title={t("kiroAnalytics.chart.wauTrend", "Usuarios activos semanales")}
        data={wauTrend.data ?? []}
        loading={wauTrend.loading}
        emptyLabel={empty}
        area
        color="hsl(262 60% 58%)"
      />

      <RankingChart
        title={t("kiroAnalytics.chart.topByPrompts", "Top usuarios por prompts")}
        data={topByPrompts.data ?? []}
        loading={topByPrompts.loading}
        emptyLabel={empty}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <RankingChart
          title={t("kiroAnalytics.chart.topByCode", "Top usuarios por código IA")}
          data={topByCode.data ?? []}
          loading={topByCode.loading}
          emptyLabel={empty}
          color="hsl(160 60% 45%)"
        />
        <RankingChart
          title={t("kiroAnalytics.chart.byGroup", "Código IA por equipo/grupo")}
          data={(byGroup.data ?? []).map((d) => ({ displayName: d.name, value: d.value }))}
          loading={byGroup.loading}
          emptyLabel={empty}
          color="hsl(43 96% 56%)"
        />
      </div>
    </div>
  );
}
