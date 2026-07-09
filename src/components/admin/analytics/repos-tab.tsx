"use client";

import { useState, useEffect, useCallback } from "react";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import { GitBranch, Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { KpiCard } from "@/components/admin/analytics/kpi-card";
import { AnalyticsSkeleton } from "@/components/admin/analytics/analytics-skeleton";
import { ErrorCard } from "@/components/admin/analytics/error-card";
import type { TrendData } from "@/lib/admin-analytics";

interface Props {
  days: number;
  refreshKey: number;
}

export function ReposTab({ days, refreshKey }: Props) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/admin/analytics/repos?days=${days}`);
      if (!res.ok) throw new Error();
      const json = await res.json();
      setData(json.data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [days, refreshKey]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) return <AnalyticsSkeleton />;
  if (error || !data) return <ErrorCard onRetry={fetchData} />;

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-2 gap-3">
        <KpiCard
          label="Repos creados"
          value={data.kpis.totalCreated}
          icon={GitBranch}
          trend={data.trends?.totalCreated ?? null}
        />
        <KpiCard
          label="Creadores únicos"
          value={data.kpis.uniqueCreators}
          icon={Users}
          trend={data.trends?.uniqueCreators ?? null}
        />
      </div>

      {/* Daily Volume Line Chart */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Repos creados por día</h3>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data.dailyVolume}>
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Legend />
            <Line
              type="monotone"
              dataKey="count"
              name="Repos"
              stroke="#6366f1"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      {/* Top Creators Table */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Top creadores</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 font-medium">Nombre</th>
                <th className="pb-2 font-medium text-right">Repos creados</th>
              </tr>
            </thead>
            <tbody>
              {data.topCreators?.map((row: any, idx: number) => (
                <tr key={idx} className="border-b last:border-0">
                  <td className="py-2 truncate max-w-[200px]">{row.name || row.email}</td>
                  <td className="py-2 text-right font-medium">{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
