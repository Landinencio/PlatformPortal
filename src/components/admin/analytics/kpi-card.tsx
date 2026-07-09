"use client";

import { Card } from "@/components/ui/card";
import { TrendIndicator } from "./trend-indicator";
import type { TrendData } from "@/lib/admin-analytics";
import type { ComponentType } from "react";

interface KpiCardProps {
  label: string;
  value: number | string;
  icon: ComponentType<{ className?: string }>;
  trend: TrendData | null;
}

export function KpiCard({ label, value, icon: Icon, trend }: KpiCardProps) {
  return (
    <Card className="p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</span>
        <Icon className="h-4 w-4 text-muted-foreground/60" />
      </div>
      <div className="flex items-end justify-between">
        <span className="text-2xl font-bold text-foreground">{typeof value === "number" ? value.toLocaleString("es-ES") : value}</span>
        {trend && <TrendIndicator trend={trend} />}
      </div>
    </Card>
  );
}
