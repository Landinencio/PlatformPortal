"use client";

/**
 * RecommendationsTable — rightsizing recommendations rendered as compact
 * "podium" cards on desktop and stacked cards on mobile. Ordering DESC by
 * `estimatedSavingsEur` (backend guarantee).
 *
 * Design decisions:
 *   - Each row carries a coloured left border by `kind` (savings vs risk)
 *     using the semantic tokens from `theme.ts`.
 *   - A horizontal savings bar visualises how big each recommendation is
 *     against the top saving in the current page, so operators can
 *     eyeball the top-5 without reading numbers.
 *   - Selected row lifts slightly (`shadow-lg`, `ring-2`) so users always
 *     know which one drives the side panel content.
 *
 * Requirements: 5.3, 5.4.
 */

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { formatEur } from "@/lib/eks-cost/format";
import type { Recommendation } from "@/lib/eks-cost/types";

import { KIND_CATEGORY, KIND_COLOR, KIND_LABEL, prettySquadName } from "./theme";

export interface RecommendationsTableProps {
  recommendations: Recommendation[];
  onRowClick?: (rec: Recommendation) => void;
  selectedIndex?: number | null;
}

export function RecommendationsTable({
  recommendations,
  onRowClick,
  selectedIndex,
}: RecommendationsTableProps) {
  const clickable = Boolean(onRowClick);
  const maxSavings = recommendations.reduce(
    (m, r) => Math.max(m, r.estimatedSavingsEur),
    0,
  );

  if (recommendations.length === 0) {
    return (
      <div className="rounded-xl border border-dashed bg-white/60 p-8 text-center text-sm text-muted-foreground dark:bg-slate-900/40">
        No hay recomendaciones para mostrar.
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {recommendations.map((rec, index) => {
        const isSelected = selectedIndex === index;
        const kindColor = KIND_COLOR[rec.kind];
        const isSavings = KIND_CATEGORY[rec.kind] === "savings";
        const savingsBar =
          maxSavings > 0 ? (rec.estimatedSavingsEur / maxSavings) * 100 : 0;
        const handleClick = () => onRowClick?.(rec);
        return (
          <button
            key={`${rec.cluster}-${rec.namespace}-${rec.workload}-${rec.kind}-${index}`}
            type="button"
            onClick={handleClick}
            disabled={!clickable}
            aria-pressed={clickable ? isSelected : undefined}
            className={cn(
              "group relative grid grid-cols-[6px_minmax(0,1fr)_auto] items-stretch gap-0 overflow-hidden rounded-xl border border-transparent bg-white/70 text-left shadow-sm transition-all",
              "dark:bg-slate-900/40",
              clickable && "hover:-translate-y-[1px] hover:border-primary/30 hover:shadow-md",
              isSelected && "ring-2 ring-primary/50 shadow-lg",
              !clickable && "cursor-default",
            )}
          >
            {/* Left accent bar coloured by kind */}
            <span
              aria-hidden
              style={{ background: kindColor.ring }}
              className="w-full"
            />
            {/* Body */}
            <div className="min-w-0 px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">
                  {rec.cluster}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  ·
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {rec.namespace}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  /
                </span>
                <span className="truncate font-semibold">{rec.workload}</span>
                <Badge
                  variant="outline"
                  className="border-none tabular-nums"
                  style={{ background: kindColor.bg, color: kindColor.fg }}
                >
                  {KIND_LABEL[rec.kind]}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  · squad{" "}
                  <span className="font-semibold text-foreground">{prettySquadName(rec.squad)}</span>
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  Actual{" "}
                  <span className="font-mono text-foreground">
                    {rec.currentRequest.k8s}
                  </span>
                </span>
                <span aria-hidden>→</span>
                <span>
                  Recomendado{" "}
                  <span className="font-mono font-semibold text-foreground">
                    {rec.recommendedRequest.k8s}
                  </span>
                </span>
              </div>
              {/* Savings bar (only for over-* — under-* has 0 by design) */}
              {isSavings ? (
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div
                    className="h-full rounded-full transition-[width] duration-500"
                    style={{
                      width: `${savingsBar}%`,
                      background: `linear-gradient(90deg, ${kindColor.ring}55 0%, ${kindColor.ring} 100%)`,
                    }}
                  />
                </div>
              ) : (
                <div className="mt-2 text-[11px] italic text-amber-600 dark:text-amber-400">
                  Riesgo de throttling / OOM — sin ahorro asociado.
                </div>
              )}
            </div>
            {/* Savings € */}
            <div className="flex flex-col items-end justify-center gap-1 pr-4 text-right">
              <div
                className="text-base font-bold tabular-nums"
                style={{
                  color: isSavings
                    ? kindColor.fg
                    : "hsl(220 12% 45%)",
                }}
              >
                {isSavings ? formatEur(rec.estimatedSavingsEur) : "—"}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                / mes
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
