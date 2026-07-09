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
import { Users, Activity, Ticket, ShieldCheck, Cloud } from "lucide-react";
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

export function OverviewTab({ days, refreshKey }: Props) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/admin/analytics/overview?days=${days}`);
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
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard
          label="Usuarios totales"
          value={data.kpis.totalUsers}
          icon={Users}
          trend={data.trends?.totalUsers ?? null}
        />
        <KpiCard
          label="Activos 7d"
          value={data.kpis.activeUsers7d}
          icon={Activity}
          trend={data.trends?.activeUsers7d ?? null}
        />
        <KpiCard
          label="Activos 30d"
          value={data.kpis.activeUsers30d}
          icon={Activity}
          trend={data.trends?.activeUsers30d ?? null}
        />
        <KpiCard
          label="Tickets"
          value={data.kpis.totalTickets}
          icon={Ticket}
          trend={data.trends?.totalTickets ?? null}
        />
        <KpiCard
          label="Accesos"
          value={data.kpis.totalAccessRequests}
          icon={ShieldCheck}
          trend={data.trends?.totalAccessRequests ?? null}
        />
        <KpiCard
          label="Infra"
          value={data.kpis.totalInfraRequests}
          icon={Cloud}
          trend={data.trends?.totalInfraRequests ?? null}
        />
      </div>

      {/* Weekly Active Users Line Chart */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Usuarios activos semanales</h3>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data.weeklyActiveUsers}>
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            <XAxis dataKey="week" tick={{ fontSize: 11 }} />
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Role Distribution Pie Chart */}
        <Card className="p-4">
          <h3 className="text-sm font-medium mb-3">Distribución por rol</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={data.roleDistribution}
                dataKey="count"
                nameKey="role"
                cx="50%"
                cy="50%"
                outerRadius={100}
                label={({ role, count }) => `${role}: ${count}`}
              >
                {data.roleDistribution?.map((_: any, idx: number) => (
                  <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </Card>

        {/* Peak Hours Bar Chart */}
        <Card className="p-4">
          <h3 className="text-sm font-medium mb-3">Horas pico de actividad</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data.peakHours}>
              <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
              <XAxis dataKey="hour" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="count" name="Eventos" fill="#6366f1" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Users List Table */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Usuarios que han accedido ({data.usersList?.length || 0})</h3>
        <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 font-medium">Nombre</th>
                <th className="pb-2 font-medium">Email</th>
                <th className="pb-2 font-medium">Rol</th>
                <th className="pb-2 font-medium text-right">Eventos</th>
                <th className="pb-2 font-medium text-right">Último acceso</th>
              </tr>
            </thead>
            <tbody>
              {data.usersList?.map((user: any, idx: number) => (
                <tr key={idx} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="py-2 font-medium truncate max-w-[150px]">{user.name}</td>
                  <td className="py-2 text-muted-foreground truncate max-w-[200px]">{user.email}</td>
                  <td className="py-2">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary capitalize">
                      {user.role}
                    </span>
                  </td>
                  <td className="py-2 text-right">{user.totalEvents.toLocaleString("es-ES")}</td>
                  <td className="py-2 text-right text-muted-foreground">
                    {new Date(user.lastSeen).toLocaleDateString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
