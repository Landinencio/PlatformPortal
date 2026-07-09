"use client";

import { useState, type ReactNode } from "react";
import { Loader2, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export function StatCard({
  title,
  value,
  loading,
  description,
  icon,
  highlight,
}: {
  title: string;
  value: number | string;
  loading?: boolean;
  description?: string;
  icon?: ReactNode;
  highlight?: boolean;
}) {
  const [showDesc, setShowDesc] = useState(false);
  const display = typeof value === "number" ? value.toLocaleString() : value;
  return (
    <Card className={highlight ? "border-violet-500/30 bg-violet-500/5" : "border-border/60"}>
      <CardContent className="p-4 space-y-1">
        <div className="relative flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
          {icon}
          <span>{title}</span>
          {description && (
            <button
              type="button"
              className="text-muted-foreground/50 hover:text-muted-foreground"
              onMouseEnter={() => setShowDesc(true)}
              onMouseLeave={() => setShowDesc(false)}
              aria-label="info"
            >
              <Info className="h-3 w-3" />
            </button>
          )}
          {showDesc && description && (
            <div className="absolute left-0 top-full z-50 mt-1 max-w-xs rounded-md border border-border bg-popover px-3 py-2 text-[11px] normal-case leading-relaxed tracking-normal text-popover-foreground shadow-lg">
              {description}
            </div>
          )}
        </div>
        {loading ? (
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        ) : (
          <div className={highlight ? "text-2xl font-bold text-violet-600" : "text-2xl font-bold"}>{display}</div>
        )}
      </CardContent>
    </Card>
  );
}
