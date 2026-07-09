"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    RefreshCcw,
    Download,
    ExternalLink,
    ShieldAlert,
    ShieldCheck,
    Activity,
    AlertTriangle,
    CheckCircle2,
    XCircle,
    Timer,
    Signal,
    Gauge,
} from "lucide-react";
import { AreaChart, Area, ResponsiveContainer, Tooltip } from 'recharts';
import { format } from 'date-fns';
import ExternalStatusWidget from './external-status';
import { MonitorDetailDialog } from './monitor-detail-dialog';
import MonitorManagement from './monitor-management';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

type MonitorStatus = 'UP' | 'DOWN' | 'DEGRADED' | 'UNKNOWN';

interface RecentCheck {
    time: string;
    status: 'UP' | 'DOWN';
    statusCode: number | null;
    totalMs: number | null;
    ttfbMs: number | null;
    dnsMs: number | null;
    tcpMs: number | null;
    tlsMs: number | null;
    errorKind: string | null;
    errorMessage: string | null;
    region?: string | null;
    reachable: boolean;
}

interface SyntheticMonitor {
    id: number;
    name: string;
    url: string;
    status: MonitorStatus;
    lastCheck: string | null;
    responseTime: number;
    ttfb: number | null;
    sslDays: number | null;
    availability: string;
    reachability: string;
    p95: number | null;
    p99: number | null;
    consecutiveUpDuration?: string;
    sla?: {
        availability30d: number;
        slaTier: string;
        totalChecks30d: number;
        downChecks30d: number;
        estimatedDowntimeMinutes: number;
    };
    history: { time: string; val: number; up: boolean; reachable: boolean }[];
    errorBreakdown: Record<string, number>;
    lastError: { kind: string | null; message: string | null; at: string } | null;
    recentChecks: RecentCheck[];
}

const statusBadge = (status: MonitorStatus) => {
    switch (status) {
        case 'UP':
            return 'border-success/30 bg-success/10 text-success';
        case 'DEGRADED':
            return 'border-warning/30 bg-warning/10 text-warning';
        case 'DOWN':
            return 'border-danger/30 bg-danger/10 text-danger';
        default:
            return 'border-border bg-muted text-muted-foreground';
    }
};

const statusIcon = (status: MonitorStatus) => {
    switch (status) {
        case 'UP':
            return <CheckCircle2 className="h-4 w-4 text-success" />;
        case 'DEGRADED':
            return <AlertTriangle className="h-4 w-4 text-warning" />;
        case 'DOWN':
            return <XCircle className="h-4 w-4 text-danger" />;
        default:
            return <Signal className="h-4 w-4 text-muted-foreground" />;
    }
};

const humanizeStatus = (status: MonitorStatus) => {
    switch (status) {
        case 'UP':
            return 'Operativo';
        case 'DEGRADED':
            return 'Degradado';
        case 'DOWN':
            return 'Caído';
        default:
            return 'Desconocido';
    }
};

const formatMs = (value?: number | null) => {
    if (value === null || value === undefined || Number.isNaN(value)) return '-';
    return `${Math.round(value)}ms`;
};

const formatPercent = (value?: string | number | null) => {
    if (value === null || value === undefined || value === '') return '-';
    const num = typeof value === 'string' ? Number(value) : value;
    if (Number.isNaN(num)) return '-';
    return `${num.toFixed(2)}%`;
};

const formatDuration = (ms: number) => {
    if (!ms || ms < 0) return '-';
    const minutes = Math.floor(ms / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
};

export default function SyntheticDashboard() {
    const [monitors, setMonitors] = useState<SyntheticMonitor[]>([]);
    const [loading, setLoading] = useState(true);
    const { t } = useI18n();
    const [refreshing, setRefreshing] = useState(false);
    const [timeRange, setTimeRange] = useState('24h');

    // Detail Dialog State
    const [selectedMonitor, setSelectedMonitor] = useState<SyntheticMonitor | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);

    const fetchStats = async () => {
        try {
            const res = await fetch(`/api/synthetics/stats?range=${timeRange}`);
            if (res.ok) {
                const data = await res.json();
                setMonitors(data);
            }
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    const runChecks = async () => {
        setRefreshing(true);
        try {
            await fetch('/api/synthetics/run', { method: 'POST' });
            setTimeout(fetchStats, 1000);
        } catch (error) {
            console.error(error);
        } finally {
            setRefreshing(false);
        }
    };

    useEffect(() => {
        setLoading(true);
        fetchStats();
        let interval: NodeJS.Timeout;
        if (timeRange === '24h') {
            interval = setInterval(fetchStats, 30000);
        }
        return () => clearInterval(interval);
    }, [timeRange]);

    const handleCardClick = (monitor: SyntheticMonitor) => {
        setSelectedMonitor(monitor);
        setDetailOpen(true);
    };

    const summary = useMemo(() => {
        const total = monitors.length;
        const up = monitors.filter((m) => m.status === 'UP').length;
        const degraded = monitors.filter((m) => m.status === 'DEGRADED').length;
        const down = monitors.filter((m) => m.status === 'DOWN').length;

        const availabilityAvg = total
            ? monitors.reduce((acc, m) => acc + Number(m.availability || 0), 0) / total
            : 0;
        const reachabilityAvg = total
            ? monitors.reduce((acc, m) => acc + Number(m.reachability || 0), 0) / total
            : 0;
        const p95Avg = total
            ? monitors.reduce((acc, m) => acc + Number(m.p95 || m.responseTime || 0), 0) / total
            : 0;

        // SLA: average 30-day availability across all monitors
        const slaAvg = total
            ? monitors.reduce((acc, m) => acc + (m.sla?.availability30d ?? Number(m.availability || 100)), 0) / total
            : 100;
        const worstSla = monitors.reduce((worst, m) => {
            const val = m.sla?.availability30d ?? 100;
            return val < worst.value ? { name: m.name, value: val, tier: m.sla?.slaTier || "N/A" } : worst;
        }, { name: "", value: 100, tier: "N/A" });

        return {
            total,
            up,
            degraded,
            down,
            availabilityAvg,
            reachabilityAvg,
            slaAvg,
            worstSla,
            p95Avg,
            incidents: degraded + down,
        };
    }, [monitors]);

    const incidents = useMemo(() => {
        const items = monitors
            .filter((monitor) => monitor.status !== 'UP' && monitor.lastError?.at)
            .map((monitor) => {
                const start = new Date(monitor.lastError!.at);
                return {
                    id: monitor.id,
                    name: monitor.name,
                    status: monitor.status,
                    start,
                    durationMs: Date.now() - start.getTime(),
                    kind: monitor.lastError?.kind || 'UNKNOWN',
                };
            });

        return items.sort((a, b) => b.start.getTime() - a.start.getTime()).slice(0, 5);
    }, [monitors]);

    if (loading && monitors.length === 0) return (
        <div className="flex items-center justify-center min-h-[400px]">
            <RefreshCcw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
    );

    return (
        <div className="space-y-6 animate-in fade-in duration-500 pb-10">
            {/* Header Section */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <div className="flex items-center gap-3">
                        <h2 className="text-3xl font-bold tracking-tight text-foreground">Monitorización sintética</h2>
                        <Badge variant="outline" className="text-xs border-border">Reachability v3</Badge>
                    </div>
                    <p className="text-muted-foreground mt-1">
                        Disponibilidad, alcanzabilidad por capa y señales de rendimiento sobre las propiedades web críticas.
                    </p>
                </div>
                <div className="flex flex-col sm:flex-row gap-3 items-end sm:items-center">
                    <Tabs value={timeRange} onValueChange={setTimeRange} className="w-[300px]">
                        <TabsList className="grid w-full grid-cols-3">
                            <TabsTrigger value="24h">24h</TabsTrigger>
                            <TabsTrigger value="7d">7d</TabsTrigger>
                            <TabsTrigger value="30d">30d</TabsTrigger>
                        </TabsList>
                    </Tabs>

                    <div className="flex gap-2">
                        <Button variant="outline" onClick={runChecks} disabled={refreshing}>
                            <RefreshCcw className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                            {refreshing ? t("synthetics.running") : t("synthetics.runChecks")}
                        </Button>
                        <Button variant="secondary" onClick={() => window.open('/api/synthetics/export', '_blank')}>
                            <Download className="mr-2 h-4 w-4" />
                            {t("common.export")}
                        </Button>
                    </div>
                </div>
            </div>

            {/* KPI Summary */}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
                <Card>
                    <CardContent className="p-4 space-y-2">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">{t("synthetics.serviceStatus")}</div>
                        <div className="text-2xl font-bold text-foreground">
                            {summary.up}/{summary.total}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="h-3 w-3" /> {t("synthetics.operational")}</span>
                            <span className="inline-flex items-center gap-1 text-warning"><AlertTriangle className="h-3 w-3" /> {t("synthetics.degraded")}</span>
                            <span className="inline-flex items-center gap-1 text-danger"><XCircle className="h-3 w-3" /> {t("synthetics.down")}</span>
                        </div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="p-4 space-y-2">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">{t("synthetics.avgAvailability")}</div>
                        <div className="text-2xl font-bold text-foreground">{summary.availabilityAvg.toFixed(2)}%</div>
                        <div className="text-xs text-muted-foreground">{t("synthetics.calculatedOver")} {timeRange}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="p-4 space-y-2">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">{t("synthetics.avgReachability")}</div>
                        <div className="text-2xl font-bold text-foreground">{summary.reachabilityAvg.toFixed(2)}%</div>
                        <div className="text-xs text-muted-foreground">DNS + TCP + TLS</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="p-4 space-y-2">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">{t("synthetics.p95Latency")}</div>
                        <div className="text-2xl font-bold text-foreground">{formatMs(summary.p95Avg)}</div>
                        <div className="text-xs text-muted-foreground">Pico percibido por el usuario</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="p-4 space-y-2">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">{t("synthetics.activeIncidents")}</div>
                        <div className={cn("text-2xl font-bold", summary.incidents > 0 ? "text-danger" : "text-foreground")}>
                            {summary.incidents}
                        </div>
                        <div className="text-xs text-muted-foreground">Caídos + degradados</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="p-4 space-y-2">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">{t("synthetics.sla30d")}</div>
                        <div className={cn("text-2xl font-bold", summary.slaAvg >= 99.9 ? "text-success" : summary.slaAvg >= 99.0 ? "text-warning" : "text-danger")}>
                            {summary.slaAvg.toFixed(2)}%
                        </div>
                        <div className="text-xs text-muted-foreground">
                            {summary.worstSla.name ? `${t("synthetics.worst")}: ${summary.worstSla.name} (${summary.worstSla.tier})` : t("common.noData")}
                        </div>
                    </CardContent>
                </Card>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-4 gap-6 items-start">
                {/* Main Content */}
                <div className="xl:col-span-3 space-y-6">
                    <Card>
                        <CardHeader className="pb-3">
                            <div className="flex items-center justify-between">
                                <div>
                                    <CardTitle className="text-lg">{t("synthetics.monitorStatus")}</CardTitle>
                                    <CardDescription>{t("synthetics.monitorStatusDesc")}</CardDescription>
                                </div>
                                <Gauge className="h-4 w-4 text-muted-foreground" />
                            </div>
                        </CardHeader>
                        <CardContent>
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Monitor</TableHead>
                                        <TableHead>Estado</TableHead>
                                        <TableHead>{t("synthetics.availability")}</TableHead>
                                        <TableHead className="text-right">{t("synthetics.sla30d")}</TableHead>
                                        <TableHead className="text-right">{t("synthetics.reachability")}</TableHead>
                                        <TableHead className="text-right">P95</TableHead>
                                        <TableHead className="text-right">{t("synthetics.lastCheck")}</TableHead>
                                        <TableHead className="text-right">SSL</TableHead>
                                        <TableHead className="text-right">{t("synthetics.lastCheck")}</TableHead>
                                        <TableHead className="text-right">{t("synthetics.trend")}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {monitors.map((monitor) => (
                                        <TableRow key={monitor.id} onClick={() => handleCardClick(monitor)} className="cursor-pointer hover:bg-muted/40">
                                            <TableCell>
                                                <div className="font-medium text-foreground flex items-center gap-2">
                                                    {statusIcon(monitor.status)}
                                                    <span>{monitor.name}</span>
                                                </div>
                                                <div className="text-xs text-muted-foreground truncate max-w-[240px]">{monitor.url}</div>
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant="outline" className={cn("text-xs", statusBadge(monitor.status))}>
                                                    {humanizeStatus(monitor.status)}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="text-right font-mono text-xs">
                                                {formatPercent(monitor.availability)}
                                            </TableCell>
                                            <TableCell className="text-right font-mono text-xs">
                                                <span className={cn(
                                                    (monitor.sla?.availability30d ?? 100) >= 99.9 ? "text-success" :
                                                    (monitor.sla?.availability30d ?? 100) >= 99.0 ? "text-warning" : "text-danger"
                                                )}>
                                                    {monitor.sla?.slaTier || "N/A"}
                                                </span>
                                            </TableCell>
                                            <TableCell className="text-right font-mono text-xs">
                                                {formatPercent(monitor.reachability)}
                                            </TableCell>
                                            <TableCell className="text-right font-mono text-xs">
                                                {monitor.p95 ? `${monitor.p95}ms` : '-'}
                                            </TableCell>
                                            <TableCell className="text-right font-mono text-xs">
                                                {formatMs(monitor.responseTime)}
                                            </TableCell>
                                            <TableCell className="text-right text-xs">
                                                <div className="flex items-center justify-end gap-1">
                                                    {(monitor.sslDays || 0) < 30 ? (
                                                        <ShieldAlert className="h-3 w-3 text-warning" />
                                                    ) : (
                                                        <ShieldCheck className="h-3 w-3 text-success" />
                                                    )}
                                                    <span>{monitor.sslDays ?? '-'} d</span>
                                                </div>
                                            </TableCell>
                                            <TableCell className="text-right text-xs text-muted-foreground">
                                                {monitor.lastCheck ? format(new Date(monitor.lastCheck), 'MMM dd HH:mm') : '-'}
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <div className="h-[26px] w-[80px]">
                                                    <ResponsiveContainer width="100%" height="100%">
                                                        <AreaChart data={monitor.history}>
                                                            <defs>
                                                                <linearGradient id={`grad${monitor.id}`} x1="0" y1="0" x2="0" y2="1">
                                                                    <stop offset="5%" stopColor={monitor.status === 'UP' ? "hsl(var(--success))" : monitor.status === 'DEGRADED' ? "hsl(var(--warning))" : "hsl(var(--danger))"} stopOpacity={0.2} />
                                                                    <stop offset="95%" stopColor={monitor.status === 'UP' ? "hsl(var(--success))" : monitor.status === 'DEGRADED' ? "hsl(var(--warning))" : "hsl(var(--danger))"} stopOpacity={0} />
                                                                </linearGradient>
                                                            </defs>
                                                            <Area
                                                                type="monotone"
                                                                dataKey="val"
                                                                stroke={monitor.status === 'UP' ? "hsl(var(--success))" : monitor.status === 'DEGRADED' ? "hsl(var(--warning))" : "hsl(var(--danger))"}
                                                                fill={`url(#grad${monitor.id})`}
                                                                strokeWidth={1.5}
                                                                isAnimationActive={false}
                                                            />
                                                        </AreaChart>
                                                    </ResponsiveContainer>
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <div>
                                    <CardTitle className="text-lg">Notas operativas</CardTitle>
                                    <CardDescription>Últimas señales de error y postura de alcanzabilidad.</CardDescription>
                                </div>
                                <ExternalLink className="h-4 w-4 text-muted-foreground" />
                            </div>
                        </CardHeader>
                        <CardContent className="grid md:grid-cols-2 gap-4">
                            {monitors.map((monitor) => (
                                <div key={monitor.id} className="rounded-lg border bg-background/60 p-4 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <div className="font-medium text-foreground">{monitor.name}</div>
                                        <Badge variant="outline" className={cn("text-xs", statusBadge(monitor.status))}>
                                            {humanizeStatus(monitor.status)}
                                        </Badge>
                                    </div>
                                    <div className="text-xs text-muted-foreground">{monitor.url}</div>
                                    <div className="flex flex-wrap gap-2 text-xs">
                                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                                            <Timer className="h-3 w-3" />
                                            P95: {monitor.p95 ? `${monitor.p95}ms` : '-'}
                                        </span>
                                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                                            <Signal className="h-3 w-3" />
                                            Alcanzabilidad: {formatPercent(monitor.reachability)}
                                        </span>
                                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                                            <Activity className="h-3 w-3" />
                                            Disponibilidad: {formatPercent(monitor.availability)}
                                        </span>
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                        {monitor.lastError
                                            ? `${monitor.lastError.kind || 'UNKNOWN'}: ${monitor.lastError.message || 'Sin detalle'}`
                                            : 'Sin errores recientes.'}
                                    </div>
                                    <Button variant="ghost" size="sm" className="px-0" onClick={() => handleCardClick(monitor)}>
                                        Ver detalle
                                    </Button>
                                </div>
                            ))}
                        </CardContent>
                    </Card>
                </div>

                {/* Sidebar */}
                <div className="xl:col-span-1 space-y-6 self-start">
                    <Card>
                        <CardHeader className="pb-3">
                            <div className="flex items-center justify-between">
                                <CardTitle className="text-sm font-medium">Resumen de incidentes</CardTitle>
                                <AlertTriangle className="h-4 w-4 text-warning" />
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {incidents.length === 0 && (
                                <div className="text-xs text-muted-foreground">No se han detectado incidentes en la ventana seleccionada.</div>
                            )}
                            {incidents.map((incident) => (
                                <div key={incident.id} className="rounded-lg border bg-background/60 p-3">
                                    <div className="flex items-center justify-between">
                                        <div className="text-sm font-medium">{incident.name}</div>
                                        <Badge variant="outline" className={cn("text-[10px]", statusBadge(incident.status))}>
                                            {humanizeStatus(incident.status)}
                                        </Badge>
                                    </div>
                                    <div className="mt-1 text-xs text-muted-foreground">{incident.kind}</div>
                                    <div className="mt-1 text-xs text-muted-foreground">
                                        Inicio: {format(incident.start, 'MMM dd HH:mm')}
                                    </div>
                                    <div className="mt-1 text-xs text-muted-foreground">
                                        Duración: {formatDuration(incident.durationMs)}
                                    </div>
                                </div>
                            ))}
                        </CardContent>
                    </Card>
                    <ExternalStatusWidget />
                </div>
            </div>

            <MonitorManagement />

            {/* Dialog Component */}
            <MonitorDetailDialog
                monitor={selectedMonitor}
                open={detailOpen}
                onOpenChange={setDetailOpen}
                timeRange={timeRange}
            />
        </div>
    );
}
