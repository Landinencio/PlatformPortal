"use client";

/**
 * NodegroupBreakdownChart — stacked bar chart per nodegroup with vertical
 * gradients on both segments (right-sized in emerald, overprovisioning in
 * red) and an inline caption per bar showing:
 *
 *   - the concrete `N nodos de más` string (Requirement 5.5) when the
 *     nodegroup has any excess node — mandatory literal from design §5.5,
 *   - a percentage-based efficiency badge coloured by
 *     {@link colorForEfficiency},
 *   - node counts (total and spot).
 *
 * Bars use `hsl(var(--…))` tokens whenever possible so the palette follows
 * the portal's light/dark switch; the gradient stops come from
 * `theme.ts` (`RIGHT_SIZED_COLOR`, `OVERPROVISION_COLOR`).
 *
 * Validates: Requirements 1.2, 1.4, 1.7, 5.5.
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatEurK } from "@/lib/eks-cost/format";
import { cn } from "@/lib/utils";
import type { Nodegroup } from "@/lib/eks-cost/types";

import {
  OVERPROVISION_COLOR,
  OVERPROVISION_COLOR_DARK,
  RIGHT_SIZED_COLOR,
  RIGHT_SIZED_COLOR_DARK,
  colorForEfficiency,
  gradientId,
} from "./theme";

/**
 * Strip the trailing Terraform / eksctl launch-template suffix from a
 * nodegroup name so the chart labels stay short. Terraform-managed EKS
 * nodegroups usually get names like
 * `toolingnodesv2-2026061514221107590000003` — 20+ digit epoch suffix. We
 * drop that suffix but keep the rest intact; anything without the pattern
 * (typical eksctl / manual nodegroups) is passed through unchanged.
 */
function prettifyNodegroupName(name: string): string {
  const stripped = name.replace(/-2[0-9]{25,}$/, "");
  return stripped || name;
}

interface ChartRow {
  key: string;
  label: string;
  rightSized: number;
  overprovisioning: number;
  nodegroup: Nodegroup;
}

export interface NodegroupBreakdownChartProps {
  nodegroups: Nodegroup[];
}

/**
 * Build the Recharts rows from the domain `Nodegroup[]`. Sorted DESC by
 * total cost so the biggest nodegroups sit at the top of the (horizontal)
 * chart. Segments clamped to `>= 0` so a defensive downstream bug can't
 * produce negative bars.
 */
function toChartRows(nodegroups: Nodegroup[]): ChartRow[] {
  return [...nodegroups]
    .sort((a, b) => b.monthlyCostEur - a.monthlyCostEur)
    .map((ng) => {
      const overprovisioning = Math.max(0, ng.overprovisioningEur);
      const rightSized = Math.max(0, ng.monthlyCostEur - overprovisioning);
      return {
        key: `${ng.cluster}::${ng.name}`,
        label: `${prettifyNodegroupName(ng.name)} · ${ng.cluster}`,
        rightSized,
        overprovisioning,
        nodegroup: ng,
      };
    });
}

/** Compute the efficiency percentage (1 - overprovisioning share). */
function efficiencyPct(ng: Nodegroup): number {
  if (ng.monthlyCostEur <= 0) return 100;
  return Math.max(
    0,
    Math.min(100, (1 - ng.overprovisioningEur / ng.monthlyCostEur) * 100),
  );
}

/**
 * Custom tooltip rendering — mirrors the caption line below the chart but
 * appears on hover with full precision (`formatEurK` on both segments and
 * the total).
 */
function BreakdownTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: ChartRow }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const total = row.rightSized + row.overprovisioning;
  const eff = efficiencyPct(row.nodegroup);
  return (
    <div className="rounded-lg border border-border/70 bg-background/95 p-3 text-sm shadow-xl backdrop-blur">
      <p className="font-semibold">{row.label}</p>
      <div className="mt-2 space-y-1">
        <div className="flex items-center justify-between gap-6">
          <span className="inline-flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: RIGHT_SIZED_COLOR }}
            />
            Ajustado
          </span>
          <span className="font-medium tabular-nums">
            {formatEurK(row.rightSized)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-6">
          <span className="inline-flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: OVERPROVISION_COLOR }}
            />
            Sobre-provisionado
          </span>
          <span className="font-medium tabular-nums">
            {formatEurK(row.overprovisioning)}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-6 border-t border-border/60 pt-1 text-muted-foreground">
          <span>Total</span>
          <span className="font-semibold tabular-nums text-foreground">
            {formatEurK(total)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-6 text-xs">
          <span>Eficiencia</span>
          <span
            className="font-semibold tabular-nums"
            style={{ color: colorForEfficiency(eff) }}
          >
            {eff.toFixed(0)}%
          </span>
        </div>
      </div>
    </div>
  );
}

export function NodegroupBreakdownChart({ nodegroups }: NodegroupBreakdownChartProps) {
  const rows = toChartRows(nodegroups);
  const height = Math.min(560, Math.max(280, rows.length * 44 + 80));
  const rightSizedGrad = gradientId("nodegroup", "right-sized");
  const overGrad = gradientId("nodegroup", "over");

  return (
    <Card className="relative overflow-hidden border-none bg-gradient-to-br from-white via-slate-50 to-slate-100 shadow-lg dark:from-slate-900 dark:via-slate-950 dark:to-slate-900">
      <div
        className="pointer-events-none absolute -top-24 right-0 h-56 w-56 rounded-full opacity-30 blur-3xl"
        style={{ background: "radial-gradient(hsl(340 90% 65%), transparent 70%)" }}
      />
      <CardHeader className="relative">
        <CardTitle>Desglose por nodegroup</CardTitle>
        <CardDescription>
          Coste mensual por nodegroup con la parte ajustada frente a la
          sobre-provisionada. La zona roja mide directamente los nodos de más
          que el cluster-autoscaler no puede liberar.
        </CardDescription>
      </CardHeader>
      <CardContent className="relative space-y-4">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin nodegroups para mostrar.</p>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={height}>
              <BarChart
                data={rows}
                layout="vertical"
                margin={{ top: 8, right: 32, left: 8, bottom: 8 }}
                barCategoryGap="22%"
              >
                <defs>
                  <linearGradient id={rightSizedGrad} x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor={RIGHT_SIZED_COLOR_DARK} />
                    <stop offset="100%" stopColor={RIGHT_SIZED_COLOR} />
                  </linearGradient>
                  <linearGradient id={overGrad} x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor={OVERPROVISION_COLOR} />
                    <stop offset="100%" stopColor={OVERPROVISION_COLOR_DARK} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  horizontal={false}
                  strokeDasharray="4 4"
                  className="stroke-muted"
                />
                <XAxis
                  type="number"
                  tickFormatter={(value: number) => formatEurK(Number(value))}
                  className="text-[11px]"
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={180}
                  tick={{ fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  content={<BreakdownTooltip />}
                  cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
                />
                <Legend
                  wrapperStyle={{ paddingTop: 8 }}
                  formatter={(value) => (
                    <span className="text-xs text-muted-foreground">{value}</span>
                  )}
                />
                <Bar
                  dataKey="rightSized"
                  stackId="cost"
                  name="Ajustado"
                  fill={`url(#${rightSizedGrad})`}
                  radius={[6, 0, 0, 6]}
                >
                  {rows.map((row) => (
                    <Cell key={`right-${row.key}`} />
                  ))}
                </Bar>
                <Bar
                  dataKey="overprovisioning"
                  stackId="cost"
                  name="Sobre-provisionado"
                  fill={`url(#${overGrad})`}
                  radius={[0, 6, 6, 0]}
                >
                  {rows.map((row) => (
                    <Cell key={`over-${row.key}`} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>

            <ul className="space-y-1.5 text-sm">
              {rows.map(({ nodegroup: ng }) => {
                const eff = efficiencyPct(ng);
                const showExcess = ng.excessNodes > 0;
                return (
                  <li
                    key={`${ng.cluster}-${ng.name}`}
                    className={cn(
                      "flex flex-wrap items-center gap-3 rounded-lg border border-transparent bg-white/70 px-3 py-2 shadow-sm transition-all",
                      "hover:border-primary/30",
                      "dark:bg-slate-900/40",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold">
                        {prettifyNodegroupName(ng.name)}
                      </span>
                      <span className="text-muted-foreground">
                        {" · "}
                        {ng.cluster}
                      </span>
                    </span>
                    <Badge
                      variant="outline"
                      className="border-none tabular-nums"
                      style={{
                        background: `${colorForEfficiency(eff)}22`,
                        color: colorForEfficiency(eff),
                      }}
                    >
                      {eff.toFixed(0)}% eficiencia
                    </Badge>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {ng.nodeCount} nodos ·{" "}
                      <span className="font-semibold">{formatEurK(ng.monthlyCostEur)}</span>
                    </span>
                    {showExcess ? (
                      <Badge
                        className="border-none bg-rose-500/15 text-rose-600 dark:text-rose-300"
                        variant="outline"
                      >
                        {ng.excessNodes} nodos de más
                      </Badge>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
