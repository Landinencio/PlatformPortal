"use client";

import { TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TrendData } from "@/lib/admin-analytics";

interface TrendIndicatorProps {
  trend: TrendData;
}

export function TrendIndicator({ trend }: TrendIndicatorProps) {
  if (trend.isNew) {
    return (
      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
        Nuevo
      </span>
    );
  }

  if (trend.percentChange === null) return null;

  const isPositive = trend.percentChange > 0;
  const isZero = trend.percentChange === 0;

  if (isZero) {
    return (
      <span className="text-[11px] text-muted-foreground">0%</span>
    );
  }

  return (
    <span className={cn(
      "inline-flex items-center gap-0.5 text-[11px] font-medium",
      isPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
    )}>
      {isPositive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {isPositive ? "+" : ""}{trend.percentChange}%
    </span>
  );
}
