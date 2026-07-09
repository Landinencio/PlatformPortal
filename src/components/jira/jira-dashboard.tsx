"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Home, Sparkles, Loader2, Ticket, Clock, CheckCircle2, AlertTriangle,
  Users, BarChart3, TrendingUp, ChevronDown, ChevronRight,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  PieChart, Pie, Cell, ComposedChart, Line,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MultiSelect } from "@/components/ui/multi-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { MiniStat } from "@/components/metrics/shared";

const PIE_COLORS = ["hsl(var(--success))", "hsl(var(--primary))", "hsl(var(--warning))", "hsl(var(--danger))", "hsl(var(--info))", "hsl(210 15% 60%)"];
const DAYS_OPTIONS = ["30", "60", "90", "180", "365"];

type DashboardData = {
  summary: {
    totalIssues: number;
    openIssues: number;
    resolvedIssues: number;
    medianCycleTimeDays: number | null;
    avgCycleTimeDays: number | null;
    aging: { over7: number; over14: number; over30: number };
  };
  byStatus: { status: string; count: number }[];
  byType: { type: string; count: number }[];
  byPriority: { priority: string; count: number }[];
  assigneeRanking: { name: string; total: number; resolved: number; open: number }[];
  trend: { month: string; created: number; resolved: number }[];
  recentIssues: any[];
  openIssues: any[];
  queues: { id: string; name: string; projectKey: string; projectName: string; issueCount: number | null }[];
  days: number;
  projectKeys: string[];
};

export function JiraDashboard() {
  const { t } = useI18n();
  const [projects, setProjects] = useState<{ key: string; name: string; type: string }[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [days, setDays] = useState("90");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const projectOptions = useMemo(
    () => projects.map((p) => ({ value: p.key, label: `${p.name} (${p.key})` })),
    [projects]
  );

  useEffect(() => {
    fetchProjects();
  }, []);

  useEffect(() => {
    if (selectedProjects.length > 0) fetchDashboard();
  }, [selectedProjects, days]);

  async function fetchProjects() {
    try {
      const res = await fetch("/api/jira/dashboard");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setProjects(json.projects || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setLoading(false);
    }
  }

  async function fetchDashboard() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ projects: selectedProjects.join(","), days });
      const res = await fetch(`/api/jira/dashboard?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl space-y-6">
        {/* Header */}
        <Card className="overflow-hidden border-border/70 bg-card/90 shadow-[0_24px_70px_-40px_rgba(75,42,19,0.35)] backdrop-blur">
          <CardContent className="p-0">
            <div className="space-y-4 p-6 sm:p-8">
              <Link href="/" className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
                <Home className="h-4 w-4" /> {t("eng.backToPortal")}
              </Link>
              <div className="space-y-3">
                <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                  <Sparkles className="h-3.5 w-3.5" /> {t("jira.badge")}
                </div>
                <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t("jira.title")}</h1>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">{t("jira.description")}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Filters */}
        <Card className="border-border/70 bg-card/85">
          <CardContent className="grid gap-4 p-5 lg:grid-cols-3">
            <div className="flex flex-col gap-2 lg:col-span-2">
              <label className="block text-sm font-medium">{t("jira.projects")}</label>
              <MultiSelect
                options={projectOptions}
                selected={selectedProjects}
                onChange={setSelectedProjects}
                placeholder={t("jira.selectProjects")}
                searchPlaceholder={t("jira.searchProject")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="block text-sm font-medium">{t("jira.timeWindow")}</label>
              <Select value={days} onValueChange={setDays}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DAYS_OPTIONS.map((d) => (
                    <SelectItem key={d} value={d}>{t("eng.lastNDays").replace("{n}", d)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {loading && <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>}
        {error && <div className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div>}

        {!loading && selectedProjects.length === 0 && (
          <div className="h-[200px] flex flex-col items-center justify-center text-center">
            <Ticket className="w-12 h-12 text-primary/40 mb-4" />
            <p className="text-muted-foreground">{t("jira.selectProjectsHint")}</p>
          </div>
        )}

        {data && !loading && (
          <div className="space-y-6 animate-in fade-in duration-300">
            {/* KPIs */}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <Card className="border-none bg-gradient-to-br from-primary to-primary/80 text-white shadow-lg">
                <CardContent className="p-5 space-y-1">
                  <div className="text-xs opacity-80 uppercase tracking-wider flex items-center gap-1"><Ticket className="h-3.5 w-3.5" /> {t("jira.totalIssues")}</div>
                  <div className="text-3xl font-bold">{data.summary.totalIssues}</div>
                  <div className="text-sm opacity-90">{data.summary.resolvedIssues} {t("jira.resolved")}</div>
                </CardContent>
              </Card>
              <Card className="border-none bg-gradient-to-br from-warning to-warning/80 text-white shadow-lg">
                <CardContent className="p-5 space-y-1">
                  <div className="text-xs opacity-80 uppercase tracking-wider">{t("jira.openIssues")}</div>
                  <div className="text-3xl font-bold">{data.summary.openIssues}</div>
                  <div className="text-sm opacity-90">&gt;7d: {data.summary.aging.over7} · &gt;14d: {data.summary.aging.over14} · &gt;30d: {data.summary.aging.over30}</div>
                </CardContent>
              </Card>
              <Card className="border-none bg-gradient-to-br from-success to-success/80 text-white shadow-lg">
                <CardContent className="p-5 space-y-1">
                  <div className="text-xs opacity-80 uppercase tracking-wider">{t("jira.cycleTime")}</div>
                  <div className="text-3xl font-bold">{data.summary.medianCycleTimeDays ?? "—"} {t("common.days")}</div>
                  <div className="text-sm opacity-90">{t("jira.median")}</div>
                </CardContent>
              </Card>
              <Card className="border-none bg-gradient-to-br from-info to-info/80 text-white shadow-lg">
                <CardContent className="p-5 space-y-1">
                  <div className="text-xs opacity-80 uppercase tracking-wider">{t("jira.avgCycleTime")}</div>
                  <div className="text-3xl font-bold">{data.summary.avgCycleTimeDays ?? "—"} {t("common.days")}</div>
                  <div className="text-sm opacity-90">{t("jira.average")}</div>
                </CardContent>
              </Card>
            </div>

            {/* Charts row */}
            <div className="grid gap-4 xl:grid-cols-3">
              {/* Status pie */}
              <Card className="border-border/70">
                <CardHeader className="pb-2"><CardTitle className="text-base">{t("jira.byStatus")}</CardTitle></CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie data={data.byStatus} cx="50%" cy="50%" innerRadius={45} outerRadius={75} paddingAngle={2} dataKey="count" nameKey="status">
                        {data.byStatus.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="flex flex-wrap gap-2 justify-center mt-2">
                    {data.byStatus.map((s, i) => (
                      <Badge key={s.status} variant="outline" className="text-[10px] gap-1">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                        {s.status} ({s.count})
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Priority bar */}
              <Card className="border-border/70">
                <CardHeader className="pb-2"><CardTitle className="text-base">{t("jira.byPriority")}</CardTitle></CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart data={data.byPriority} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis type="number" tick={{ fontSize: 12 }} />
                      <YAxis type="category" dataKey="priority" width={80} tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 6, 6, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Type breakdown */}
              <Card className="border-border/70">
                <CardHeader className="pb-2"><CardTitle className="text-base">{t("jira.byType")}</CardTitle></CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart data={data.byType} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis type="number" tick={{ fontSize: 12 }} />
                      <YAxis type="category" dataKey="type" width={100} tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Bar dataKey="count" fill="hsl(var(--info))" radius={[0, 6, 6, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>

            {/* Monthly trend */}
            {data.trend.length > 1 && (
              <Card className="border-border/70">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{t("jira.monthlyTrend")}</CardTitle>
                  <CardDescription>{t("jira.monthlyTrendDesc")}</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={280}>
                    <ComposedChart data={data.trend}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="created" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} name={t("jira.created")} />
                      <Bar dataKey="resolved" fill="hsl(var(--success))" radius={[6, 6, 0, 0]} name={t("jira.resolvedLabel")} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}

            {/* Assignee ranking + Queues */}
            <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
              <Card className="border-border/70">
                <CardHeader>
                  <CardTitle className="text-base">{t("jira.assigneeRanking")}</CardTitle>
                  <CardDescription>{t("jira.assigneeRankingDesc")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {data.assigneeRanking.slice(0, 12).map((a) => (
                    <div key={a.name} className="flex items-center justify-between rounded-xl border border-border/70 bg-background/80 px-4 py-3">
                      <div className="font-medium text-sm">{a.name}</div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{a.total} {t("jira.total")}</span>
                        <Badge className="bg-success/12 text-success text-[10px]">{a.resolved} ✓</Badge>
                        {a.open > 0 && <Badge className="bg-warning/12 text-warning text-[10px]">{a.open} {t("jira.openLabel")}</Badge>}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {data.queues.length > 0 && (
                <Card className="border-border/70">
                  <CardHeader>
                    <CardTitle className="text-base">{t("jira.serviceQueues")}</CardTitle>
                    <CardDescription>{t("jira.serviceQueuesDesc")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {data.queues.map((q) => (
                      <div key={q.id} className="flex items-center justify-between rounded-xl border border-border/70 bg-background/80 px-4 py-3">
                        <div>
                          <div className="font-medium text-sm">{q.name}</div>
                          <div className="text-[10px] text-muted-foreground">{q.projectName}</div>
                        </div>
                        {q.issueCount !== null && (
                          <Badge variant="outline">{q.issueCount}</Badge>
                        )}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Recent issues */}
            <Card className="border-border/70">
              <CardHeader>
                <CardTitle className="text-base">{t("jira.recentIssues")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.recentIssues.slice(0, 15).map((issue: any) => (
                  <div key={issue.key} className="flex items-center justify-between rounded-xl border border-border/70 bg-background/80 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px] shrink-0">{issue.key}</Badge>
                        <span className="text-sm font-medium truncate">{issue.summary}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span>{issue.assignee || "Unassigned"}</span>
                        <span>·</span>
                        <span>{issue.created}</span>
                      </div>
                    </div>
                    <Badge className={cn("text-[10px] shrink-0",
                      issue.statusCategory === "done" ? "bg-success/12 text-success" :
                      issue.statusCategory === "indeterminate" ? "bg-info/12 text-info" :
                      "bg-muted text-muted-foreground"
                    )}>{issue.status}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
