"use client";

/**
 * KpiBar — top-line KPIs for the EKS Cost Optimization dashboard.
 *
 * Layout: one "hero" gradient card for the monthly EKS cost (the whole
 * point of the dashboard) plus four supporting KPIs with lucide icons,
 * background accents and contextual sub-lines. The hero card also carries
 * a ring progress that shows the potential savings share of the total
 * spend at a glance.
 *
 * Every value is rendered via `formatEurK` for a compact, dashboard-friendly
 * look. Non-finite / zero values collapse gracefully to `"—"` / `"0 €"`.
 *
 * Validates: Requirements 1.4, 1.5, 1.6, 5.4.
 */

import {
  BadgeEuro,
  BarChart3,
  Layers,
  Sparkles,
  TrendingDown,
  Zap,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatEurK } from "@/lib/eks-cost/format";
import { cn } from "@/lib/utils";
import type { AllocationResponse } from "@/lib/eks-cost/types";
import { colorForSpotPct } from "./theme";

export interface KpiBarProps {
  summary: AllocationResponse;
}

/**
 * Return the largest single `estimatedSavingsEur` in the recommendations
 * list. Used in the "Recomendaciones" KPI subtitle so users see the top
 * opportunity, not just the count.
 */
function topSavingEur(summary: AllocationResponse): number {
  let top = 0;
  for (const rec of summary.recommendations) {
    if (rec.estimatedSavingsEur > top) top = rec.estimatedSavingsEur;
  }
  return top;
}

/**
 * "Savings share" — what fraction of the current monthly cost could be
 * recovered if every over-provisioning recommendation is applied.
 * Clamped to `[0, 1]`; returns `0` when the current cost is unknown.
 */
function savingsFraction(summary: AllocationResponse): number {
  if (summary.totalMonthlyEur <= 0) return 0;
  const f = summary.totalEstimatedSavingsEur / summary.totalMonthlyEur;
  if (!Number.isFinite(f)) return 0;
  return Math.max(0, Math.min(1, f));
}

/**
 * Small circular gauge (SVG). Renders a background ring, a coloured
 * foreground arc for `value` (0..1) and centred text. Deterministic —
 * no state, no motion side effects.
 */
function RingGauge({
  value,
  label,
  color,
  trackColor = "rgba(255,255,255,0.18)",
  size = 96,
  strokeWidth = 10,
}: {
  value: number;
  label: string;
  color: string;
  trackColor?: string;
  size?: number;
  strokeWidth?: number;
}) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - clamped);
  return (
    <div
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={trackColor}
          strokeWidth={strokeWidth}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          style={{ transition: "stroke-dashoffset 400ms ease-out" }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-bold tabular-nums">
        {label}
      </span>
    </div>
  );
}

export function KpiBar({ summary }: KpiBarProps) {
  const spotClasses = colorForSpotPct(summary.totalSpotCoveragePct);
  const spotPct = Number.isFinite(summary.totalSpotCoveragePct)
    ? `${summary.totalSpotCoveragePct.toFixed(1)}%`
    : "—";
  const spotLabel =
    summary.totalSpotCoveragePct > 30
      ? "Óptima"
      : summary.totalSpotCoveragePct >= 10
        ? "Mejorable"
        : "Baja";
  const totalSpotNodes = summary.environments.reduce(
    (acc, env) => acc + env.spotCount,
    0,
  );
  const topSaving = topSavingEur(summary);
  const savingsFrac = savingsFraction(summary);
  const savingsPct = Math.round(savingsFrac * 100);

  return (
    <div className="grid gap-4 lg:grid-cols-6">
      {/* ── Hero KPI: Coste EKS / mes ─────────────────────────────── */}
      <Card
        className={cn(
          "relative overflow-hidden border-none text-white shadow-xl lg:col-span-2",
          "bg-gradient-to-br from-slate-800 via-indigo-900 to-fuchsia-900",
        )}
      >
        {/* Decorative glow blobs */}
        <div
          className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full opacity-30 blur-3xl"
          style={{ background: "radial-gradient(hsl(280 90% 70%), transparent 70%)" }}
        />
        <div
          className="pointer-events-none absolute -bottom-24 -left-8 h-56 w-56 rounded-full opacity-20 blur-3xl"
          style={{ background: "radial-gradient(hsl(200 90% 60%), transparent 70%)" }}
        />
        <CardContent className="relative flex flex-col justify-between gap-4 p-6 sm:flex-row sm:items-center">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-white/80 backdrop-blur">
              <BadgeEuro className="h-3.5 w-3.5" aria-hidden />
              Coste EKS · mes
            </div>
            <div className="text-4xl font-black leading-tight tracking-tight sm:text-5xl">
              {formatEurK(summary.totalMonthlyEur)}
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-2.5 py-1 font-semibold text-emerald-200">
                <TrendingDown className="h-3 w-3" aria-hidden />
                {formatEurK(summary.totalEstimatedSavingsEur)} ahorro
              </span>
              <span className="text-white/70">
                {summary.recommendations.length} recomendaciones
              </span>
            </div>
          </div>
          <RingGauge
            value={savingsFrac}
            label={`${savingsPct}%`}
            color="hsl(158 84% 60%)"
          />
        </CardContent>
      </Card>

      {/* ── Cobertura spot ─────────────────────────────────────────── */}
      <Card className="relative overflow-hidden border-none bg-gradient-to-br from-white to-slate-50 shadow-md dark:from-slate-900 dark:to-slate-950">
        <div
          className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full opacity-20 blur-2xl"
          style={{ background: spotClasses.ring }}
        />
        <CardContent className="relative flex flex-col gap-2 p-5">
          <div className="flex items-center gap-2">
            <span
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg"
              style={{ background: spotClasses.bg, color: spotClasses.fg }}
            >
              <Zap className="h-4 w-4" aria-hidden />
            </span>
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Cobertura spot
            </span>
          </div>
          <div className="text-3xl font-bold tabular-nums">{spotPct}</div>
          <Badge
            variant="outline"
            className="w-fit border-transparent"
            style={{ background: spotClasses.bg, color: spotClasses.fg }}
          >
            {spotLabel}
          </Badge>
        </CardContent>
      </Card>

      {/* ── Nodos totales ──────────────────────────────────────────── */}
      <Card className="relative overflow-hidden border-none bg-gradient-to-br from-white to-slate-50 shadow-md dark:from-slate-900 dark:to-slate-950">
        <div
          className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full opacity-20 blur-2xl"
          style={{ background: "hsl(210 90% 60%)" }}
        />
        <CardContent className="relative flex flex-col gap-2 p-5">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300">
              <Layers className="h-4 w-4" aria-hidden />
            </span>
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Nodos totales
            </span>
          </div>
          <div className="text-3xl font-bold tabular-nums">
            {summary.totalNodeCount}
          </div>
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">{totalSpotNodes}</span> spot ·{" "}
            <span className="font-medium">
              {summary.totalNodeCount - totalSpotNodes}
            </span>{" "}
            on-demand
          </div>
        </CardContent>
      </Card>

      {/* ── Recomendaciones ─────────────────────────────────────────── */}
      <Card className="relative overflow-hidden border-none bg-gradient-to-br from-white to-slate-50 shadow-md dark:from-slate-900 dark:to-slate-950">
        <div
          className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full opacity-20 blur-2xl"
          style={{ background: "hsl(268 82% 60%)" }}
        />
        <CardContent className="relative flex flex-col gap-2 p-5">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Recomendaciones
            </span>
          </div>
          <div className="text-3xl font-bold tabular-nums">
            {summary.recommendations.length}
          </div>
          <div className="text-xs text-muted-foreground">
            top ahorro:{" "}
            <span className="font-semibold text-foreground">
              {formatEurK(topSaving)}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ── Entornos activos ────────────────────────────────────────── */}
      <Card className="relative overflow-hidden border-none bg-gradient-to-br from-white to-slate-50 shadow-md dark:from-slate-900 dark:to-slate-950">
        <div
          className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full opacity-20 blur-2xl"
          style={{ background: "hsl(160 74% 55%)" }}
        />
        <CardContent className="relative flex flex-col gap-2 p-5">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
              <BarChart3 className="h-4 w-4" aria-hidden />
            </span>
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Entornos
            </span>
          </div>
          <div className="text-3xl font-bold tabular-nums">
            {summary.environments.length}
          </div>
          <div className="text-xs text-muted-foreground">
            {summary.nodegroups.length} nodegroups · {summary.squads.length}{" "}
            squads
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
