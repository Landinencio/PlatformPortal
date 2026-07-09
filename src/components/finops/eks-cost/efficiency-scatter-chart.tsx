"use client";

/**
 * EfficiencyScatterChart — one dot per workload plotted on:
 *
 *   - X axis: monthly cost (EUR, log-friendly compact axis).
 *   - Y axis: memory efficiency (100 - overprovisioning share on memory),
 *     capped to `[0, 100]`.
 *   - Size:   number of pods (helps spot large deployments at a glance).
 *   - Colour: recommendation kind for the workload (`over-*` = green,
 *             `under-*` = amber/red, no rec = neutral).
 *
 * Read: the top-right corner is the ideal zone (high efficiency + low
 * cost). Bottom-right dots are the meatiest savings opportunities (large,
 * expensive, wasteful). Bottom-left is noise. The chart complements the
 * recommendations table by giving spatial intuition — a table can hide
 * concentration that a scatter surfaces immediately.
 *
 * Requirements: 3.1, 3.2, 5.3 — visual companion to the rightsizing pipeline.
 */

import { useMemo } from "react";
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatEurK } from "@/lib/eks-cost/format";
import type { Recommendation, Workload } from "@/lib/eks-cost/types";

import { KIND_COLOR } from "./theme";

export interface EfficiencyScatterChartProps {
  workloads: Workload[];
  recommendations: Recommendation[];
}

interface Point {
  x: number; // monthly cost EUR
  y: number; // memory efficiency percent, 0..100
  z: number; // pod count (marker size)
  workload: string;
  namespace: string;
  cluster: string;
  kind: Recommendation["kind"] | "none";
  color: string;
  savingsEur: number;
}

/**
 * Memory efficiency proxy — `p95 / requests * 100`, clamped to `[0, 100]`.
 * Chosen over CPU because memory over-provisioning is what actually keeps
 * nodes alive (CPU is throttled, memory kills pods).
 */
function memEfficiency(w: Workload): number {
  if (w.memRequestBytes <= 0) return 0;
  const pct = (w.memUsageP95Bytes / w.memRequestBytes) * 100;
  return Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
}

export function EfficiencyScatterChart({
  workloads,
  recommendations,
}: EfficiencyScatterChartProps) {
  const points = useMemo<Point[]>(() => {
    // Aggregate recommendation kind + total savings per workload for colouring.
    interface RecMeta {
      kind: Recommendation["kind"];
      savings: number;
    }
    const recIndex = new Map<string, RecMeta>();
    for (const r of recommendations) {
      const key = `${r.cluster}::${r.namespace}::${r.workload}`;
      const prev = recIndex.get(key);
      if (!prev || r.estimatedSavingsEur > prev.savings) {
        recIndex.set(key, { kind: r.kind, savings: r.estimatedSavingsEur });
      }
    }

    return workloads.map((w) => {
      const key = `${w.cluster}::${w.namespace}::${w.workload}`;
      const rec = recIndex.get(key);
      const kind = rec?.kind ?? "none";
      const color =
        kind === "none"
          ? "hsl(220 12% 60%)"
          : KIND_COLOR[kind].ring;
      return {
        x: Math.max(0.01, w.monthlyCostEur),
        y: memEfficiency(w),
        z: Math.max(1, w.podCount),
        workload: w.workload,
        namespace: w.namespace,
        cluster: w.cluster,
        kind,
        color,
        savingsEur: rec?.savings ?? 0,
      };
    });
  }, [workloads, recommendations]);

  // Group by kind so each group renders its own colour without needing a
  // per-point <Cell>. Recharts colours Scatter series uniformly by default,
  // and we want the tooltip to still show per-point context.
  const byKind = useMemo(() => {
    const map = new Map<Point["kind"], Point[]>();
    for (const p of points) {
      const list = map.get(p.kind);
      if (list) list.push(p);
      else map.set(p.kind, [p]);
    }
    return Array.from(map.entries());
  }, [points]);

  return (
    <Card className="relative overflow-hidden border-none bg-gradient-to-br from-white to-slate-50 shadow-lg dark:from-slate-900 dark:to-slate-950">
      <div
        className="pointer-events-none absolute -top-12 right-8 h-40 w-40 rounded-full opacity-15 blur-3xl"
        style={{ background: "radial-gradient(hsl(200 90% 60%), transparent 70%)" }}
      />
      <CardHeader className="relative">
        <CardTitle>Eficiencia vs coste</CardTitle>
        <CardDescription>
          Cada punto es un workload. Eje X: coste mensual. Eje Y: uso p95 de
          memoria sobre requests. Tamaño: réplicas. Color: tipo de recomendación
          (verde = sobra, ámbar/rojo = falta). Los puntos abajo a la derecha
          son las mejores oportunidades de ahorro.
        </CardDescription>
      </CardHeader>
      <CardContent className="relative">
        {points.length === 0 ? (
          <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
            No hay workloads visibles.
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={320}>
              <ScatterChart margin={{ top: 16, right: 24, left: 8, bottom: 24 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name="Coste"
                  scale="log"
                  domain={["auto", "auto"]}
                  tickFormatter={(v: number) => formatEurK(Number(v))}
                  className="text-[11px]"
                  axisLine={false}
                  tickLine={false}
                  label={{
                    value: "Coste mensual (€, escala log)",
                    position: "insideBottom",
                    offset: -14,
                    fontSize: 11,
                    fill: "hsl(220 10% 45%)",
                  }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name="Eficiencia memoria"
                  domain={[0, 100]}
                  tickFormatter={(v: number) => `${Math.round(v)}%`}
                  className="text-[11px]"
                  axisLine={false}
                  tickLine={false}
                  label={{
                    value: "Eficiencia memoria",
                    angle: -90,
                    position: "insideLeft",
                    offset: 8,
                    fontSize: 11,
                    fill: "hsl(220 10% 45%)",
                  }}
                />
                <ZAxis type="number" dataKey="z" range={[40, 320]} name="Pods" />
                <Tooltip
                  cursor={{ strokeDasharray: "3 3" }}
                  content={(props: unknown) => {
                    const p = props as {
                      active?: boolean;
                      payload?: Array<{ payload?: Point }>;
                    };
                    if (!p.active || !p.payload || !p.payload[0]?.payload) return null;
                    const pt = p.payload[0].payload;
                    return (
                      <div className="rounded-lg border border-border/70 bg-background/95 p-3 text-xs shadow-xl backdrop-blur">
                        <div className="font-semibold">
                          {pt.namespace}/{pt.workload}
                        </div>
                        <div className="text-muted-foreground">
                          {pt.cluster}
                        </div>
                        <div className="mt-1 flex justify-between gap-4">
                          <span>Coste</span>
                          <span className="tabular-nums font-semibold">
                            {formatEurK(pt.x)}
                          </span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>Efic. memoria</span>
                          <span className="tabular-nums font-semibold">
                            {pt.y.toFixed(0)}%
                          </span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>Pods</span>
                          <span className="tabular-nums font-semibold">
                            {pt.z}
                          </span>
                        </div>
                        {pt.kind !== "none" ? (
                          <div className="mt-1 flex justify-between gap-4">
                            <span>{pt.kind}</span>
                            <span className="tabular-nums font-semibold">
                              {formatEurK(pt.savingsEur)} ahorro
                            </span>
                          </div>
                        ) : null}
                      </div>
                    );
                  }}
                />
                {byKind.map(([kind, pts]) => (
                  <Scatter
                    key={kind}
                    name={kind}
                    data={pts}
                    fill={pts[0]?.color ?? "hsl(220 10% 60%)"}
                    fillOpacity={0.75}
                    stroke={pts[0]?.color ?? "hsl(220 10% 60%)"}
                    strokeWidth={1}
                  />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
            <div className="mt-2 flex flex-wrap items-center justify-end gap-3 text-[11px] text-muted-foreground">
              <LegendDot color={KIND_COLOR["over-cpu"].ring} label="Sobra CPU" />
              <LegendDot color={KIND_COLOR["over-mem"].ring} label="Sobra memoria" />
              <LegendDot color={KIND_COLOR["under-cpu"].ring} label="Falta CPU" />
              <LegendDot color={KIND_COLOR["under-mem"].ring} label="Falta memoria" />
              <LegendDot color="hsl(220 12% 60%)" label="Sin recomendación" />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}
