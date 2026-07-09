"use client";

import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, XCircle, AlertTriangle, ExternalLink, Globe } from "lucide-react";

interface StatusItem {
    id: string;
    name: string;
    status: 'UP' | 'DOWN' | 'DEGRADED' | 'UNKNOWN';
    description: string;
    url: string;
}

function humanizeStatus(status: StatusItem["status"]) {
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
}

export default function ExternalStatusWidget() {
    const [statuses, setStatuses] = useState<StatusItem[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchStatus = async () => {
            try {
                const res = await fetch('/api/synthetics/external-status');
                if (res.ok) {
                    const data = await res.json();
                    setStatuses(data);
                }
            } catch (error) {
                console.error("Failed to fetch external status", error);
            } finally {
                setLoading(false);
            }
        };

        fetchStatus();
        // Refresh every 5 minutes
        const interval = setInterval(fetchStatus, 300000);
        return () => clearInterval(interval);
    }, []);

    const getIcon = (status: string) => {
        switch (status) {
            case 'UP': return <CheckCircle2 className="h-4 w-4 text-success" />;
            case 'DEGRADED': return <AlertTriangle className="h-4 w-4 text-warning" />;
            case 'DOWN': return <XCircle className="h-4 w-4 text-danger" />;
            default: return <Globe className="h-4 w-4 text-muted-foreground" />;
        }
    };

    return (
        <Card className="h-full">
            <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Globe className="h-4 w-4" />
                    Servicios externos
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                {loading ? (
                    <div className="text-sm text-muted-foreground animate-pulse">Comprobando servicios...</div>
                ) : (
                    statuses.map((item) => (
                        <div key={item.id} className="flex items-center justify-between border-b pb-2 last:border-0 last:pb-0">
                            <div className="flex items-center gap-2">
                                {getIcon(item.status)}
                                <div>
                                    <div className="text-sm font-medium leading-none">{item.name}</div>
                                    <div className="text-[10px] text-muted-foreground mt-1 truncate max-w-[120px]" title={item.description}>
                                        {item.status === 'UP' ? humanizeStatus(item.status) : item.description}
                                    </div>
                                </div>
                            </div>
                            <a href={item.url} target="_blank" rel="noreferrer" className="opacity-50 hover:opacity-100">
                                <ExternalLink className="h-3 w-3" />
                            </a>
                        </div>
                    ))
                )}
            </CardContent>
        </Card>
    );
}
