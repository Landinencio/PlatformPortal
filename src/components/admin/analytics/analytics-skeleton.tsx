"use client";

export function AnalyticsSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* KPI cards skeleton */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-24 rounded-lg bg-muted/40" />
        ))}
      </div>
      {/* Chart skeleton */}
      <div className="h-64 rounded-lg bg-muted/40" />
      {/* Table skeleton */}
      <div className="space-y-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-10 rounded-lg bg-muted/30" />
        ))}
      </div>
    </div>
  );
}
