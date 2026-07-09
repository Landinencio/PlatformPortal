"use client";

/**
 * SpotCoveragePanel — one small radial gauge per environment showing the
 * fraction of nodes running on spot capacity. Complements the aggregate
 * "Cobertura spot" KPI: at a glance operators can see which clusters carry
 * the on-demand risk and which are healthily spread across spot.
 *
 * Each gauge uses the semantic threshold palette from
 * {@link colorForSpotPct} (>30% verde, 10-30% ámbar, <10% gris) so the
 * story is the same one told by the KPI badge.
 *
 * Requirements: 1.5, 1.6.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Environment } from "@/lib/eks-cost/types";

import { ENV_COLOR, colorForSpotPct } from "./theme";

export interface SpotCoveragePanelProps {
  environments: Environment[];
}

/**
 * Compact radial gauge (SVG) — draws a background track and a coloured
 * foreground arc from 0..1. Rendered pure with no state so it composes
 * safely inside a grid.
 */
function Gauge({
  value,
  color,
  label,
  size = 92,
  strokeWidth = 8,
}: {
  value: number;
  color: string;
  label: string;
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
          stroke="hsl(220 15% 88%)"
          strokeWidth={strokeWidth}
          fill="none"
          className="dark:stroke-slate-800"
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
      <span className="absolute inset-0 flex items-center justify-center text-base font-bold tabular-nums">
        {label}
      </span>
    </div>
  );
}

export function SpotCoveragePanel({ environments }: SpotCoveragePanelProps) {
  // Sort by canonical env order so the row reads dev → uat → prod → tooling.
  const order = ["dev", "uat", "prod", "tooling"] as const;
  const sorted = [...environments].sort(
    (a, b) => order.indexOf(a.name) - order.indexOf(b.name),
  );

  return (
    <Card className="relative overflow-hidden border-none bg-gradient-to-br from-white to-slate-50 shadow-lg dark:from-slate-900 dark:to-slate-950">
      <div
        className="pointer-events-none absolute -top-12 right-0 h-40 w-40 rounded-full opacity-20 blur-3xl"
        style={{ background: "radial-gradient(hsl(158 74% 55%), transparent 70%)" }}
      />
      <CardHeader className="relative">
        <CardTitle>Cobertura spot por cluster</CardTitle>
        <CardDescription>
          Porcentaje de nodos en instancias spot. A mayor cobertura, mayor
          resiliencia a interrupciones y menor coste base.
        </CardDescription>
      </CardHeader>
      <CardContent className="relative">
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin datos de entornos.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {sorted.map((env) => {
              const spotFrac =
                env.nodeCount > 0 ? env.spotCount / env.nodeCount : 0;
              const spotPct = spotFrac * 100;
              const scheme = colorForSpotPct(spotPct);
              const label = Number.isFinite(spotPct)
                ? `${spotPct.toFixed(0)}%`
                : "—";
              return (
                <div
                  key={env.name}
                  className="flex flex-col items-center gap-2 rounded-xl border border-transparent bg-white/60 p-3 text-center shadow-sm dark:bg-slate-900/40"
                >
                  <Gauge value={spotFrac} color={scheme.ring} label={label} />
                  <div
                    className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider"
                    style={{ color: ENV_COLOR[env.name] }}
                  >
                    <span
                      aria-hidden
                      className="inline-block h-1.5 w-1.5 rounded-full"
                      style={{ background: ENV_COLOR[env.name] }}
                    />
                    {env.name}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {env.spotCount}/{env.nodeCount} nodos
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
