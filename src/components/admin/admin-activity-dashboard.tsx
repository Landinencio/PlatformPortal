"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { Users, Clock3, MousePointerClick, Activity, RefreshCw, Shield, Search, LogIn } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, BarChart, Bar } from "recharts";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

type ActivitySummaryResponse = {
    periodDays: number;
    totals: {
        events: number;
        uniqueUsers: number;
        sessions: number;
        avgSessionMinutes: number;
        pageViews: number;
        clicks: number;
        logins: number;
    };
    users: Array<{
        email: string;
        name: string;
        role: string;
        lastSeen: string;
        totalEvents: number;
        totalSessions: number;
        totalMinutes: number;
    }>;
    topPaths: Array<{ path: string; views: number; uniqueUsers: number }>;
    topActions: Array<{ action: string; count: number }>;
    daily: Array<{ date: string; users: number; events: number; sessions: number }>;
};

type ActivityEventsResponse = {
    total: number;
    events: Array<{
        id: string;
        occurredAt: string;
        eventType: string;
        userEmail: string;
        userName: string;
        userRole: string;
        sessionId: string | null;
        path: string | null;
        action: string | null;
        durationSeconds: number | null;
    }>;
};

const dayOptions = [
    { value: "7", label: "7 días" },
    { value: "30", label: "30 días" },
    { value: "90", label: "90 días" },
];

const safeRelative = (isoDate: string): string => {
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return "desconocido";
    return formatDistanceToNowStrict(date, { addSuffix: true });
};

const roleBadge = (role: string) => {
    if (role === "admin") return "bg-primary/12 text-primary border-primary/25";
    if (role === "directores" || role === "staff") return "bg-info/12 text-info border-info/25";
    return "bg-muted text-muted-foreground border-border";
};

export default function AdminActivityDashboard() {
    const [days, setDays] = useState("30");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [summary, setSummary] = useState<ActivitySummaryResponse | null>(null);
    const [events, setEvents] = useState<ActivityEventsResponse | null>(null);
    const [eventFilter, setEventFilter] = useState("all");
    const [userSearch, setUserSearch] = useState("");
    const { t } = useI18n();

    const periodDays = useMemo(() => {
        const parsed = parseInt(days, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
    }, [days]);

    const loadData = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [summaryRes, eventsRes] = await Promise.all([
                fetch(`/api/admin/activity/summary?days=${periodDays}`, { cache: "no-store" }),
                fetch(`/api/admin/activity/events?days=${periodDays}&limit=200`, { cache: "no-store" }),
            ]);
            if (!summaryRes.ok) throw new Error(t("admin.loadSummaryError"));
            if (!eventsRes.ok) throw new Error(t("admin.loadEventsError"));
            setSummary(await summaryRes.json());
            setEvents(await eventsRes.json());
        } catch (err) {
            setError(err instanceof Error ? err.message : "Error cargando datos");
        } finally {
            setLoading(false);
        }
    }, [periodDays]);

    useEffect(() => { void loadData(); }, [loadData]);

    const eventTypes = useMemo(() => {
        if (!events) return [];
        return [...new Set(events.events.map((e) => e.eventType))].sort();
    }, [events]);

    const filteredEvents = useMemo(() => {
        if (!events) return [];
        return events.events.filter((e) => eventFilter === "all" || e.eventType === eventFilter);
    }, [events, eventFilter]);

    const filteredUsers = useMemo(() => {
        if (!summary) return [];
        const q = userSearch.toLowerCase().trim();
        if (!q) return summary.users;
        return summary.users.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
    }, [summary, userSearch]);

    const maxUserEvents = useMemo(() => Math.max(...(summary?.users || []).map((u) => u.totalEvents), 1), [summary]);

    return (
        <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div>
                    <p className="text-sm text-muted-foreground">{t("admin.description")}</p>
                </div>
                <div className="flex items-center gap-2">
                    <Select value={days} onValueChange={setDays}>
                        <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {dayOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                        </SelectContent>
                    </Select>
                    <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
                        <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", loading && "animate-spin")} />
                        Actualizar
                    </Button>
                </div>
            </div>

            {error && <div className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div>}

            {/* KPIs */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <Card className="border-border/70">
                    <CardContent className="p-4 space-y-1">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wider"><Users className="h-3.5 w-3.5" /> {t("admin.uniqueUsers")}</div>
                        <div className="text-2xl font-bold">{summary?.totals.uniqueUsers ?? 0}</div>
                    </CardContent>
                </Card>
                <Card className="border-border/70">
                    <CardContent className="p-4 space-y-1">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wider"><LogIn className="h-3.5 w-3.5" /> {t("admin.sessions")}</div>
                        <div className="text-2xl font-bold">{summary?.totals.sessions ?? 0}</div>
                        <div className="text-[10px] text-muted-foreground">{summary?.totals.logins ?? 0} {t("admin.logins")}</div>
                    </CardContent>
                </Card>
                <Card className="border-border/70">
                    <CardContent className="p-4 space-y-1">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wider"><Clock3 className="h-3.5 w-3.5" /> {t("admin.avgTime")}</div>
                        <div className="text-2xl font-bold">{summary?.totals.avgSessionMinutes ?? 0}m</div>
                    </CardContent>
                </Card>
                <Card className="border-border/70">
                    <CardContent className="p-4 space-y-1">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wider"><Activity className="h-3.5 w-3.5" /> {t("admin.events")}</div>
                        <div className="text-2xl font-bold">{summary?.totals.events ?? 0}</div>
                        <div className="text-[10px] text-muted-foreground">{summary?.totals.pageViews ?? 0} {t("admin.views")} · {summary?.totals.clicks ?? 0} {t("admin.clicks")}</div>
                    </CardContent>
                </Card>
                <Card className="border-border/70">
                    <CardContent className="p-4 space-y-1">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wider"><MousePointerClick className="h-3.5 w-3.5" /> {t("admin.interactions")}</div>
                        <div className="text-2xl font-bold">{summary?.totals.clicks ?? 0}</div>
                    </CardContent>
                </Card>
            </div>

            {/* Activity chart */}
            {summary?.daily && summary.daily.length > 0 && (
                <Card className="border-border/70">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-base">{t("admin.dailyActivity")}</CardTitle>
                        <CardDescription>{t("admin.dailyActivityDesc")}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <ResponsiveContainer width="100%" height={200}>
                            <AreaChart data={summary.daily}>
                                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                                <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v) => v?.slice(5)} />
                                <YAxis tick={{ fontSize: 10 }} />
                                <Tooltip />
                                <Area type="monotone" dataKey="events" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.12)" strokeWidth={2} name="Eventos" />
                                <Area type="monotone" dataKey="users" stroke="hsl(var(--info))" fill="hsl(var(--info) / 0.08)" strokeWidth={1.5} name="Usuarios" />
                                <Area type="monotone" dataKey="sessions" stroke="hsl(var(--success))" fill="hsl(var(--success) / 0.06)" strokeWidth={1.5} name="Sesiones" />
                            </AreaChart>
                        </ResponsiveContainer>
                    </CardContent>
                </Card>
            )}

            {/* Top paths + Top actions */}
            <div className="grid gap-4 lg:grid-cols-2">
                <Card className="border-border/70">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-base">{t("admin.topPaths")}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-1.5">
                            {(summary?.topPaths || []).slice(0, 8).map((p) => (
                                <div key={p.path} className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2">
                                    <span className="text-sm font-mono truncate flex-1 mr-3">{p.path}</span>
                                    <div className="text-xs text-muted-foreground shrink-0">{p.views} · {p.uniqueUsers} users</div>
                                </div>
                            ))}
                        </div>
                    </CardContent>
                </Card>
                <Card className="border-border/70">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-base">{t("admin.topActions")}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-1.5">
                            {(summary?.topActions || []).slice(0, 8).map((a) => (
                                <div key={a.action} className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2">
                                    <span className="text-sm truncate flex-1 mr-3">{a.action}</span>
                                    <Badge variant="outline" className="text-[10px]">{a.count}</Badge>
                                </div>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Users table */}
            <Card className="border-border/70">
                <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                        <CardTitle className="text-base">{t("admin.users")} ({filteredUsers.length})</CardTitle>
                        <div className="relative">
                            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                            <input type="text" placeholder={t("admin.searchUser")} value={userSearch} onChange={(e) => setUserSearch(e.target.value)} className="rounded-md border border-border bg-background py-1.5 pl-8 pr-3 text-xs w-48 focus:outline-none focus:ring-1 focus:ring-ring" />
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="space-y-1.5">
                        {filteredUsers.map((user) => (
                            <div key={user.email} className="flex items-center gap-3 rounded-lg bg-muted/20 px-3 py-2.5">
                                <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary shrink-0">
                                    {user.name?.[0] || "?"}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium truncate">{user.name}</span>
                                        <Badge variant="outline" className={cn("text-[9px] px-1.5", roleBadge(user.role))}>{user.role}</Badge>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground">{user.email} · {safeRelative(user.lastSeen)}</div>
                                </div>
                                <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
                                    <div className="text-right"><div className="font-semibold text-foreground">{user.totalEvents}</div><div>eventos</div></div>
                                    <div className="text-right"><div className="font-semibold text-foreground">{user.totalSessions}</div><div>sesiones</div></div>
                                    <div className="text-right"><div className="font-semibold text-foreground">{user.totalMinutes}m</div><div>tiempo</div></div>
                                    <div className="w-20 h-2 rounded-full bg-muted overflow-hidden">
                                        <div className="h-full bg-primary/60 rounded-full" style={{ width: `${Math.min(100, (user.totalEvents / maxUserEvents) * 100)}%` }} />
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </CardContent>
            </Card>

            {/* Events log */}
            <Card className="border-border/70">
                <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                        <div>
                            <CardTitle className="text-base">{t("admin.eventLog")}</CardTitle>
                            <CardDescription>{events?.total ?? 0} eventos · mostrando {filteredEvents.length}</CardDescription>
                        </div>
                        <Select value={eventFilter} onValueChange={setEventFilter}>
                            <SelectTrigger className="w-[160px]"><SelectValue placeholder="Tipo de evento" /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">Todos</SelectItem>
                                {eventTypes.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="space-y-1 max-h-[500px] overflow-y-auto">
                        {filteredEvents.slice(0, 100).map((event) => (
                            <div key={event.id} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted/20 transition-colors text-xs">
                                <div className="w-24 shrink-0 text-muted-foreground">{safeRelative(event.occurredAt)}</div>
                                <div className="w-32 shrink-0">
                                    <div className="font-medium text-foreground truncate">{event.userName}</div>
                                    <div className="text-[10px] text-muted-foreground">{event.userRole}</div>
                                </div>
                                <Badge variant="outline" className="text-[9px] shrink-0">{event.eventType}</Badge>
                                <div className="flex-1 truncate text-muted-foreground">{event.action || event.path || "—"}</div>
                                {event.durationSeconds !== null && <div className="shrink-0 text-muted-foreground">{event.durationSeconds}s</div>}
                            </div>
                        ))}
                        {filteredEvents.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">{t("admin.noEvents")}</div>}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
