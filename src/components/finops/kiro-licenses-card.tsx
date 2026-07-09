"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Search, Sparkles, Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface KiroUsageRow {
  userId: string;
  email: string | null;
  displayName: string | null;
  groups: string[];
  plan: string;
  account: string;
  cost: number;
}

interface KiroSummary {
  window: { startDate: string; endDate: string };
  totalCost: number;
  totalCredits: number;
  netCost: number;
  byPlan: Array<{ plan: string; users: number; cost: number }>;
  unattributedCost: number;
  users: KiroUsageRow[];
  unresolvedUserIds: string[];
}

function fmt$(v: number) {
  if (!Number.isFinite(v)) return "—";
  return `$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function planColor(plan: string): string {
  if (plan === "Power") return "bg-violet-500/15 text-violet-600 border-violet-500/40";
  if (plan === "Pro+") return "bg-info/15 text-info border-info/40";
  if (plan === "Pro") return "bg-success/15 text-success border-success/40";
  if (plan === "Credits") return "bg-warning/15 text-warning border-warning/40";
  return "bg-muted text-muted-foreground";
}

export function KiroLicensesCard({ accountIds }: { accountIds?: string[] } = {}) {
  const [data, setData] = useState<KiroSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [planFilter, setPlanFilter] = useState<string>("all");

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (accountIds && accountIds.length > 0) params.set("accountIds", accountIds.join(","));
    fetch(`/api/finops/kiro${params.toString() ? "?" + params.toString() : ""}`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [accountIds?.join(",")]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.users.filter((u) => {
      if (planFilter !== "all" && u.plan !== planFilter) return false;
      if (!q) return true;
      const haystack = `${u.email || ""} ${u.displayName || ""} ${u.groups.join(" ")} ${u.account}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [data, search, planFilter]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card className="border-none bg-gradient-to-br from-violet-500 to-violet-600 text-white">
          <CardContent className="p-5 space-y-1">
            <div className="text-xs uppercase tracking-wider opacity-80 flex items-center gap-1">
              <Sparkles className="h-3.5 w-3.5" /> Kiro neto
            </div>
            <div className="text-3xl font-bold">{fmt$(data.netCost)}</div>
            <div className="text-xs opacity-80">{fmt$(data.totalCost)} cargos · {fmt$(Math.abs(data.totalCredits))} créditos</div>
          </CardContent>
        </Card>
        <Card className="border-border/60">
          <CardContent className="p-5 space-y-1">
            <div className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <Users className="h-3.5 w-3.5" /> Usuarios activos
            </div>
            <div className="text-3xl font-bold">{data.users.length}</div>
            <div className="text-xs text-muted-foreground">{data.unresolvedUserIds.length} sin resolver</div>
          </CardContent>
        </Card>
        {data.byPlan.slice(0, 2).map((p) => (
          <Card key={p.plan} className="border-border/60">
            <CardContent className="p-5 space-y-1">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Plan {p.plan}</div>
              <div className="text-3xl font-bold">{fmt$(p.cost)}</div>
              <div className="text-xs text-muted-foreground">{p.users} usuarios</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Plan distribution */}
      {data.byPlan.length > 0 && (
        <Card className="border-border/70">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Distribución por plan</CardTitle>
            <CardDescription>Coste y usuarios por nivel de licencia</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {data.byPlan.map((p) => (
                <button
                  key={p.plan}
                  onClick={() => setPlanFilter(planFilter === p.plan ? "all" : p.plan)}
                  className={cn(
                    "rounded-xl border px-4 py-3 text-left transition",
                    planFilter === p.plan ? "border-primary bg-primary/5" : "border-border/60 hover:bg-muted/30",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <Badge variant="outline" className={planColor(p.plan)}>{p.plan}</Badge>
                    <span className="text-[10px] text-muted-foreground">{p.users} usr</span>
                  </div>
                  <div className="mt-1.5 text-lg font-bold">{fmt$(p.cost)}</div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Users table */}
      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-base">Detalle por usuario</CardTitle>
              <CardDescription>{filtered.length} de {data.users.length} usuarios</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {planFilter !== "all" && (
                <button onClick={() => setPlanFilter("all")} className="text-xs text-primary hover:underline">
                  Quitar filtro plan
                </button>
              )}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Buscar por email, grupo, cuenta..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="rounded-md border border-border bg-background py-1.5 pl-8 pr-3 text-xs w-64 focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border/50 text-muted-foreground">
                  <th className="px-2 py-1.5 text-left">Usuario</th>
                  <th className="px-2 py-1.5 text-left">Plan</th>
                  <th className="px-2 py-1.5 text-left">Cuenta</th>
                  <th className="px-2 py-1.5 text-left">Grupos</th>
                  <th className="px-2 py-1.5 text-right">Coste / mes</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u, i) => (
                  <tr key={`${u.userId}-${u.plan}-${u.account}-${i}`} className="border-b border-border/30 hover:bg-muted/20">
                    <td className="px-2 py-1.5">
                      <div className="font-medium">{u.displayName || u.email || u.userId}</div>
                      {u.email && u.displayName && <div className="text-[10px] text-muted-foreground">{u.email}</div>}
                    </td>
                    <td className="px-2 py-1.5">
                      <Badge variant="outline" className={planColor(u.plan)}>{u.plan}</Badge>
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground truncate max-w-[180px]">{u.account}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      <div className="flex flex-wrap gap-1">
                        {u.groups.slice(0, 3).map((g) => (
                          <span key={g} className="rounded-full bg-muted px-1.5 py-0 text-[10px]">{g}</span>
                        ))}
                        {u.groups.length > 3 && <span className="text-[10px]">+{u.groups.length - 3}</span>}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{fmt$(u.cost)}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={5} className="py-6 text-center text-muted-foreground">Sin resultados</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
