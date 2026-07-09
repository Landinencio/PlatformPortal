"use client";

import { useState, useEffect, useCallback } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import { ShieldCheck, UserPlus, UserMinus, CheckCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { KpiCard } from "@/components/admin/analytics/kpi-card";
import { AnalyticsSkeleton } from "@/components/admin/analytics/analytics-skeleton";
import { ErrorCard } from "@/components/admin/analytics/error-card";
import type { TrendData } from "@/lib/admin-analytics";

interface Props {
  days: number;
  refreshKey: number;
}

const COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4"];

export function AccessTab({ days, refreshKey }: Props) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/admin/analytics/access?days=${days}`);
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
          label="Total solicitudes"
          value={data.kpis.totalRequests}
          icon={ShieldCheck}
          trend={data.trends?.totalRequests ?? null}
        />
        <KpiCard
          label="Altas"
          value={data.kpis.grantCount}
          icon={UserPlus}
          trend={data.trends?.grantCount ?? null}
        />
        <KpiCard
          label="Bajas"
          value={data.kpis.revokeCount}
          icon={UserMinus}
          trend={data.trends?.revokeCount ?? null}
        />
        <KpiCard
          label="Ejecutadas"
          value={data.kpis.executedCount}
          icon={CheckCircle}
          trend={data.trends?.executedCount ?? null}
        />
      </div>

      {/* By Platform Bar Chart */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Por plataforma</h3>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data.byPlatform}>
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            <XAxis dataKey="platform" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="count" name="Solicitudes" fill="#6366f1" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {/* Daily Volume Line Chart */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Volumen diario</h3>
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
              name="Solicitudes"
              stroke="#6366f1"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      {/* Top Requestors Table */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Top solicitantes</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 font-medium">Nombre</th>
                <th className="pb-2 font-medium text-right">Solicitudes</th>
              </tr>
            </thead>
            <tbody>
              {data.topRequestors?.map((row: any, idx: number) => (
                <tr key={idx} className="border-b last:border-0">
                  <td className="py-2 truncate max-w-[200px]">{row.name || row.email}</td>
                  <td className="py-2 text-right font-medium">{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Status Distribution Donut Chart */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Distribución por estado</h3>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={data.statusDistribution}
              dataKey="count"
              nameKey="status"
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={100}
              label={({ status, count }) => `${status}: ${count}`}
            >
              {data.statusDistribution?.map((_: any, idx: number) => (
                <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </Card>
    </div>
  );
}
