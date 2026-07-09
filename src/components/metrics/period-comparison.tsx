"use client";

import { useState } from "react";
import { ArrowRight, TrendingUp, TrendingDown, Minus, X, BarChart3, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ComparisonMetrics {
  deploymentFrequency: number;
  leadTime: number;
  changeFailureRate: number;
  mttr: number;
  totalDeploys: number;
  failures: number;
}

interface PeriodComparisonProps {
  teams: string[];
  projectIds: string[];
  authors?: string[];
  onClose: () => void;
}

export function PeriodComparison({ teams, projectIds, authors = [], onClose }: PeriodComparisonProps) {
  const [periodAFrom, setPeriodAFrom] = useState("");
  const [periodATo, setPeriodATo] = useState("");
  const [periodBFrom, setPeriodBFrom] = useState("");
  const [periodBTo, setPeriodBTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ a: ComparisonMetrics; b: ComparisonMetrics } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canCompare = periodAFrom && periodATo && periodBFrom && periodBTo;

  const fetchPeriodMetrics = async (from: string, to: string): Promise<ComparisonMetrics> => {
    const diffMs = new Date(to).getTime() - new Date(from).getTime();
    const days = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

    const params = new URLSearchParams({ days: String(days), from, to });
    if (teams.length > 0) params.set("teams", teams.join(","));
    if (projectIds.length > 0) params.set("projectIds", projectIds.join(","));
    if (authors.length > 0) params.set("authors", authors.join(","));

    const res = await fetch(`/api/metrics/dora-core?${params}`);
    if (!res.ok) throw new Error("Error al obtener métricas");
    const data = await res.json();

    return {
      deploymentFrequency: data.summary?.deploymentFrequency?.current || 0,
      leadTime: data.summary?.leadTimeForChanges?.current || data.summary?.leadTimeFirstCommit?.current || 0,
      changeFailureRate: data.summary?.changeFailureRate?.current || 0,
      mttr: data.summary?.mttr?.current || 0,
      totalDeploys: data.summary?.totals?.deployments || 0,
      failures: data.summary?.totals?.failures || 0,
    };
  };

  const handleCompare = async () => {
    if (!canCompare) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const [a, b] = await Promise.all([
        fetchPeriodMetrics(periodAFrom, periodATo),
        fetchPeriodMetrics(periodBFrom, periodBTo),
      ]);
      setResult({ a, b });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  };

  const pctChange = (a: number, b: number) => {
    if (a === 0) return b > 0 ? 100 : 0;
    return ((b - a) / a) * 100;
  };

  const formatDuration = (hours: number) => {
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (hours < 24) return `${hours.toFixed(1)}h`;
    return `${(hours / 24).toFixed(1)}d`;
  };

  const MetricRow = ({
    label,
    valueA,
    valueB,
    format,
    inverse,
  }: {
    label: string;
    valueA: number;
    valueB: number;
    format: (v: number) => string;
    inverse?: boolean;
  }) => {
    const change = pctChange(valueA, valueB);
    const isImprovement = inverse ? change < 0 : change > 0;
    const isWorse = inverse ? change > 0 : change < 0;

    return (
      <div className="flex items-center gap-3 py-3 border-b last:border-0">
        <div className="w-40 text-sm font-medium text-foreground">{label}</div>
        <div className="flex-1 text-center">
          <span className="text-lg font-bold text-muted-foreground">{format(valueA)}</span>
        </div>
        <div className="w-8 flex justify-center">
          <ArrowRight className="h-4 w-4 text-muted-foreground/50" />
        </div>
        <div className="flex-1 text-center">
          <span className="text-lg font-bold text-foreground">{format(valueB)}</span>
        </div>
        <div className="w-24 text-right">
          {Math.abs(change) < 0.5 ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Minus className="h-3 w-3" /> 0%
            </span>
          ) : (
            <span className={cn(
              "inline-flex items-center gap-1 text-xs font-semibold",
              isImprovement ? "text-green-600" : isWorse ? "text-red-600" : "text-muted-foreground"
            )}>
              {isImprovement ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {change > 0 ? "+" : ""}{change.toFixed(1)}%
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <Card className="border-primary/20 bg-primary/[0.02] p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Comparar periodos</h3>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-muted transition-colors">
          <X className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      {/* Date selectors */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2 rounded-lg border border-border p-3 bg-background">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Periodo A</label>
          <div className="flex gap-2">
            <input
              type="date"
              value={periodAFrom}
              onChange={(e) => setPeriodAFrom(e.target.value)}
              className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <span className="self-center text-xs text-muted-foreground">→</span>
            <input
              type="date"
              value={periodATo}
              onChange={(e) => setPeriodATo(e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
              className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
        </div>
        <div className="space-y-2 rounded-lg border border-primary/30 p-3 bg-primary/5">
          <label className="text-xs font-medium text-primary uppercase tracking-wide">Periodo B</label>
          <div className="flex gap-2">
            <input
              type="date"
              value={periodBFrom}
              onChange={(e) => setPeriodBFrom(e.target.value)}
              className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <span className="self-center text-xs text-muted-foreground">→</span>
            <input
              type="date"
              value={periodBTo}
              onChange={(e) => setPeriodBTo(e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
              className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
        </div>
      </div>

      <Button
        onClick={handleCompare}
        disabled={!canCompare || loading}
        size="sm"
        className="w-full gap-2"
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BarChart3 className="h-3.5 w-3.5" />}
        {loading ? "Comparando..." : "Comparar"}
      </Button>

      {error && (
        <p className="text-xs text-red-600 text-center">{error}</p>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-1 pt-2">
          <div className="flex items-center gap-3 pb-2 border-b text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <div className="w-40">Métrica</div>
            <div className="flex-1 text-center">Periodo A</div>
            <div className="w-8" />
            <div className="flex-1 text-center">Periodo B</div>
            <div className="w-24 text-right">Cambio</div>
          </div>

          <MetricRow
            label="Deploy Frequency"
            valueA={result.a.deploymentFrequency}
            valueB={result.b.deploymentFrequency}
            format={(v) => `${v.toFixed(2)}/día`}
          />
          <MetricRow
            label="Lead Time"
            valueA={result.a.leadTime}
            valueB={result.b.leadTime}
            format={formatDuration}
            inverse
          />
          <MetricRow
            label="Change Failure Rate"
            valueA={result.a.changeFailureRate}
            valueB={result.b.changeFailureRate}
            format={(v) => `${v.toFixed(1)}%`}
            inverse
          />
          <MetricRow
            label="MTTR"
            valueA={result.a.mttr}
            valueB={result.b.mttr}
            format={formatDuration}
            inverse
          />

          {/* Summary stats */}
          <div className="grid grid-cols-2 gap-3 pt-3 mt-2 border-t">
            <div className="text-center">
              <div className="text-xs text-muted-foreground">Deploys (A)</div>
              <div className="text-sm font-bold">{result.a.totalDeploys}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-muted-foreground">Deploys (B)</div>
              <div className="text-sm font-bold">{result.b.totalDeploys}</div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
