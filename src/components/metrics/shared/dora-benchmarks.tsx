"use client";

import { cn } from "@/lib/utils";
import { classifyDoraLevel, type DoraLevel } from "./dora-performance-badge";
import { useI18n } from "@/lib/i18n";

type BenchmarkRow = {
  metric: string;
  subtitle?: string;
  elite: string;
  high: string;
  medium: string;
  low: string;
};

const BENCHMARKS: BenchmarkRow[] = [
  { metric: "Deploy Frequency", elite: "bench.deployFreq.elite", high: "bench.deployFreq.high", medium: "bench.deployFreq.medium", low: "bench.deployFreq.low" },
  { metric: "Lead Time", subtitle: "bench.leadTime.subtitle", elite: "bench.leadTime.elite", high: "bench.leadTime.high", medium: "bench.leadTime.medium", low: "bench.leadTime.low" },
  { metric: "Change Failure Rate", elite: "≤5%", high: "5–15%", medium: "15–30%", low: ">30%" },
  { metric: "Pipeline Recovery Time", elite: "bench.mttr.elite", high: "bench.mttr.high", medium: "bench.mttr.medium", low: "bench.mttr.low" },
];

const LEVEL_BG: Record<DoraLevel | string, string> = {
  elite: "bg-success/8",
  high: "bg-info/8",
  medium: "bg-warning/8",
  low: "bg-danger/8",
};

/**
 * Reference table showing DORA performance benchmarks with the current position highlighted.
 */
export function DoraBenchmarksTable({
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
  const { t } = useI18n();
  const currentLevels: DoraLevel[] = [
    classifyDoraLevel("deployFreq", deployFreq),
    classifyDoraLevel("leadTime", leadTime),
    classifyDoraLevel("cfr", cfr),
    classifyDoraLevel("mttr", mttr),
  ];

  const levels: Array<"elite" | "high" | "medium" | "low"> = ["elite", "high", "medium", "low"];

  return (
    <div className="rounded-2xl border border-border/70 overflow-hidden text-xs">
      <div className="grid grid-cols-5 bg-muted/40">
        <div className="px-3 py-2 font-semibold text-muted-foreground">{t("bench.metric")}</div>
        {levels.map((level) => (
          <div key={level} className="px-3 py-2 font-semibold text-muted-foreground text-center capitalize">
            {level}
          </div>
        ))}
      </div>
      {BENCHMARKS.map((row, idx) => (
        <div key={row.metric} className="grid grid-cols-5 border-t border-border/40">
          <div className="px-3 py-2">
            <span className="font-medium">{row.metric}</span>
            {row.subtitle && (
              <span className="block text-[10px] text-muted-foreground" title={t(row.subtitle)}>
                {t(row.subtitle)}
              </span>
            )}
          </div>
          {levels.map((level) => {
            const isCurrentLevel = currentLevels[idx] === level;
            return (
              <div
                key={level}
                className={cn(
                  "px-3 py-2 text-center text-muted-foreground",
                  isCurrentLevel && LEVEL_BG[level],
                  isCurrentLevel && "font-semibold text-foreground ring-1 ring-inset ring-current/20 rounded-lg"
                )}
              >
                {(row[level] || "").startsWith("bench.") ? t(row[level]) : row[level]}
              </div>
            );
          })}
        </div>
      ))}
      <div className="border-t border-border/40 px-3 py-2 text-[10px] text-muted-foreground italic space-y-1">
        <div>{t("bench.prt.note")}</div>
        <div>{t("bench.doraReference")}</div>
      </div>
    </div>
  );
}
