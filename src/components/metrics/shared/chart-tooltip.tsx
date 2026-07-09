"use client";

import { formatDuration } from "@/lib/format-utils";

type TooltipPayloadEntry = {
  dataKey: string;
  name?: string;
  value: number;
  color?: string;
  unit?: string;
};

type ChartTooltipProps = {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
};

function formatValue(value: unknown, unit?: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  if (unit === "duration") return formatDuration(value);
  if (unit === "percent") return `${value.toFixed(1)}%`;
  if (unit === "count") return String(Math.round(value));
  return value.toFixed(2);
}

export function ChartTooltip({ active, payload, label }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-xl border border-border/70 bg-background/95 p-3 shadow-lg backdrop-blur-sm">
      <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      <div className="space-y-1">
        {payload.map((entry) => (
          <div key={entry.dataKey} className="flex items-center justify-between gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              {entry.color && (
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: entry.color }}
                />
              )}
              <span className="text-muted-foreground">{entry.name || entry.dataKey}</span>
            </div>
            <span className="font-semibold" style={{ color: entry.color }}>
              {formatValue(entry.value, entry.unit)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
