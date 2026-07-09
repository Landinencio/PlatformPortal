"use client";

import { Card, CardContent } from "@/components/ui/card";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";

function signed(value: number, suffix = "") {
  if (value > 0) return `+${value.toFixed(1)}${suffix}`;
  return `${value.toFixed(1)}${suffix}`;
}

function trendStateClass(value: number, inverse = false) {
  if (value === 0) return "bg-muted text-muted-foreground";
  const isPositive = inverse ? value < 0 : value > 0;
  return isPositive
    ? "bg-success/12 text-success"
    : "bg-danger/12 text-danger";
}

export function MetricCard({
  title,
  value,
  subtitle,
  trend,
  inverse = false,
  icon: Icon,
  explanation,
  badge,
}: {
  title: string;
  value: string;
  subtitle: string;
  trend?: number;
  inverse?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  explanation?: string;
  badge?: React.ReactNode;
}) {
  const trendState = trendStateClass(trend ?? 0, inverse);

  return (
    <Card
      className="relative overflow-hidden border-border/70 bg-[linear-gradient(180deg,hsl(var(--card))_0%,hsl(var(--card)/0.95)_100%)] shadow-[0_18px_50px_-36px_rgba(75,42,19,0.55)]"
      title={explanation}
    >
      <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-primary/35 to-transparent" />
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-muted-foreground">{title}</span>
              {badge}
            </div>
            <div className="mt-3 font-display text-3xl font-semibold tracking-tight">{value}</div>
          </div>
          <div className={cn(
            "rounded-2xl border p-3 shadow-sm",
            inverse
              ? "border-warning/25 bg-warning/10"
              : "border-primary/20 bg-primary/10"
          )}>
            <Icon className={cn("h-5 w-5", inverse ? "text-warning" : "text-primary")} />
          </div>
        </div>
        <div className="flex items-end justify-between gap-3">
          <div className="text-xs leading-5 text-muted-foreground">{subtitle}</div>
          {trend !== undefined ? (
            <div className={cn("inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold", trendState)}>
              {trend > 0 ? <ArrowUp className="h-3.5 w-3.5" /> : trend < 0 ? <ArrowDown className="h-3.5 w-3.5" /> : null}
              {signed(trend, "%")}
            </div>
          ) : null}
        </div>
        {explanation && (
          <div className="border-t border-border/50 pt-3 text-xs text-muted-foreground/80">
            {explanation}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
