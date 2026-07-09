"use client";

import { ArrowDown, ArrowUp, TrendingDown, TrendingUp } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface TopMover {
  service: string;
  change: number;
  percentage: number;
  accountId?: string;
}

interface Props {
  topMovers: { increases: TopMover[]; decreases: TopMover[] };
}

function fmt$(v: number) {
  if (!Number.isFinite(v)) return "—";
  return `$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function CostMoversCard({ topMovers }: Props) {
  const inc = (topMovers?.increases || []).filter((m) => m.change > 0).slice(0, 5);
  const dec = (topMovers?.decreases || []).filter((m) => m.change < 0).slice(0, 5);
  if (inc.length === 0 && dec.length === 0) return null;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="border-warning/30 bg-warning/5">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2 text-warning">
            <TrendingUp className="h-4 w-4" />
            Servicios con mayor incremento
          </CardTitle>
          <CardDescription>Top 5 servicios que más han subido vs periodo anterior</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {inc.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">Sin incrementos significativos</div>
          ) : (
            inc.map((m, i) => {
              const max = Math.abs(inc[0].change) || 1;
              const widthPct = Math.max(8, (Math.abs(m.change) / max) * 100);
              return (
                <div key={`${m.service}-${i}`} className="flex items-center gap-3">
                  <span className="text-xs font-medium w-32 truncate text-right" title={m.service}>{m.service}</span>
                  <div className="flex-1 h-6 bg-muted/30 rounded-md overflow-hidden relative">
                    <div className="h-full bg-gradient-to-r from-warning/80 to-warning/40" style={{ width: `${widthPct}%` }} />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold flex items-center gap-1">
                      <ArrowUp className="h-3 w-3 text-warning" />
                      {fmt$(m.change)} ({m.percentage > 0 ? "+" : ""}{m.percentage.toFixed(1)}%)
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card className="border-success/30 bg-success/5">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2 text-success">
            <TrendingDown className="h-4 w-4" />
            Servicios con mayor reducción
          </CardTitle>
          <CardDescription>Top 5 servicios que más han bajado vs periodo anterior</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {dec.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">Sin reducciones significativas</div>
          ) : (
            dec.map((m, i) => {
              const max = Math.abs(dec[0].change) || 1;
              const widthPct = Math.max(8, (Math.abs(m.change) / max) * 100);
              return (
                <div key={`${m.service}-${i}`} className="flex items-center gap-3">
                  <span className="text-xs font-medium w-32 truncate text-right" title={m.service}>{m.service}</span>
                  <div className="flex-1 h-6 bg-muted/30 rounded-md overflow-hidden relative">
                    <div className="h-full bg-gradient-to-r from-success/80 to-success/40" style={{ width: `${widthPct}%` }} />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold flex items-center gap-1">
                      <ArrowDown className="h-3 w-3 text-success" />
                      {fmt$(m.change)} ({m.percentage.toFixed(1)}%)
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
