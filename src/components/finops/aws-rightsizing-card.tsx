"use client";

import { useEffect, useState } from "react";
import { Loader2, Wrench, TrendingDown } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface AwsRightsizingItem {
  type: string;
  accountId: string;
  instanceId: string;
  currentType: string;
  currentMonthlyCost: number;
  suggestedType: string | null;
  suggestedMonthlyCost: number;
  estimatedSavings: number;
}

interface ForecastResponse {
  rightsizing?: {
    totalRecommendations: number;
    summary: {
      terminateCount: number;
      modifyCount: number;
      estimatedMonthlySavings: number;
    };
    recommendations: AwsRightsizingItem[];
  };
}

function fmt$(v: number) {
  if (!Number.isFinite(v)) return "—";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function AwsRightsizingCard({ selectedAccountIds }: { selectedAccountIds: string[] }) {
  const [data, setData] = useState<ForecastResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Join the ids for a stable effect dependency.
  const accountIdsKey = selectedAccountIds.join(",");

  useEffect(() => {
    setLoading(true);
    // Scope the forecast request to the selected accounts. The forecast route
    // switches to scoped Cost Explorer (Path 3) when `accountIds` is present.
    let url = "/api/finops/forecast?months=3";
    if (selectedAccountIds.length > 0) {
      url += `&accountIds=${selectedAccountIds.join(",")}`;
    }
    fetch(url)
      .then((r) => r.json())
      .then(setData)
      .catch(() => null)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountIdsKey]);

  if (loading) {
    return (
      <Card className="border-border/70">
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const rs = data?.rightsizing;
  if (!rs) return null;

  // Defensive client-side scoping: drop any recommendation whose account is not
  // in the selected set (belt-and-suspenders against an org-wide payload).
  const filtered = rs.recommendations.filter(
    (r) => selectedAccountIds.length === 0 || selectedAccountIds.includes(r.accountId),
  );
  if (filtered.length === 0) return null;

  // Recompute the displayed summary counters from the in-scope rows only.
  const terminateCount = filtered.filter((r) => r.type === "Terminate").length;
  const modifyCount = filtered.length - terminateCount;
  const estimatedMonthlySavings = filtered.reduce((sum, r) => sum + (r.estimatedSavings || 0), 0);

  return (
    <Card className="border-success/30 bg-success/5">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2 text-success">
              <Wrench className="h-4 w-4" />
              AWS Rightsizing Recommendations
            </CardTitle>
            <CardDescription>
              {terminateCount} para terminar · {modifyCount} para modificar · top {filtered.length}
            </CardDescription>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-success">{fmt$(estimatedMonthlySavings)}</div>
            <div className="text-[10px] uppercase text-muted-foreground">ahorro AWS / mes</div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto max-h-80 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border/50 text-muted-foreground">
                <th className="px-2 py-1.5 text-left">Acción</th>
                <th className="px-2 py-1.5 text-left">Instance</th>
                <th className="px-2 py-1.5 text-left">Tipo actual</th>
                <th className="px-2 py-1.5 text-left">Sugerido</th>
                <th className="px-2 py-1.5 text-right">Coste actual</th>
                <th className="px-2 py-1.5 text-right">Ahorro</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 25).map((r, i) => {
                const isTerminate = r.type === "Terminate";
                return (
                  <tr key={`${r.instanceId}-${i}`} className="border-b border-border/30 hover:bg-muted/20">
                    <td className="px-2 py-1.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${isTerminate ? "bg-danger/15 text-danger" : "bg-info/15 text-info"}`}>
                        {r.type}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[11px] truncate max-w-[160px]" title={r.instanceId}>
                      {r.instanceId}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[11px]">{r.currentType || "—"}</td>
                    <td className="px-2 py-1.5 font-mono text-[11px] text-success">
                      {r.suggestedType || (isTerminate ? "(eliminar)" : "—")}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt$(r.currentMonthlyCost)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-success">
                      <TrendingDown className="inline h-3 w-3 mr-0.5" />
                      {fmt$(r.estimatedSavings)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
