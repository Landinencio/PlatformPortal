"use client";

import React from 'react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { format } from 'date-fns';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Activity, Clock, ShieldAlert, ShieldCheck, Signal, Timer } from "lucide-react";
import { cn } from '@/lib/utils';

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

interface MonitorDetailProps {
    monitor: {
        id: number;
        name: string;
        url: string;
        status: MonitorStatus;
        responseTime: number;
        ttfb: number | null;
        sslDays: number | null;
        availability: string;
        reachability: string;
        p95: number | null;
        p99: number | null;
        consecutiveUpDuration?: string;
        history: { time: string; val: number; up: boolean; reachable: boolean }[];
        recentChecks: RecentCheck[];
        errorBreakdown: Record<string, number>;
    } | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    timeRange: string;
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

const formatMs = (value?: number | null) => {
    if (value === null || value === undefined || Number.isNaN(value)) return '-';
    return `${Math.round(value)}ms`;
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

export function MonitorDetailDialog({ monitor, open, onOpenChange, timeRange }: MonitorDetailProps) {
    if (!monitor) return null;

    const latestCheck = monitor.recentChecks?.[0];
    const errorEntries = Object.entries(monitor.errorBreakdown || {}).sort((a, b) => b[1] - a[1]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
                <DialogHeader>
                    <div className="flex items-center justify-between pr-8">
                        <div>
                            <DialogTitle className="text-2xl flex items-center gap-2">
                                {monitor.name}
                                <Badge className={cn("text-xs", statusBadge(monitor.status))} variant="outline">
                                    {humanizeStatus(monitor.status)}
                                </Badge>
                            </DialogTitle>
                            <DialogDescription className="mt-1">
                                {monitor.url}
                            </DialogDescription>
                        </div>
                    </div>
                </DialogHeader>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-4">
                    <div className="p-4 bg-muted/30 rounded-lg border">
                        <div className="text-xs text-muted-foreground uppercase mb-1">Disponibilidad ({timeRange})</div>
                        <div className="text-2xl font-bold flex items-center gap-2">
                            <Activity className="h-5 w-5 text-muted-foreground" />
                            {monitor.availability}%
                        </div>
                    </div>
                    <div className="p-4 bg-muted/30 rounded-lg border">
                        <div className="text-xs text-muted-foreground uppercase mb-1">Alcanzabilidad</div>
                        <div className="text-2xl font-bold flex items-center gap-2">
                            <Signal className="h-5 w-5 text-muted-foreground" />
                            {monitor.reachability}%
                        </div>
                    </div>
                    <div className="p-4 bg-muted/30 rounded-lg border">
                        <div className="text-xs text-muted-foreground uppercase mb-1">P95 / P99</div>
                        <div className="text-2xl font-bold flex items-center gap-2">
                            <Timer className="h-5 w-5 text-muted-foreground" />
                            {monitor.p95 ? `${monitor.p95}ms` : '-'} / {monitor.p99 ? `${monitor.p99}ms` : '-'}
                        </div>
                    </div>
                    <div className="p-4 bg-muted/30 rounded-lg border">
                        <div className="text-xs text-muted-foreground uppercase mb-1">Última latencia</div>
                        <div className="text-2xl font-bold flex items-center gap-2">
                            <Clock className="h-5 w-5 text-muted-foreground" />
                            {formatMs(monitor.responseTime)}
                        </div>
                    </div>
                    <div className="p-4 bg-muted/30 rounded-lg border">
                        <div className="text-xs text-muted-foreground uppercase mb-1">TTFB</div>
                        <div className="text-2xl font-bold">{formatMs(monitor.ttfb)}</div>
                    </div>
                    <div className="p-4 bg-muted/30 rounded-lg border">
                        <div className="text-xs text-muted-foreground uppercase mb-1">Estado SSL</div>
                        <div className={cn("text-2xl font-bold flex items-center gap-2", (monitor.sslDays || 0) < 30 ? "text-warning" : "text-foreground")}>
                            {(monitor.sslDays || 0) < 30 ? <ShieldAlert className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5 text-success" />}
                            {monitor.sslDays ?? '-'} días
                        </div>
                    </div>
                    <div className="p-4 bg-muted/30 rounded-lg border">
                        <div className="text-xs text-muted-foreground uppercase mb-1">Tiempo operativo continuado</div>
                        <div className="text-xl font-bold text-info">
                            {monitor.consecutiveUpDuration || '-'}
                        </div>
                    </div>
                    <div className="p-4 bg-muted/30 rounded-lg border">
                        <div className="text-xs text-muted-foreground uppercase mb-1">Tiempos por fase</div>
                        <div className="text-xs text-muted-foreground space-y-1">
                            <div>DNS: {formatMs(latestCheck?.dnsMs)}</div>
                            <div>TCP: {formatMs(latestCheck?.tcpMs)}</div>
                            <div>TLS: {formatMs(latestCheck?.tlsMs)}</div>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    <div className="lg:col-span-2 h-[260px] w-full border rounded-lg p-4 bg-background">
                        <h4 className="text-sm font-medium mb-4">Histórico de tiempo de respuesta</h4>
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={monitor.history}>
                                <defs>
                                    <linearGradient id={`gradDetail${monitor.id}`} x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="hsl(var(--info))" stopOpacity={0.2} />
                                        <stop offset="95%" stopColor="hsl(var(--info))" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                                <XAxis
                                    dataKey="time"
                                    tickFormatter={(t) => format(new Date(t), 'HH:mm')}
                                    stroke="hsl(var(--muted-foreground))"
                                    fontSize={12}
                                />
                                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                                <Tooltip
                                    contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                                    labelFormatter={(t) => format(new Date(t), 'PP pp')}
                                />
                                <Area
                                    type="monotone"
                                    dataKey="val"
                                    stroke="hsl(var(--info))"
                                    fill={`url(#gradDetail${monitor.id})`}
                                    strokeWidth={2}
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>

                    <div className="border rounded-lg p-4 bg-background">
                        <h4 className="text-sm font-medium mb-3">Desglose de errores</h4>
                        {errorEntries.length === 0 && (
                            <div className="text-xs text-muted-foreground">No se han detectado errores en la ventana seleccionada.</div>
                        )}
                        <div className="space-y-2">
                            {errorEntries.map(([kind, count]) => (
                                <div key={kind} className="flex items-center justify-between text-xs">
                                    <span className="uppercase text-muted-foreground">{kind}</span>
                                    <span className="font-semibold text-foreground">{count}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <ScrollArea className="mt-4 h-[220px] border rounded-lg">
                    <Table>
                        <TableHeader className="bg-muted/40 sticky top-0">
                            <TableRow>
                                <TableHead>Hora</TableHead>
                                <TableHead>Estado</TableHead>
                                <TableHead>Alcanzable</TableHead>
                                <TableHead>Latencia</TableHead>
                                <TableHead>DNS</TableHead>
                                <TableHead>TCP</TableHead>
                                <TableHead>TLS</TableHead>
                                <TableHead>Región</TableHead>
                                <TableHead>Error</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {monitor.recentChecks.map((point, i) => (
                                <TableRow key={i}>
                                    <TableCell className="font-mono text-xs">
                                        {format(new Date(point.time), 'yyyy-MM-dd HH:mm:ss')}
                                    </TableCell>
                                    <TableCell>
                                        <Badge variant="outline" className={cn("text-[10px]", point.status === 'UP' ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger')}>
                                            {point.status === 'UP' ? 'Operativo' : 'Caído'}
                                        </Badge>
                                    </TableCell>
                                    <TableCell className="text-xs">
                                        {point.reachable ? 'Sí' : 'No'}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">{formatMs(point.totalMs)}</TableCell>
                                    <TableCell className="font-mono text-xs">{formatMs(point.dnsMs)}</TableCell>
                                    <TableCell className="font-mono text-xs">{formatMs(point.tcpMs)}</TableCell>
                                    <TableCell className="font-mono text-xs">{formatMs(point.tlsMs)}</TableCell>
                                    <TableCell className="text-xs text-muted-foreground">{point.region || '-'}</TableCell>
                                    <TableCell className="text-xs text-muted-foreground">
                                        {point.errorKind ? `${point.errorKind}: ${point.errorMessage || ''}` : '-'}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </ScrollArea>
            </DialogContent>
        </Dialog>
    );
}
