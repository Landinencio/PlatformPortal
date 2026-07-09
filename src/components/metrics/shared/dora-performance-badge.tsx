"use client";

import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export type DoraLevel = "elite" | "high" | "medium" | "low" | "unknown";

const LEVEL_CONFIG: Record<DoraLevel, { label: string; className: string; descriptionKey: string }> = {
  elite: {
    label: "Elite",
    className: "bg-success/12 text-success border-success/25",
    descriptionKey: "dora.levelElite",
  },
  high: {
    label: "High",
    className: "bg-info/12 text-info border-info/25",
    descriptionKey: "dora.levelHigh",
  },
  medium: {
    label: "Medium",
    className: "bg-warning/12 text-warning border-warning/25",
    descriptionKey: "dora.levelMedium",
  },
  low: {
    label: "Low",
    className: "bg-danger/12 text-danger border-danger/25",
    descriptionKey: "dora.levelLow",
  },
  unknown: {
    label: "—",
    className: "bg-muted/50 text-muted-foreground border-border/50",
    descriptionKey: "eng.noDataSuffix",
  },
};

/**
 * Classify a DORA metric value into a performance level.
 * Based on the DORA State of DevOps benchmarks.
 */
export function classifyDoraLevel(
  metric: "deployFreq" | "leadTime" | "cfr" | "mttr",
  value: number
): DoraLevel {
  if (!Number.isFinite(value)) return "unknown";
  // For CFR: 0% is the best possible value (elite), not "unknown"
  if (metric === "cfr") {
    if (value < 0) return "unknown";
    if (value <= 5) return "elite";
    if (value <= 15) return "high";
    if (value <= 30) return "medium";
    return "low";
  }
  // For other metrics: 0 or negative means no data
  if (value <= 0) return "unknown";

  switch (metric) {
    case "deployFreq":
      // deploys per project per day
      if (value >= 1) return "elite";
      if (value >= 0.14) return "high"; // ~1/week
      if (value >= 0.03) return "medium"; // ~1/month
      return "low";
    case "leadTime":
      // hours
      if (value <= 1) return "elite";
      if (value <= 24) return "high";
      if (value <= 168) return "medium"; // 1 week
      return "low";
    case "mttr":
      // hours
      if (value <= 1) return "elite";
      if (value <= 24) return "high";
      if (value <= 168) return "medium";
      return "low";
    default:
      return "unknown";
  }
}

export function DoraPerformanceBadge({
  metric,
  value,
  compact = false,
}: {
  metric: "deployFreq" | "leadTime" | "cfr" | "mttr";
  value: number;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const level = classifyDoraLevel(metric, value);
  const config = LEVEL_CONFIG[level];

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border font-semibold",
        compact ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-0.5 text-[10px]",
        config.className
      )}
      title={t(config.descriptionKey)}
    >
      {config.label}
    </span>
  );
}

/**
 * Summary card showing all 4 DORA levels at a glance.
 */
export function DoraPerformanceSummary({
  deployFreq,
  leadTime,
  cfr,
  mttr,
}: {
  deployFreq: number;
  leadTime: number;
  cfr: number;
  mttr: number;
}) {
  const metrics = [
    { key: "deployFreq" as const, label: "DF", value: deployFreq },
    { key: "leadTime" as const, label: "LT", value: leadTime },
    { key: "cfr" as const, label: "CFR", value: cfr },
    { key: "mttr" as const, label: "PRT", value: mttr },
  ];

  return (
    <div className="flex items-center gap-1.5">
      {metrics.map((m) => (
        <div key={m.key} className="flex items-center gap-1">
          <span className="text-[9px] text-muted-foreground/70">{m.label}</span>
          <DoraPerformanceBadge metric={m.key} value={m.value} compact />
        </div>
      ))}
    </div>
  );
}
