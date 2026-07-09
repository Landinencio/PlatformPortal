"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface AnomalyAttribution {
  day: string;
  cost: number;
  deviation: number;
  topServices: Array<{ service: string; cost: number }>;
  topResources: Array<{ resourceId: string; service: string; cost: number; account: string }>;
}

interface DailyCostPoint { day: string; cost: number; netCost?: number }

interface Props {
  anomalies: AnomalyAttribution[];
  dailyCosts: DailyCostPoint[];
}

function fmt$(v: number) {
  if (!Number.isFinite(v)) return "—";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function AnomalyTimelineCard({ anomalies, dailyCosts }: Props) {
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  if (!anomalies || anomalies.length === 0) return null;

  const flaggedSet = new Set(anomalies.map((a) => a.day));
  const dailyMax = Math.max(...dailyCosts.map((d) => d.cost), 1);
  const sortedFlagged = [...anomalies].sort((a, b) => b.cost - a.cost);

  return (
    <Card className="border-danger/30 bg-danger/5">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2 text-danger">
              <AlertTriangle className="h-4 w-4" />
              Anomalías de coste detectadas
            </CardTitle>
            <CardDescription>
              {anomalies.length} día{anomalies.length !== 1 ? "s" : ""} con coste anómalo (μ + 2σ por encima de la media)
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Daily timeline */}
        <div className="flex items-end gap-px h-16 border-b border-border/40 pb-1 mb-3">
          {dailyCosts.map((d) => {
            const isFlagged = flaggedSet.has(d.day);
            const heightPct = Math.max(4, (d.cost / dailyMax) * 100);
            const isExpanded = expandedDay === d.day;
            return (
              <button
                key={d.day}
                type="button"
                onClick={() => isFlagged && setExpandedDay(isExpanded ? null : d.day)}
                className={cn(
                  "flex-1 transition-colors",
                  isFlagged
                    ? "bg-danger/80 hover:bg-danger ring-1 ring-danger cursor-pointer"
                    : "bg-primary/30",
                  isExpanded && "ring-2 ring-foreground",
                )}
                style={{ height: `${heightPct}%` }}
                title={`${d.day}: ${fmt$(d.cost)}${isFlagged ? " — clic para ver causa" : ""}`}
              />
            );
          })}
        </div>

        {/* Anomaly details */}
        <div className="space-y-2">
          {sortedFlagged.map((a) => {
            const isOpen = expandedDay === a.day;
            return (
              <div key={a.day} className="rounded-lg border border-danger/20 bg-card overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExpandedDay(isOpen ? null : a.day)}
                  className="flex w-full items-center justify-between p-2.5 hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className="border-danger/40 text-danger text-[10px]">
                      {new Date(a.day + "T00:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "2-digit" })}
                    </Badge>
                    <span className="text-sm font-semibold">{fmt$(a.cost)}</span>
                    <span className="text-xs text-muted-foreground">{a.deviation.toFixed(1)}σ</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {a.topServices.length > 0 && !isOpen && (
                      <span className="text-[11px] text-muted-foreground">
                        Top: <strong className="text-foreground">{a.topServices[0].service}</strong> ({fmt$(a.topServices[0].cost)})
                      </span>
                    )}
                    {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  </div>
                </button>
                {isOpen && (
                  <div className="border-t border-border/40 grid gap-3 p-3 md:grid-cols-2">
                    {/* Top services */}
                    <div>
                      <div className="text-[10px] uppercase font-semibold text-muted-foreground mb-1.5">Top servicios del día</div>
                      <div className="space-y-1">
                        {a.topServices.map((s) => {
                          const max = a.topServices[0]?.cost || 1;
                          const widthPct = Math.max(8, (s.cost / max) * 100);
                          return (
                            <div key={s.service} className="flex items-center gap-2">
                              <span className="text-xs w-32 truncate text-right">{s.service}</span>
                              <div className="flex-1 h-5 bg-muted/30 rounded overflow-hidden relative">
                                <div className="h-full bg-danger/40" style={{ width: `${widthPct}%` }} />
                                <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] font-semibold">{fmt$(s.cost)}</span>
                              </div>
                            </div>
                          );
                        })}
                        {a.topServices.length === 0 && <div className="text-xs text-muted-foreground">No disponible</div>}
                      </div>
                    </div>
                    {/* Top resources */}
                    <div>
                      <div className="text-[10px] uppercase font-semibold text-muted-foreground mb-1.5">Top recursos del día</div>
                      <div className="space-y-1">
                        {a.topResources.slice(0, 5).map((r, i) => (
                          <div key={`${r.resourceId}-${i}`} className="flex items-center justify-between text-xs">
                            <div className="min-w-0 flex-1">
                              <div className="font-mono text-[11px] truncate" title={r.resourceId}>
                                {r.resourceId.split("/").pop() || r.resourceId.slice(0, 40)}
                              </div>
                              <div className="text-[10px] text-muted-foreground">{r.service} · {r.account}</div>
                            </div>
                            <span className="font-semibold ml-2 whitespace-nowrap">{fmt$(r.cost)}</span>
                          </div>
                        ))}
                        {a.topResources.length === 0 && <div className="text-xs text-muted-foreground">No disponible</div>}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
