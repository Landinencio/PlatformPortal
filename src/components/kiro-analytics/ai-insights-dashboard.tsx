"use client";

import { useState } from "react";
import { Users, MessageSquare, FileText, Layers, Clock } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "./stat-card";
import { TrendLineChart, DonutChart } from "./charts";
import { KiroUserFilter } from "./user-filter";
import { useKiroData, usersParam } from "./use-kiro-data";

interface OverviewStats { weeklyActiveUsers: number }
interface TrendPoint { date: string; value: number }
interface Distribution { name: string; value: number }
interface SessionStats { totalSessions: number; avgSessionDuration: number }
interface UserOption { id: string; label: string }
interface ClassifiedPromptRow {
  userId: string;
  displayName: string;
  reportDate: string;
  workType: string;
  intent: string;
  category: string;
  complexity: string;
  promptLength: number;
}
interface Paginated<T> { data: T[]; total: number; limit: number; offset: number }

const PAGE_SIZE = 50;

export function KiroAiInsightsDashboard() {
  const { t } = useI18n();
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const up = usersParam(selectedUsers);
  const userP = { users: up };
  const empty = t("kiroAnalytics.empty", "Sin datos para los filtros seleccionados");

  const users = useKiroData<UserOption[]>("/users", { source: "prompts" });
  const overview = useKiroData<OverviewStats>("/overview", {});
  const sessions = useKiroData<SessionStats>("/classified/session-stats", userP);
  const prompts = useKiroData<Paginated<ClassifiedPromptRow>>("/classified/prompts", {
    users: up,
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
  });
  const wauTrend = useKiroData<TrendPoint[]>("/user-activity/wau-trend", userP);
  const aiLines = useKiroData<TrendPoint[]>("/classified/weekly-ai-lines-trend", userP);
  const avgPrompts = useKiroData<TrendPoint[]>("/classified/avg-prompts-per-session", userP);
  const dailyUsage = useKiroData<TrendPoint[]>("/classified/daily-usage", userP);
  const featureAdoption = useKiroData<Distribution[]>("/user-activity/feature-adoption", userP);
  const workType = useKiroData<Distribution[]>("/classified/distribution/work_type", userP);
  const intent = useKiroData<Distribution[]>("/classified/distribution/intent", userP);
  const category = useKiroData<Distribution[]>("/classified/distribution/category", userP);
  const complexity = useKiroData<Distribution[]>("/classified/distribution/complexity", userP);
  const specificity = useKiroData<Distribution[]>("/classified/distribution/specificity", userP);

  const total = prompts.data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const from = total > 0 ? page * PAGE_SIZE + 1 : 0;
  const to = Math.min((page + 1) * PAGE_SIZE, total);

  return (
    <div className="space-y-5">
      <KiroUserFilter
        users={users.data ?? []}
        selected={selectedUsers}
        onChange={(v) => { setSelectedUsers(v); setPage(0); }}
      />

      {/* KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard title={t("kiroAnalytics.kpi.wau", "Usuarios activos (semana)")} value={overview.data?.weeklyActiveUsers ?? 0} loading={overview.loading} icon={<Users className="h-3.5 w-3.5" />} />
        <StatCard title={t("kiroAnalytics.kpi.chatUsers", "Usuarios de chat")} value={selectedUsers.length || (users.data?.length ?? 0)} loading={users.loading} icon={<MessageSquare className="h-3.5 w-3.5" />} />
        <StatCard title={t("kiroAnalytics.kpi.prompts", "Total prompts")} value={total} loading={prompts.loading} icon={<FileText className="h-3.5 w-3.5" />} />
        <StatCard title={t("kiroAnalytics.kpi.sessions", "Total sesiones")} value={sessions.data?.totalSessions ?? 0} loading={sessions.loading} icon={<Layers className="h-3.5 w-3.5" />} />
        <StatCard title={t("kiroAnalytics.kpi.avgDuration", "Duración media sesión (min)")} value={sessions.data?.avgSessionDuration ?? 0} loading={sessions.loading} icon={<Clock className="h-3.5 w-3.5" />} />
      </div>

      {/* Trends */}
      <div className="grid gap-4 lg:grid-cols-3">
        <TrendLineChart title={t("kiroAnalytics.chart.wauTrend", "Usuarios activos semanales")} data={wauTrend.data ?? []} loading={wauTrend.loading} emptyLabel={empty} color="hsl(160 60% 45%)" />
        <TrendLineChart title={t("kiroAnalytics.chart.aiLines", "Líneas de respuesta IA (semanal)")} data={aiLines.data ?? []} loading={aiLines.loading} emptyLabel={empty} color="hsl(24 95% 58%)" />
        <TrendLineChart title={t("kiroAnalytics.chart.avgPrompts", "Prompts por sesión (media)")} data={avgPrompts.data ?? []} loading={avgPrompts.loading} emptyLabel={empty} color="hsl(262 60% 58%)" />
      </div>
      <TrendLineChart title={t("kiroAnalytics.chart.dailyUsage", "Uso diario de prompts (90 días)")} data={dailyUsage.data ?? []} loading={dailyUsage.loading} emptyLabel={empty} area color="hsl(221 83% 60%)" />

      {/* Distributions */}
      <div className="grid gap-4 lg:grid-cols-3">
        <DonutChart title={t("kiroAnalytics.chart.featureAdoption", "Adopción por funcionalidad")} data={featureAdoption.data ?? []} loading={featureAdoption.loading} emptyLabel={empty} description={t("kiroAnalytics.chart.featureAdoption.desc", "Usuarios únicos que han usado cada funcionalidad de Kiro.")} />
        <DonutChart title={t("kiroAnalytics.chart.workType", "Tipo de trabajo")} data={workType.data ?? []} loading={workType.loading} emptyLabel={empty} description={t("kiroAnalytics.chart.workType.desc", "bug, feature, refactor, ktlo, testing, config, plan.")} />
        <DonutChart title={t("kiroAnalytics.chart.intent", "Intención")} data={intent.data ?? []} loading={intent.loading} emptyLabel={empty} description={t("kiroAnalytics.chart.intent.desc", "ask, write, plan, review, automate, explain.")} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <DonutChart title={t("kiroAnalytics.chart.category", "Categorías")} data={category.data ?? []} loading={category.loading} emptyLabel={empty} description={t("kiroAnalytics.chart.category.desc", "bug_fix, feature, documentation, architecture, etc.")} />
        <DonutChart title={t("kiroAnalytics.chart.complexity", "Complejidad")} data={complexity.data ?? []} loading={complexity.loading} emptyLabel={empty} description={t("kiroAnalytics.chart.complexity.desc", "simple, moderate, complex.")} />
        <DonutChart title={t("kiroAnalytics.chart.specificity", "Especificidad del prompt")} data={specificity.data ?? []} loading={specificity.loading} emptyLabel={empty} description={t("kiroAnalytics.chart.specificity.desc", "vague, moderate, specific.")} />
      </div>

      {/* Classified prompts table — classification metadata only (no raw prompt text) */}
      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-base">{t("kiroAnalytics.table.prompts", "Detalle de prompts clasificados")}</CardTitle>
            <span className="text-xs text-muted-foreground">
              {total > 0 ? `${from}-${to} ${t("kiroAnalytics.table.of", "de")} ${total.toLocaleString()}` : t("kiroAnalytics.table.noData", "Sin datos")}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border/50 text-left text-muted-foreground">
                  <th className="px-2 py-1.5">{t("kiroAnalytics.col.user", "Usuario")}</th>
                  <th className="px-2 py-1.5">{t("kiroAnalytics.col.date", "Fecha")}</th>
                  <th className="px-2 py-1.5">{t("kiroAnalytics.col.workType", "Tipo")}</th>
                  <th className="px-2 py-1.5">{t("kiroAnalytics.col.intent", "Intención")}</th>
                  <th className="px-2 py-1.5">{t("kiroAnalytics.col.category", "Categoría")}</th>
                  <th className="px-2 py-1.5">{t("kiroAnalytics.col.complexity", "Complejidad")}</th>
                  <th className="px-2 py-1.5 text-right">{t("kiroAnalytics.col.promptLen", "Long. prompt")}</th>
                </tr>
              </thead>
              <tbody>
                {prompts.loading ? (
                  <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">{t("kiroAnalytics.loading", "Cargando...")}</td></tr>
                ) : (prompts.data?.data ?? []).length === 0 ? (
                  <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">{empty}</td></tr>
                ) : (
                  (prompts.data?.data ?? []).map((r, i) => (
                    <tr key={`${r.userId}-${i}`} className="border-b border-border/30 hover:bg-muted/20">
                      <td className="px-2 py-1.5 max-w-[200px] truncate">{r.displayName}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{r.reportDate}</td>
                      <td className="px-2 py-1.5">{r.workType}</td>
                      <td className="px-2 py-1.5">{r.intent}</td>
                      <td className="px-2 py-1.5">{r.category}</td>
                      <td className="px-2 py-1.5">{r.complexity}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.promptLength.toLocaleString()}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-center gap-4 text-sm">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="rounded-md border border-border px-3 py-1 disabled:opacity-40 hover:bg-muted"
              >
                ← {t("kiroAnalytics.prev", "Anterior")}
              </button>
              <span className="text-muted-foreground">{t("kiroAnalytics.page", "Página")} {page + 1} / {totalPages}</span>
              <button
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-md border border-border px-3 py-1 disabled:opacity-40 hover:bg-muted"
              >
                {t("kiroAnalytics.next", "Siguiente")} →
              </button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
