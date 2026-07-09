"use client";

import Link from "next/link";
import { Database, HardDrive, Shield, Cpu } from "lucide-react";
import { cn } from "@/lib/utils";

interface RecentRequest {
  id: number;
  resource_type: string;
  team: string;
  status: string;
  created_at: string;
}

const RESOURCE_ICONS: Record<string, typeof Database> = {
  rds: Database,
  s3: HardDrive,
  iam_role: Shield,
  lambda: Cpu,
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-500",
  approved: "bg-green-500",
  rejected: "bg-red-500",
  cancelled: "bg-gray-400",
  executed: "bg-blue-500",
  execute_failed: "bg-red-500",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pendiente",
  approved: "Aprobada",
  rejected: "Rechazada",
  cancelled: "Cancelada",
  executed: "Ejecutada",
  execute_failed: "Error",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `hace ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.floor(hours / 24);
  return `hace ${days}d`;
}

export function RecentRequests({ requests }: { requests: RecentRequest[] }) {
  if (requests.length === 0) return null;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground">
        Solicitudes recientes
      </h3>
      <div className="space-y-2">
        {requests.map((req) => {
          const Icon = RESOURCE_ICONS[req.resource_type] || Database;
          const statusColor = STATUS_COLORS[req.status] || "bg-gray-400";
          const statusLabel = STATUS_LABELS[req.status] || req.status;

          return (
            <Link
              key={req.id}
              href="/infra-requests"
              className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted/50 transition-colors"
            >
              <div className="shrink-0 rounded-lg bg-primary/10 p-2">
                <Icon className="h-4 w-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-foreground">
                    {req.resource_type.toUpperCase()}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {req.team}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className="flex items-center gap-1.5">
                  <div className={cn("w-2 h-2 rounded-full", statusColor)} />
                  <span className="text-[11px] text-muted-foreground">
                    {statusLabel}
                  </span>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {timeAgo(req.created_at)}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
