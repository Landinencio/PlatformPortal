"use client";

import { useState } from "react";
import { Users, Code2, MessageSquare, AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "./stat-card";
import { TrendLineChart } from "./charts";
import { KiroUserFilter } from "./user-filter";
import { KiroLicenseUsageSection } from "./license-usage-section";
import { useKiroData, usersParam } from "./use-kiro-data";

interface TrendPoint { date: string; value: number }
interface UserOption { id: string; label: string }
interface UserActivityRow {
  userId: string;
  displayName: string;
  email: string;
  userGroup: string;
  reportDate: string;
  chatMessagesSent: number;
  chatAiCodeLines: number;
  inlineAiCodeLines: number;
  totalAiCodeAccepted: number;
}

export function KiroUserActivityDashboard() {
  const { t } = useI18n();
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const up = usersParam(selectedUsers);
  const dateP = { startDate: startDate || undefined, endDate: endDate || undefined };
  const userP = { users: up, ...dateP };
  const empty = t("kiroAnalytics.empty", "Sin datos para los filtros seleccionados");

  const users = useKiroData<UserOption[]>("/users", { source: "prompts" });
  const activity = useKiroData<UserActivityRow[]>("/user-activity", userP);
  const trend = useKiroData<TrendPoint[]>("/user-activity/trend", userP);

  const rows = activity.data ?? [];
  const totalUsers = new Set(rows.map((r) => r.userId)).size;
  const totalAiCode = rows.reduce((s, r) => s + r.totalAiCodeAccepted, 0);
  const totalMessages = rows.reduce((s, r) => s + r.chatMessagesSent, 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-4">
        <KiroUserFilter users={users.data ?? []} selected={selectedUsers} onChange={setSelectedUsers} />
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
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
      </div>

      {!activity.loading && rows.length === 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("kiroAnalytics.userActivity.notEnabled", "El registro de actividad por usuario no está habilitado en el perfil de Kiro Enterprise. Los datos de prompts sí están disponibles en la pestaña AI Insights.")}</span>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard title={t("kiroAnalytics.kpi.totalUsers", "Usuarios únicos")} value={totalUsers} loading={activity.loading} icon={<Users className="h-3.5 w-3.5" />} />
        <StatCard title={t("kiroAnalytics.kpi.aiLines", "Líneas de código IA")} value={totalAiCode} loading={activity.loading} icon={<Code2 className="h-3.5 w-3.5" />} />
        <StatCard title={t("kiroAnalytics.kpi.chat", "Mensajes de chat")} value={totalMessages} loading={activity.loading} icon={<MessageSquare className="h-3.5 w-3.5" />} />
      </div>

      <TrendLineChart
        title={t("kiroAnalytics.chart.dailyAiCode", "Código IA aceptado (diario)")}
        data={trend.data ?? []}
        loading={trend.loading}
        emptyLabel={empty}
        area
        color="hsl(160 60% 45%)"
      />

      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("kiroAnalytics.table.userActivity", "Detalle de actividad por usuario")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border/50 text-left text-muted-foreground">
                  <th className="px-2 py-1.5">{t("kiroAnalytics.col.user", "Usuario")}</th>
                  <th className="px-2 py-1.5">{t("kiroAnalytics.col.email", "Email")}</th>
                  <th className="px-2 py-1.5">{t("kiroAnalytics.col.group", "Grupo")}</th>
                  <th className="px-2 py-1.5">{t("kiroAnalytics.col.date", "Fecha")}</th>
                  <th className="px-2 py-1.5 text-right">{t("kiroAnalytics.col.chatMessages", "Mensajes chat")}</th>
                  <th className="px-2 py-1.5 text-right">{t("kiroAnalytics.col.chatAiCode", "Código chat")}</th>
                  <th className="px-2 py-1.5 text-right">{t("kiroAnalytics.col.inlineAiCode", "Código inline")}</th>
                  <th className="px-2 py-1.5 text-right">{t("kiroAnalytics.col.totalAiCode", "Total código IA")}</th>
                </tr>
              </thead>
              <tbody>
                {activity.loading ? (
                  <tr><td colSpan={8} className="py-6 text-center text-muted-foreground">{t("kiroAnalytics.loading", "Cargando...")}</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={8} className="py-6 text-center text-muted-foreground">{empty}</td></tr>
                ) : (
                  rows.map((r, i) => (
                    <tr key={`${r.userId}-${i}`} className="border-b border-border/30 hover:bg-muted/20">
                      <td className="px-2 py-1.5 max-w-[180px] truncate">{r.displayName}</td>
                      <td className="px-2 py-1.5 text-muted-foreground max-w-[180px] truncate">{r.email}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{r.userGroup}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{r.reportDate}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.chatMessagesSent.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.chatAiCodeLines.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.inlineAiCodeLines.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{r.totalAiCodeAccepted.toLocaleString()}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* License usage — rich per-user signal from user_report (all accounts) */}
      <div className="pt-2 border-t border-border/50">
        <KiroLicenseUsageSection users={up} startDate={startDate || undefined} endDate={endDate || undefined} />
      </div>
    </div>
  );
}
