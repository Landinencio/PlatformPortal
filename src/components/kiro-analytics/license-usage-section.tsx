"use client";

import { useMemo, useState } from "react";
import { BadgeCheck, MessageSquare, Coins, Users } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { StatCard } from "./stat-card";
import { useKiroData } from "./use-kiro-data";

interface LicenseUsageRow {
  userId: string;
  displayName: string;
  email: string;
  group: string;
  tier: string;
  clients: string[];
  totalMessages: number;
  autoMessages: number;
  conversations: number;
  creditsUsed: number;
  days: number;
}

interface LicenseUsageSummary {
  rows: LicenseUsageRow[];
  totalUsers: number;
  byTier: Array<{ tier: string; users: number; messages: number }>;
  totalMessages: number;
  totalCreditsUsed: number;
}

function tierColor(tier: string): string {
  const t = (tier || "").toUpperCase();
  if (t.includes("POWER")) return "bg-violet-500/15 text-violet-600 border-violet-500/40";
  if (t.includes("PLUS")) return "bg-info/15 text-info border-info/40";
  if (t.includes("PRO")) return "bg-success/15 text-success border-success/40";
  return "bg-muted text-muted-foreground";
}

export function KiroLicenseUsageSection({ users, startDate, endDate }: { users?: string; startDate?: string; endDate?: string }) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const { data, loading } = useKiroData<LicenseUsageSummary>("/license-usage", { users, startDate, endDate });

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.rows.filter((u) => {
      if (tierFilter !== "all" && u.tier !== tierFilter) return false;
      if (!q) return true;
      return `${u.displayName} ${u.email} ${u.group}`.toLowerCase().includes(q);
    });
  }, [data, search, tierFilter]);

  const empty = t("kiroAnalytics.empty", "Sin datos para los filtros seleccionados");

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">{t("kiroAnalytics.license.title", "Uso por licencia")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("kiroAnalytics.license.subtitle", "Consumo por usuario: plan, clientes, mensajes y créditos (todas las cuentas).")}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title={t("kiroAnalytics.license.users", "Usuarios con licencia")} value={data?.totalUsers ?? 0} loading={loading} icon={<Users className="h-3.5 w-3.5" />} />
        <StatCard title={t("kiroAnalytics.license.messages", "Mensajes totales")} value={data?.totalMessages ?? 0} loading={loading} icon={<MessageSquare className="h-3.5 w-3.5" />} />
        <StatCard title={t("kiroAnalytics.license.credits", "Créditos usados")} value={data ? Math.round(data.totalCreditsUsed) : 0} loading={loading} icon={<Coins className="h-3.5 w-3.5" />} />
        <StatCard title={t("kiroAnalytics.license.tiers", "Planes")} value={data?.byTier.length ?? 0} loading={loading} icon={<BadgeCheck className="h-3.5 w-3.5" />} />
      </div>

      {/* Tier distribution */}
      {data && data.byTier.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {data.byTier.map((p) => (
            <button
              key={p.tier}
              onClick={() => setTierFilter(tierFilter === p.tier ? "all" : p.tier)}
              className={cn(
                "rounded-xl border px-4 py-3 text-left transition",
                tierFilter === p.tier ? "border-primary bg-primary/5" : "border-border/60 hover:bg-muted/30",
              )}
            >
              <div className="flex items-center justify-between">
                <Badge variant="outline" className={tierColor(p.tier)}>{p.tier || "—"}</Badge>
                <span className="text-[10px] text-muted-foreground">{p.users} usr</span>
              </div>
              <div className="mt-1.5 text-lg font-bold">{p.messages.toLocaleString()}</div>
              <div className="text-[10px] text-muted-foreground">{t("kiroAnalytics.license.messages", "Mensajes totales")}</div>
            </button>
          ))}
        </div>
      )}

      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-base">{t("kiroAnalytics.license.tableTitle", "Detalle por usuario")}</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              {tierFilter !== "all" && (
                <button onClick={() => setTierFilter("all")} className="text-xs text-primary hover:underline">
                  {t("kiroAnalytics.license.clearTier", "Quitar filtro plan")}
                </button>
              )}
              <input
                type="text"
                placeholder={t("kiroAnalytics.license.search", "Buscar usuario, email, grupo...")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="rounded-md border border-border bg-background py-1.5 px-3 text-xs w-64 focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="max-h-[460px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border/50 text-left text-muted-foreground">
                  <th className="px-2 py-1.5">{t("kiroAnalytics.col.user", "Usuario")}</th>
                  <th className="px-2 py-1.5">{t("kiroAnalytics.license.tier", "Plan")}</th>
                  <th className="px-2 py-1.5">{t("kiroAnalytics.license.clients", "Clientes")}</th>
                  <th className="px-2 py-1.5">{t("kiroAnalytics.col.group", "Grupo")}</th>
                  <th className="px-2 py-1.5 text-right">{t("kiroAnalytics.license.messages", "Mensajes totales")}</th>
                  <th className="px-2 py-1.5 text-right">{t("kiroAnalytics.license.conversations", "Conversaciones")}</th>
                  <th className="px-2 py-1.5 text-right">{t("kiroAnalytics.license.credits", "Créditos usados")}</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">{t("kiroAnalytics.loading", "Cargando...")}</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">{empty}</td></tr>
                ) : (
                  filtered.map((u) => (
                    <tr key={u.userId} className="border-b border-border/30 hover:bg-muted/20">
                      <td className="px-2 py-1.5 max-w-[200px] truncate" title={u.email || u.displayName}>{u.displayName}</td>
                      <td className="px-2 py-1.5"><Badge variant="outline" className={tierColor(u.tier)}>{u.tier || "—"}</Badge></td>
                      <td className="px-2 py-1.5 text-muted-foreground">{u.clients.join(", ")}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{u.group || "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{u.totalMessages.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{u.conversations.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{u.creditsUsed.toLocaleString()}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
