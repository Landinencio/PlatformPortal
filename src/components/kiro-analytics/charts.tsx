"use client";

/**
 * Shared visual primitives for the Kiro Analytics dashboards.
 *
 * These wrap the portal's shadcn/ui Card + Recharts so the migrated views keep
 * the portal look & feel (light/dark theme) without any Amplify styling.
 */

import { useState, type ReactNode } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { Loader2, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const CHART_COLORS = [
  "hsl(221 83% 60%)",
  "hsl(160 60% 45%)",
  "hsl(43 96% 56%)",
  "hsl(24 95% 58%)",
  "hsl(262 60% 58%)",
  "hsl(142 50% 55%)",
  "hsl(48 96% 60%)",
  "hsl(82 60% 55%)",
  "hsl(95 50% 58%)",
  "hsl(0 60% 65%)",
  "hsl(204 55% 60%)",
  "hsl(48 90% 40%)",
];

interface ChartCardProps {
  title: string;
  description?: string;
  loading?: boolean;
  empty?: boolean;
  emptyLabel: string;
  children: ReactNode;
  className?: string;
}

export function ChartCard({ title, description, loading, empty, emptyLabel, children, className }: ChartCardProps) {
  const [showDesc, setShowDesc] = useState(false);
  return (
    <Card className={cn("border-border/70", className)}>
      <CardHeader className="pb-2">
        <div className="relative inline-flex items-center gap-1.5">
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
          {description && (
            <button
              type="button"
              className="text-muted-foreground/60 hover:text-muted-foreground"
              onMouseEnter={() => setShowDesc(true)}
              onMouseLeave={() => setShowDesc(false)}
              aria-label="info"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          )}
          {showDesc && description && (
            <div className="absolute left-0 top-full z-50 mt-1 max-w-xs rounded-md border border-border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-lg">
              {description}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex h-[220px] items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : empty ? (
          <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">{emptyLabel}</div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

const axisProps = { tick: { fontSize: 10 }, stroke: "hsl(var(--muted-foreground))" } as const;
const tooltipStyle = {
  fontSize: 12,
  borderRadius: 8,
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--popover))",
  color: "hsl(var(--popover-foreground))",
} as const;

interface TrendPoint {
  date: string;
  value: number;
}

export function TrendLineChart({
  title,
  description,
  data,
  loading,
  emptyLabel,
  color = CHART_COLORS[0],
  area = false,
  height = 220,
}: {
  title: string;
  description?: string;
  data: TrendPoint[];
  loading?: boolean;
  emptyLabel: string;
  color?: string;
  area?: boolean;
  height?: number;
}) {
  return (
    <ChartCard title={title} description={description} loading={loading} empty={!data.length} emptyLabel={emptyLabel}>
      <ResponsiveContainer width="100%" height={height}>
        {area ? (
          <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`grad-${title.replace(/\W/g, "")}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.5} />
                <stop offset="95%" stopColor={color} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="date" {...axisProps} interval="preserveStartEnd" minTickGap={24} />
            <YAxis {...axisProps} width={48} />
            <Tooltip contentStyle={tooltipStyle} />
            <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill={`url(#grad-${title.replace(/\W/g, "")})`} />
          </AreaChart>
        ) : (
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="date" {...axisProps} interval="preserveStartEnd" minTickGap={24} />
            <YAxis {...axisProps} width={48} />
            <Tooltip contentStyle={tooltipStyle} />
            <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} />
          </LineChart>
        )}
      </ResponsiveContainer>
    </ChartCard>
  );
}

interface Distribution {
  name: string;
  value: number;
}

export function DonutChart({
  title,
  description,
  data,
  loading,
  emptyLabel,
}: {
  title: string;
  description?: string;
  data: Distribution[];
  loading?: boolean;
  emptyLabel: string;
}) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  return (
    <ChartCard title={title} description={description} loading={loading} empty={!data.length} emptyLabel={emptyLabel}>
      <div className="flex items-center gap-3">
        <ResponsiveContainer width="50%" height={200}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={45} outerRadius={80} paddingAngle={2}>
              {data.map((_, i) => (
                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value: number) => [`${value} (${((value / total) * 100).toFixed(1)}%)`, ""]}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="flex-1 space-y-1 overflow-y-auto max-h-[200px] pr-1">
          {data.map((d, i) => (
            <div key={d.name} className="flex items-center gap-2 text-xs">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
              <span className="flex-1 truncate text-muted-foreground">{d.name || "—"}</span>
              <span className="font-medium tabular-nums">
                {d.value} ({((d.value / total) * 100).toFixed(0)}%)
              </span>
            </div>
          ))}
        </div>
      </div>
    </ChartCard>
  );
}

interface Ranking {
  displayName: string;
  value: number;
}

export function RankingChart({
  title,
  description,
  data,
  loading,
  emptyLabel,
  color = CHART_COLORS[1],
}: {
  title: string;
  description?: string;
  data: Ranking[];
  loading?: boolean;
  emptyLabel: string;
  color?: string;
}) {
  return (
    <ChartCard title={title} description={description} loading={loading} empty={!data.length} emptyLabel={emptyLabel}>
      <ResponsiveContainer width="100%" height={Math.max(200, data.length * 28)}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
          <XAxis type="number" {...axisProps} />
          <YAxis type="category" dataKey="displayName" {...axisProps} width={150} tickFormatter={(v: string) => (v?.length > 22 ? `${v.slice(0, 20)}…` : v)} />
          <Tooltip contentStyle={tooltipStyle} />
          <Bar dataKey="value" fill={color} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export { Legend };
