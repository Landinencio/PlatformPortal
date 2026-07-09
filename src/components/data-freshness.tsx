"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Circle } from "lucide-react";
import { useI18n } from "@/lib/i18n";

type FreshnessState = "fresh" | "stale" | "unknown";

export function DataFreshness({ collapsed = false }: { collapsed?: boolean }) {
  const [latestSnapshot, setLatestSnapshot] = useState<string | null>(null);
  const [state, setState] = useState<FreshnessState>("unknown");
  const { t } = useI18n();

  useEffect(() => {
    fetchFreshness();
    const interval = setInterval(fetchFreshness, 5 * 60 * 1000); // refresh every 5 min
    return () => clearInterval(interval);
  }, []);

  async function fetchFreshness() {
    try {
      const res = await fetch("/api/metrics/deployment-frequency?days=3");
      if (!res.ok) return;
      const data = await res.json();
      const latest = data?.meta?.latestSnapshot;
      if (!latest) {
        setState("unknown");
        return;
      }
      setLatestSnapshot(latest);

      const snapshotDate = new Date(latest);
      const hoursAgo = (Date.now() - snapshotDate.getTime()) / (1000 * 60 * 60);
      setState(hoursAgo <= 36 ? "fresh" : "stale");
    } catch {
      setState("unknown");
    }
  }

  const dotColor = {
    fresh: "text-success",
    stale: "text-warning",
    unknown: "text-muted-foreground/50",
  }[state];

  const label = latestSnapshot
    ? `${t("data.label")}: ${latestSnapshot}`
    : t("data.noRecent");

  if (collapsed) {
    return (
      <div className="flex justify-center py-1" title={label}>
        <Circle className={cn("h-2.5 w-2.5 fill-current", dotColor)} />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] text-muted-foreground" title={label}>
      <Circle className={cn("h-2 w-2 fill-current shrink-0", dotColor)} />
      <span className="truncate">{label}</span>
    </div>
  );
}
