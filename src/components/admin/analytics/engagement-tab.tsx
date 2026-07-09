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
import { Users, Monitor, Eye, Clock, LogIn } from "lucide-react";
import { Card } from "@/components/ui/card";
import { KpiCard } from "@/components/admin/analytics/kpi-card";
import { AnalyticsSkeleton } from "@/components/admin/analytics/analytics-skeleton";
import { ErrorCard } from "@/components/admin/analytics/error-card";
import type { TrendData } from "@/lib/admin-analytics";

interface Props {
  days: number;
  refreshKey: number;
}

export function EngagementTab({ days, refreshKey }: Props) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/admin/analytics/engagement?days=${days}`);
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
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard
          label="Usuarios únicos"
          value={data.kpis.uniqueUsers}
          icon={Users}
          trend={data.trends?.uniqueUsers ?? null}
        />
        <KpiCard
          label="Sesiones"
          value={data.kpis.totalSessions}
          icon={Monitor}
          trend={data.trends?.totalSessions ?? null}
        />
        <KpiCard
          label="Page views"
          value={data.kpis.totalPageViews}
          icon={Eye}
          trend={data.trends?.totalPageViews ?? null}
        />
        <KpiCard
          label="Duración media"
          value={`${data.kpis.avgSessionDuration}m`}
          icon={Clock}
          trend={data.trends?.avgSessionDuration ?? null}
        />
        <KpiCard
          label="Logins"
          value={data.kpis.totalLogins}
          icon={LogIn}
          trend={data.trends?.totalLogins ?? null}
        />
      </div>

      {/* Daily Active Users Line Chart */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Usuarios activos diarios</h3>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data.dailyActiveUsers}>
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Legend />
            <Line
              type="monotone"
              dataKey="count"
              name="Usuarios activos"
              stroke="#6366f1"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      {/* Section Views Bar Chart */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Vistas por sección</h3>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data.sectionViews}>
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            <XAxis dataKey="section" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="views" name="Vistas" fill="#8b5cf6" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {/* Top 10 Paths Table */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Top 10 rutas más visitadas</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 font-medium">Ruta</th>
                <th className="pb-2 font-medium text-right">Vistas</th>
                <th className="pb-2 font-medium text-right">Usuarios únicos</th>
              </tr>
            </thead>
            <tbody>
              {data.topPaths?.slice(0, 10).map((row: any, idx: number) => (
                <tr key={idx} className="border-b last:border-0">
                  <td className="py-2 font-mono text-xs truncate max-w-[300px]">{row.path}</td>
                  <td className="py-2 text-right">{row.views.toLocaleString("es-ES")}</td>
                  <td className="py-2 text-right">{row.uniqueUsers.toLocaleString("es-ES")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* User Ranking Table */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Ranking de usuarios (Top 20)</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 font-medium">Nombre</th>
                <th className="pb-2 font-medium">Rol</th>
                <th className="pb-2 font-medium text-right">Eventos</th>
                <th className="pb-2 font-medium text-right">Sesiones</th>
                <th className="pb-2 font-medium text-right">Minutos</th>
                <th className="pb-2 font-medium text-right">Última vez</th>
              </tr>
            </thead>
            <tbody>
              {data.userRanking?.slice(0, 20).map((row: any, idx: number) => (
                <tr key={idx} className="border-b last:border-0">
                  <td className="py-2 truncate max-w-[180px]">{row.name || row.email}</td>
                  <td className="py-2">{row.role}</td>
                  <td className="py-2 text-right">{row.totalEvents.toLocaleString("es-ES")}</td>
                  <td className="py-2 text-right">{row.sessionCount.toLocaleString("es-ES")}</td>
                  <td className="py-2 text-right">{row.totalMinutes.toLocaleString("es-ES")}</td>
                  <td className="py-2 text-right text-muted-foreground">
                    {new Date(row.lastSeen).toLocaleDateString("es-ES")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Hourly Distribution Bar Chart */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Distribución horaria</h3>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data.hourlyDistribution}>
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            <XAxis dataKey="hour" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="count" name="Eventos" fill="#06b6d4" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>
    </div>
  );
}
