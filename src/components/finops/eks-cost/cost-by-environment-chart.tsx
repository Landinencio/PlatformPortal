"use client";

/**
 * `CostByEnvironmentChart` — donut chart with the monthly EKS cost per
 * environment. The centre of the donut shows the aggregated total so the
 * headline number is right where the eye lands first; each slice uses a
 * radial gradient built from `ENV_COLOR` / `ENV_COLOR_DARK` (see `theme.ts`)
 * so the four canonical clusters stay visually distinct on both light and
 * dark themes.
 *
 * Below the donut we list the environments sorted DESC by cost, with the
 * cluster name, spot coverage badge and node count. Clicking a slice
 * (or the legend row) calls `onEnvironmentClick(env.name)` so the parent
 * dashboard can apply an `env` filter.
 *
 * Validates: Requirements 1.1, 1.7, 6.1.
 */

import { useState, type CSSProperties } from "react";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Sector,
} from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatEurK } from "@/lib/eks-cost/format";
import { cn } from "@/lib/utils";
import type { Environment, EnvironmentName } from "@/lib/eks-cost/types";

import { ENV_COLOR, ENV_COLOR_DARK, gradientId } from "./theme";

export interface CostByEnvironmentChartProps {
  environments: Environment[];
  onEnvironmentClick?: (env: EnvironmentName) => void;
}

interface Datum {
  name: EnvironmentName;
  cluster: string;
  monthlyCostEur: number;
  nodeCount: number;
  spotCount: number;
  spotCoveragePct: number;
}

/**
 * Custom active shape: the hovered slice grows outward slightly and gets a
 * lighter outer arc, giving depth without changing the underlying donut
 * geometry (Recharts recomputes the rest of the slices around it).
 */
function ActiveSlice(props: unknown): JSX.Element {
  const p = props as {
    cx: number;
    cy: number;
    innerRadius: number;
    outerRadius: number;
    startAngle: number;
    endAngle: number;
    fill: string;
  };
  return (
    <g>
      <Sector
        cx={p.cx}
        cy={p.cy}
        innerRadius={p.innerRadius}
        outerRadius={p.outerRadius + 8}
        startAngle={p.startAngle}
        endAngle={p.endAngle}
        fill={p.fill}
      />
      <Sector
        cx={p.cx}
        cy={p.cy}
        innerRadius={p.outerRadius + 10}
        outerRadius={p.outerRadius + 14}
        startAngle={p.startAngle}
        endAngle={p.endAngle}
        fill={p.fill}
        opacity={0.35}
      />
    </g>
  );
}

export function CostByEnvironmentChart({
  environments,
  onEnvironmentClick,
}: CostByEnvironmentChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | undefined>(undefined);

  const data: Datum[] = [...environments]
    .map((env) => ({
      name: env.name,
      cluster: env.cluster,
      monthlyCostEur: env.monthlyCostEur,
      nodeCount: env.nodeCount,
      spotCount: env.spotCount,
      spotCoveragePct: env.spotCoveragePct,
    }))
    .sort((a, b) => b.monthlyCostEur - a.monthlyCostEur);

  const total = data.reduce((s, d) => s + d.monthlyCostEur, 0);
  const activeDatum =
    activeIndex !== undefined && activeIndex < data.length
      ? data[activeIndex]
      : null;
  const centreLabel = activeDatum
    ? {
        title: activeDatum.name,
        value: formatEurK(activeDatum.monthlyCostEur),
        hint: `${activeDatum.nodeCount} nodos · ${activeDatum.spotCoveragePct.toFixed(1)}% spot`,
      }
    : {
        title: "Total EKS",
        value: formatEurK(total),
        hint:
          data.length === 0
            ? "sin datos"
            : `${data.length} ${data.length === 1 ? "entorno" : "entornos"}`,
      };

  const empty = data.length === 0 || total <= 0;

  return (
    <Card className="border-none bg-gradient-to-br from-white via-slate-50 to-slate-100 shadow-lg dark:from-slate-900 dark:via-slate-950 dark:to-slate-900">
      <CardHeader>
        <CardTitle>Coste por entorno</CardTitle>
        <CardDescription>
          Distribución mensual (€) del coste EKS por cluster. Haz clic en un
          entorno para filtrar el dashboard.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative mx-auto w-full max-w-[280px]">
          {empty ? (
            <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
              Sin datos de coste por entorno.
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <defs>
                    {data.map((d) => {
                      const id = gradientId("env", d.name);
                      return (
                        <radialGradient key={id} id={id} cx="50%" cy="50%" r="70%">
                          <stop offset="0%" stopColor={ENV_COLOR[d.name]} />
                          <stop offset="100%" stopColor={ENV_COLOR_DARK[d.name]} />
                        </radialGradient>
                      );
                    })}
                  </defs>
                  <Pie
                    data={data}
                    dataKey="monthlyCostEur"
                    nameKey="name"
                    innerRadius={62}
                    outerRadius={95}
                    paddingAngle={2}
                    activeIndex={activeIndex}
                    activeShape={ActiveSlice}
                    stroke="none"
                    onMouseEnter={(_, index) => setActiveIndex(index)}
                    onMouseLeave={() => setActiveIndex(undefined)}
                    onClick={(_, index) => {
                      const d = data[index];
                      if (d && onEnvironmentClick) onEnvironmentClick(d.name);
                    }}
                    cursor={onEnvironmentClick ? "pointer" : "default"}
                  >
                    {data.map((d) => (
                      <Cell key={d.name} fill={`url(#${gradientId("env", d.name)})`} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                  {centreLabel.title}
                </span>
                <span className="text-2xl font-black tabular-nums">
                  {centreLabel.value}
                </span>
                <span className="mt-0.5 text-[11px] text-muted-foreground">
                  {centreLabel.hint}
                </span>
              </div>
            </>
          )}
        </div>

        {!empty ? (
          <ul className="grid grid-cols-2 gap-2">
            {data.map((d, i) => {
              const pct = total > 0 ? (d.monthlyCostEur / total) * 100 : 0;
              const style: CSSProperties = {
                background: `linear-gradient(90deg, ${ENV_COLOR[d.name]} 0%, ${ENV_COLOR_DARK[d.name]} 100%)`,
              };
              return (
                <li key={d.name}>
                  <button
                    type="button"
                    onClick={() => onEnvironmentClick?.(d.name)}
                    onMouseEnter={() => setActiveIndex(i)}
                    onMouseLeave={() => setActiveIndex(undefined)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg border border-transparent bg-white/60 px-2.5 py-1.5 text-left shadow-sm transition-all",
                      "hover:border-primary/30 hover:bg-white",
                      "dark:bg-slate-900/40 dark:hover:bg-slate-900",
                      !onEnvironmentClick && "cursor-default",
                    )}
                  >
                    <span
                      aria-hidden
                      className="inline-block h-5 w-1.5 shrink-0 rounded-full"
                      style={style}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-1">
                        <span className="text-xs font-semibold uppercase tracking-wider">
                          {d.name}
                        </span>
                        <span className="text-sm font-bold tabular-nums">
                          {formatEurK(d.monthlyCostEur)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                        <span>{d.nodeCount} nodos</span>
                        <span className="tabular-nums">{pct.toFixed(1)}%</span>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
