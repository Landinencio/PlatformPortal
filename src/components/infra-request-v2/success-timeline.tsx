"use client";

import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

const STAGES = ["pending", "approved", "executed", "mr_created"] as const;

type Stage = (typeof STAGES)[number];

const STAGE_I18N_KEYS: Record<Stage, string> = {
  pending: "infra.success.timeline.pending",
  approved: "infra.success.timeline.approval",
  executed: "infra.success.timeline.execution",
  mr_created: "infra.success.timeline.mrCreated",
};

export function SuccessTimeline({ activeStage }: { activeStage: Stage }) {
  const { t } = useI18n();
  const activeIndex = STAGES.indexOf(activeStage);

  return (
    <div className="flex items-center justify-between w-full max-w-md mx-auto py-4">
      {STAGES.map((stage, idx) => {
        const isCompleted = idx < activeIndex;
        const isActive = idx === activeIndex;
        const isFuture = idx > activeIndex;

        return (
          <div key={stage} className="flex items-center flex-1 last:flex-none">
            {/* Stage circle + label */}
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium border-2 transition-colors",
                  isCompleted && "bg-primary border-primary text-primary-foreground",
                  isActive && "border-primary bg-primary/10 text-primary",
                  isFuture && "border-muted-foreground/30 bg-muted text-muted-foreground"
                )}
              >
                {isCompleted ? <Check className="h-4 w-4" /> : idx + 1}
              </div>
              <span
                className={cn(
                  "text-[10px] font-medium text-center whitespace-nowrap",
                  isCompleted && "text-primary",
                  isActive && "text-primary",
                  isFuture && "text-muted-foreground"
                )}
              >
                {t(STAGE_I18N_KEYS[stage])}
              </span>
            </div>

            {/* Connecting line */}
            {idx < STAGES.length - 1 && (
              <div
                className={cn(
                  "flex-1 h-0.5 mx-2 mt-[-1.25rem]",
                  idx < activeIndex ? "bg-primary" : "bg-muted-foreground/20"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
