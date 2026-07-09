"use client";

/**
 * SquadAttributionChart — squad ranking with two nested horizontal bars per
 * row: the outer bar is the full monthly cost (with a squad-specific
 * gradient) and the inner overlay is the overprovisioning share (in muted
 * red) so both signals coexist visually.
 *
 * The top-3 squads get a subtle "podium" ring (gold / silver / bronze) plus
 * a rank number, borrowing the pattern from the FinOps executive summary.
 * A "% del total" badge is placed next to the cost so users can eyeball
 * concentration without doing mental arithmetic.
 *
 * Requirements: 2.2, 2.4, 6.3.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatEurK } from "@/lib/eks-cost/format";
import type { Squad } from "@/lib/eks-cost/types";

import { colorForEfficiency, colorForSquad, prettySquadName } from "./theme";

export interface SquadAttributionChartProps {
  squads: Squad[];
  onSquadClick?: (squad: string) => void;
}

/** Podium accent colours for the top-3 squads. */
const RANK_ACCENT = [
  "hsl(46 92% 52%)",   // gold
  "hsl(215 15% 65%)",  // silver
  "hsl(28 74% 55%)",   // bronze
] as const;

export function SquadAttributionChart({
  squads,
  onSquadClick,
}: SquadAttributionChartProps) {
  const rows = [...squads].sort((a, b) => b.monthlyCostEur - a.monthlyCostEur);
  const total = rows.reduce((s, r) => s + r.monthlyCostEur, 0);
  const maxCost = rows.reduce((m, r) => Math.max(m, r.monthlyCostEur), 0);

  return (
    <Card className="relative overflow-hidden border-none bg-gradient-to-br from-white via-slate-50 to-slate-100 shadow-lg dark:from-slate-900 dark:via-slate-950 dark:to-slate-900">
      <div
        className="pointer-events-none absolute -top-16 -left-16 h-56 w-56 rounded-full opacity-25 blur-3xl"
        style={{ background: "radial-gradient(hsl(258 82% 65%), transparent 70%)" }}
      />
      <CardHeader className="relative">
        <CardTitle>Coste por squad</CardTitle>
        <CardDescription>
          Cuánto cuesta lo que despliega cada equipo. En rojo la parte
          sobre-provisionada. Haz clic para filtrar el dashboard.
        </CardDescription>
      </CardHeader>
      <CardContent className="relative">
        {rows.length === 0 ? (
          <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
            No hay datos de squads.
          </div>
        ) : (
          <ol className="space-y-3">
            {rows.map((s, i) => {
              const [c1, c2] = colorForSquad(s.name);
              const clickable = Boolean(onSquadClick);
              const totalPct = total > 0 ? (s.monthlyCostEur / total) * 100 : 0;
              const barPct = maxCost > 0 ? (s.monthlyCostEur / maxCost) * 100 : 0;
              const overPctOfSquad =
                s.monthlyCostEur > 0
                  ? (s.overprovisioningEur / s.monthlyCostEur) * 100
                  : 0;
              const overBarPct =
                maxCost > 0 ? (s.overprovisioningEur / maxCost) * 100 : 0;
              const isPodium = i < 3;
              return (
                <li key={s.name}>
                  <button
                    type="button"
                    onClick={() => onSquadClick?.(s.name)}
                    disabled={!clickable}
                    className={cn(
                      "group grid w-full grid-cols-[2rem_1fr_auto] items-center gap-3 rounded-xl px-3 py-2 text-left transition-all",
                      "border border-transparent bg-white/70 shadow-sm dark:bg-slate-900/40",
                      clickable && "hover:-translate-y-[1px] hover:border-primary/30 hover:shadow-md",
                      !clickable && "cursor-default",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "inline-flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold",
                        isPodium ? "text-slate-900 shadow-md" : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
                      )}
                      style={
                        isPodium
                          ? { background: RANK_ACCENT[i] }
                          : undefined
                      }
                    >
                      {i + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-semibold">
                          {prettySquadName(s.name)}
                        </span>
                        <span
                          className="text-[11px] font-medium tabular-nums"
                          style={{ color: colorForEfficiency(100 - overPctOfSquad) }}
                          title="Eficiencia = 1 − (sobre-provisión / coste total del squad)"
                        >
                          {(100 - overPctOfSquad).toFixed(0)}% eficiencia
                        </span>
                      </div>
                      {/* Bar layer: full cost + overprovisioning overlay */}
                      <div className="relative mt-1 h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                        <div
                          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
                          style={{
                            width: `${barPct}%`,
                            background: `linear-gradient(90deg, ${c1} 0%, ${c2} 100%)`,
                          }}
                        />
                        {overBarPct > 0 ? (
                          <div
                            className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
                            style={{
                              width: `${overBarPct}%`,
                              background:
                                "repeating-linear-gradient(45deg, hsl(0 76% 62% / 0.85) 0px, hsl(0 76% 62% / 0.85) 4px, hsl(0 76% 48% / 0.85) 4px, hsl(0 76% 48% / 0.85) 8px)",
                            }}
                            aria-hidden
                          />
                        ) : null}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 whitespace-nowrap">
                      <span className="text-sm font-bold tabular-nums">
                        {formatEurK(s.monthlyCostEur)}
                      </span>
                      <div className="flex items-center gap-1.5 text-[10px]">
                        <Badge
                          variant="outline"
                          className="border-none bg-slate-100 px-1.5 py-0 font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                        >
                          {totalPct.toFixed(1)}%
                        </Badge>
                        {overPctOfSquad > 5 ? (
                          <Badge
                            variant="outline"
                            className="border-none bg-rose-500/15 px-1.5 py-0 font-semibold text-rose-600 dark:text-rose-300"
                          >
                            −{formatEurK(s.overprovisioningEur)}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
