"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function StaleDataBanner() {
  const [staleInfo, setStaleInfo] = useState<{ stale: boolean; latestSnapshot: string | null }>({
    stale: false,
    latestSnapshot: null,
  });
  const { t } = useI18n();

  useEffect(() => {
    checkFreshness();
  }, []);

  async function checkFreshness() {
    try {
      const res = await fetch("/api/metrics/deployment-frequency?days=3");
      if (!res.ok) return;
      const data = await res.json();
      const latest = data?.meta?.latestSnapshot;
      if (!latest) {
        setStaleInfo({ stale: true, latestSnapshot: null });
        return;
      }
      const hoursAgo = (Date.now() - new Date(latest).getTime()) / (1000 * 60 * 60);
      setStaleInfo({ stale: hoursAgo > 36, latestSnapshot: latest });
    } catch {
      // silently ignore
    }
  }

  if (!staleInfo.stale) return null;

  return (
    <div className="border-b border-warning/30 bg-warning/8 px-4 py-2.5 flex items-center gap-2 text-xs text-warning">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span>
        {t("stale.message")}
        {staleInfo.latestSnapshot && ` ${t("stale.lastSnapshot")} ${staleInfo.latestSnapshot}.`}
        {" "}{t("stale.cronInfo")}
      </span>
    </div>
  );
}
