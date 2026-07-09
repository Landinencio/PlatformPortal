"use client";

import { useState, useEffect, useCallback } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import { CheckCircle, Percent, Clock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { KpiCard } from "@/components/admin/analytics/kpi-card";
import { AnalyticsSkeleton } from "@/components/admin/analytics/analytics-skeleton";
import { ErrorCard } from "@/components/admin/analytics/error-card";
import type { TrendData } from "@/lib/admin-analytics";

interface Props {
  days: number;
  refreshKey: number;
}

export function ApprovalsTab({ days, refreshKey }: Props) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/admin/analytics/approvals?days=${days}`);
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label="Total reviews"
          value={data.kpis.totalReviews}
          icon={CheckCircle}
          trend={data.trends?.totalReviews ?? null}
        />
        <KpiCard
          label="Tasa aprobación"
          value={`${data.kpis.approvalRate}%`}
          icon={Percent}
          trend={data.trends?.approvalRate ?? null}
        />
        <KpiCard
          label="Tiempo medio"
          value={`${data.kpis.avgTimeToReview}h`}
          icon={Clock}
          trend={data.trends?.avgTimeToReview ?? null}
        />
        <KpiCard
          label="Pendientes"
          value={data.kpis.pendingCount}
          icon={Clock}
          trend={data.trends?.pendingCount ?? null}
        />
      </div>

      {/* Top Reviewers Table */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Top revisores</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 font-medium">Nombre</th>
                <th className="pb-2 font-medium text-right">Aprobadas</th>
                <th className="pb-2 font-medium text-right">Rechazadas</th>
                <th className="pb-2 font-medium text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.topReviewers?.map((row: any, idx: number) => (
                <tr key={idx} className="border-b last:border-0">
                  <td className="py-2 truncate max-w-[200px]">{row.name || row.email}</td>
                  <td className="py-2 text-right text-green-600">{row.approved}</td>
                  <td className="py-2 text-right text-red-600">{row.rejected}</td>
                  <td className="py-2 text-right font-medium">{row.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Approval Rate by Team Bar Chart */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Tasa de aprobación por equipo</h3>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data.approvalRateByTeam}>
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            <XAxis dataKey="team" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} unit="%" />
            <Tooltip formatter={(value: number) => `${value}%`} />
            <Bar dataKey="rate" name="Tasa aprobación" fill="#10b981" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {/* Daily Volume Line Chart (approved vs rejected) */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Volumen diario de revisiones</h3>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data.dailyVolume}>
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Legend />
            <Line
              type="monotone"
              dataKey="approved"
              name="Aprobadas"
              stroke="#10b981"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="rejected"
              name="Rechazadas"
              stroke="#ef4444"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </Card>
    </div>
  );
}
