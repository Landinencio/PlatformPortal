"use client";

import { cn } from "@/lib/utils";

function miniStatToneClass(tone: "default" | "success" | "warning" | "danger" | "info") {
  switch (tone) {
    case "success":
      return "border-success/25 bg-success/8";
    case "warning":
      return "border-warning/25 bg-warning/8";
    case "danger":
      return "border-danger/25 bg-danger/8";
    case "info":
      return "border-info/25 bg-info/8";
    default:
      return "border-border/70 bg-background/80";
  }
}

function trendStateClass(value: number, inverse = false) {
  if (value === 0) return "bg-muted text-muted-foreground";
  const isPositive = inverse ? value < 0 : value > 0;
  return isPositive ? "bg-success/12 text-success" : "bg-danger/12 text-danger";
}

function signed(value: number, suffix = "") {
  if (value > 0) return `+${value.toFixed(1)}${suffix}`;
  return `${value.toFixed(1)}${suffix}`;
}

export function MiniStat({
  label,
  value,
  tone = "default",
  tooltip,
  trend,
  inverse = false,
}: {
  label: string;
  value: string;
  tone?: "default" | "success" | "warning" | "danger" | "info";
  tooltip?: string;
  trend?: number;
  inverse?: boolean;
}) {
  return (
    <div className={cn("rounded-2xl border px-3 py-3", miniStatToneClass(tone))} title={tooltip}>
      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className="mt-2 text-lg font-semibold">{value}</div>
      {trend !== undefined ? (
        <div className={cn("mt-2 inline-flex rounded-full px-2 py-0.5 text-xs font-semibold", trendStateClass(trend, inverse))}>
          {signed(trend, "%")}
        </div>
      ) : null}
    </div>
  );
}
