"use client";

import { cn } from "@/lib/utils";

function Bone({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-lg bg-muted/60",
        className
      )}
      style={style}
    />
  );
}

/** Skeleton for a MetricCard while data is loading */
export function MetricCardSkeleton() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/70 bg-card p-5 shadow-[0_18px_50px_-36px_rgba(75,42,19,0.3)]">
      <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-muted/40 to-transparent" />
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-3 flex-1">
          <Bone className="h-3.5 w-28" />
          <Bone className="h-8 w-20" />
        </div>
        <Bone className="h-11 w-11 rounded-2xl" />
      </div>
      <div className="mt-4 flex items-end justify-between">
        <Bone className="h-3 w-40" />
        <Bone className="h-6 w-16 rounded-full" />
      </div>
    </div>
  );
}

/** Skeleton for a ChartCard while data is loading */
export function ChartCardSkeleton({ height = 200 }: { height?: number }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_18px_50px_-36px_rgba(75,42,19,0.3)]">
      <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-muted/40 to-transparent" />
      <div className="p-6 space-y-2">
        <Bone className="h-5 w-44" />
        <Bone className="h-3.5 w-64" />
      </div>
      <div className="px-6 pb-6">
        <Bone className="w-full rounded-xl" style={{ height }} />
      </div>
    </div>
  );
}

/** Skeleton for a MiniStat */
export function MiniStatSkeleton() {
  return (
    <div className="rounded-2xl border border-border/50 bg-background/60 px-3 py-3 space-y-2">
      <Bone className="h-2.5 w-16" />
      <Bone className="h-5 w-12" />
    </div>
  );
}

/** Full DORA section skeleton: 4 metric cards + chart */
export function DoraSectionSkeleton() {
  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCardSkeleton />
        <MetricCardSkeleton />
        <MetricCardSkeleton />
        <MetricCardSkeleton />
      </div>
      <ChartCardSkeleton height={240} />
    </div>
  );
}

/** Generic table skeleton */
export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card overflow-hidden">
      <div className="border-b border-border/50 px-4 py-3 flex gap-4">
        {Array.from({ length: cols }).map((_, i) => (
          <Bone key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, row) => (
        <div key={row} className="border-b border-border/30 last:border-0 px-4 py-3 flex gap-4">
          {Array.from({ length: cols }).map((_, col) => (
            <Bone key={col} className="h-3 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}
