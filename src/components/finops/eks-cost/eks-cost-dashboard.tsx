"use client";

/**
 * EksCostDashboard — container for the "EKS Allocation" tab.
 *
 * Fetches `/api/finops/k8s-cost` and lays the results out into a rich,
 * visually layered dashboard:
 *
 *   Row 1  — FiltersBar (sticky-ish header) + warnings banner.
 *   Row 2  — KpiBar with the hero cost card + secondary KPIs.
 *   Row 3  — Cost by environment (donut) | Spot coverage per cluster (gauges).
 *   Row 4  — Squad attribution (podium bars, full width).
 *   Row 5  — Nodegroup breakdown (stacked bars with per-row captions).
 *   Row 6  — Efficiency scatter (workloads).
 *   Row 7  — Recommendations table + Detail panel (Sheet).
 *
 * All the visual heavy lifting lives in the child components + `theme.ts`;
 * this container only owns state (filters, selected recommendation,
 * loading/error/empty branches) and orchestration.
 *
 * Validates: Requirements 1.7, 6.4, 6.5, 8.3, 8.4, 8.5, 9.4, 9.5.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  AllocationResponse,
  EnvironmentName,
  Filters,
  Recommendation,
} from "@/lib/eks-cost/types";

import { CostByEnvironmentChart } from "./cost-by-environment-chart";
import { EfficiencyScatterChart } from "./efficiency-scatter-chart";
import { FiltersBar } from "./filters-bar";
import { KpiBar } from "./kpi-bar";
import { NodegroupBreakdownChart } from "./nodegroup-breakdown-chart";
import { RecommendationDetailPanel } from "./recommendation-detail-panel";
import { RecommendationsTable } from "./recommendations-table";
import { SpotCoveragePanel } from "./spot-coverage-panel";
import { SquadAttributionChart } from "./squad-attribution-chart";

export interface EksCostDashboardProps {
  className?: string;
}

/**
 * Build the querystring for the k8s-cost endpoint from the current filters.
 * Undefined / empty values are omitted so we don't send `?env=` (which the
 * route validates strictly and would reject with 400).
 */
function buildQueryString(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.env) params.set("env", filters.env);
  if (filters.nodegroup) params.set("nodegroup", filters.nodegroup);
  if (filters.squad) params.set("squad", filters.squad);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Extract a human error string from a `fetch` failure. Tries to parse the
 * response body as `{ error: string }` (the shape returned by the route
 * handler); falls back to a generic message so the UI always renders
 * something intelligible.
 */
async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body && typeof body.error === "string" && body.error.length > 0) {
      return body.error;
    }
  } catch {
    // ignore parse errors — fall through to the generic message
  }
  return `Error al obtener los datos de coste (HTTP ${res.status}).`;
}

/**
 * Loading skeleton with the same rough shape as the final view. Keeps CLS
 * at zero.
 */
function DashboardSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-live="polite">
      <div className="h-16 rounded-md bg-muted/40" />
      <div className="grid gap-4 lg:grid-cols-6">
        <div className="h-32 rounded-md bg-muted/40 lg:col-span-2" />
        <div className="h-32 rounded-md bg-muted/40" />
        <div className="h-32 rounded-md bg-muted/40" />
        <div className="h-32 rounded-md bg-muted/40" />
        <div className="h-32 rounded-md bg-muted/40" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="h-[360px] rounded-md bg-muted/40" />
        <div className="h-[360px] rounded-md bg-muted/40" />
      </div>
      <div className="h-[380px] rounded-md bg-muted/40" />
      <div className="h-[440px] rounded-md bg-muted/40" />
      <div className="h-[320px] rounded-md bg-muted/40" />
    </div>
  );
}

/**
 * Warning codes that are surfaced to the user via the yellow banner.
 * `vpa-missing` is intentionally excluded — VPA coverage across the estate
 * is inherently partial (tooling has zero VPAs by design) so the warning
 * would render permanently and drown out actionable signals. It stays
 * inside `data.warnings` for debugging but never reaches the UI.
 */
const UI_VISIBLE_WARNING_CODES: ReadonlySet<string> = new Set<string>([
  "metrics-not-configured",
  "metrics-partial-fail",
  "no-nodegroup-label",
  "no-squad-label",
  "empty-window",
]);

/**
 * Yellow collapsible banner listing the actionable `warnings[]` returned
 * by the backend when the summary was computed with partial data. Never
 * blocks the layout — the dashboard renders normally underneath.
 */
function WarningsBanner({ warnings }: { warnings: AllocationResponse["warnings"] }) {
  const [open, setOpen] = useState(false);
  const visible = warnings.filter((w) => UI_VISIBLE_WARNING_CODES.has(w.code));
  if (visible.length === 0) return null;
  return (
    <div className="rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent text-amber-700 dark:text-amber-300">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        )}
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        <span className="text-sm font-medium">
          {visible.length} aviso{visible.length === 1 ? "" : "s"} de datos parciales
        </span>
      </button>
      {open && (
        <ul className="space-y-1 border-t border-amber-500/30 px-10 py-3 text-sm">
          {visible.map((w, idx) => (
            <li key={`${w.code}-${idx}`}>
              <span className="font-mono text-xs">{w.code}</span> · {w.message}
              <span className="ml-2 text-xs opacity-70">({w.source})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Section header helper — small accent dot + title + optional description.
 */
function SectionHeader({
  title,
  description,
  accent,
}: {
  title: string;
  description?: string;
  accent: string;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span
        aria-hidden
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ background: accent }}
      />
      <div>
        <h3 className="text-sm font-bold uppercase tracking-wider text-foreground">
          {title}
        </h3>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

export function EksCostDashboard({ className }: EksCostDashboardProps) {
  // --- state ---------------------------------------------------------------
  const [filters, setFilters] = useState<Filters>({});
  const [data, setData] = useState<AllocationResponse | null>(null);
  // Catalog snapshot: the LAST response received with NO filters applied.
  // Filter dropdowns read from this (stable menu) while charts and totals
  // read from `data` (which is filtered by whatever the user picked). Without
  // this split the options list shrinks when the user filters — so once you
  // pick `env=prod` you can no longer see or switch to `env=dev`, and the
  // squad/nodegroup selects lose most of their options ("filter feels
  // sticky / can't switch without going through 'Sin filtro'").
  const [catalog, setCatalog] = useState<AllocationResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRec, setSelectedRec] = useState<number | null>(null);
  const [selectedRecommendation, setSelectedRecommendation] =
    useState<Recommendation | null>(null);
  const [panelOpen, setPanelOpen] = useState<boolean>(false);

  // Guard against setting state after an unmount (fetch races on unmount).
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // --- data fetching -------------------------------------------------------
  const fetchData = useCallback(
    async (currentFilters: Filters) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/finops/k8s-cost${buildQueryString(currentFilters)}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          const message = await extractErrorMessage(res);
          if (mountedRef.current) {
            setError(message);
            setData(null);
          }
          return;
        }
        const payload = (await res.json()) as AllocationResponse;
        if (!mountedRef.current) return;
        setData(payload);
        // Snapshot the catalog only when the request went out without any
        // filters — that is the ONE response that carries the full set of
        // environments / nodegroups / squads across the estate. Filtered
        // responses would erase entries and lock the user in.
        const isCatalogRequest =
          !currentFilters.env &&
          !currentFilters.nodegroup &&
          !currentFilters.squad;
        if (isCatalogRequest) {
          setCatalog(payload);
        }
        setSelectedRec(null);
        setSelectedRecommendation(null);
        setPanelOpen(false);
      } catch (err) {
        if (!mountedRef.current) return;
        const message =
          err instanceof Error && err.message
            ? err.message
            : "No se pudo contactar con el servicio de coste.";
        setError(message);
        setData(null);
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void fetchData(filters);
  }, [filters, fetchData]);

  // --- event handlers ------------------------------------------------------
  const handleFiltersChange = useCallback((next: Filters) => {
    setFilters(next);
  }, []);

  const handleRefresh = useCallback(() => {
    void fetchData(filters);
  }, [fetchData, filters]);

  const handleRecommendationClick = useCallback(
    (rec: Recommendation) => {
      if (!data) return;
      const idx = data.recommendations.indexOf(rec);
      setSelectedRec(idx >= 0 ? idx : null);
      setSelectedRecommendation(rec);
      setPanelOpen(true);
    },
    [data],
  );

  const handlePanelOpenChange = useCallback((open: boolean) => {
    setPanelOpen(open);
    if (!open) {
      setSelectedRec(null);
      setSelectedRecommendation(null);
    }
  }, []);

  const handleEnvClick = useCallback((env: EnvironmentName) => {
    setFilters((prev) => ({ ...prev, env }));
  }, []);

  const handleSquadClick = useCallback((squad: string) => {
    setFilters((prev) => ({ ...prev, squad }));
  }, []);

  // --- derived state -------------------------------------------------------
  const isEmpty = useMemo<boolean>(() => {
    if (!data) return false;
    return (
      data.totalMonthlyEur === 0 &&
      data.environments.length === 0 &&
      data.warnings.length === 0
    );
  }, [data]);

  // --- render --------------------------------------------------------------
  if (loading && !data) {
    return (
      <div className={cn("space-y-6", className)}>
        <DashboardSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn("space-y-6", className)}>
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-md border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-300"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <span className="font-medium">
              No se pudieron cargar los datos de coste
            </span>
          </div>
          <p>{error}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleRefresh}
          >
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className={cn("space-y-6", className)}>
        <DashboardSkeleton />
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className={cn("space-y-6", className)}>
        <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          <p>
            No hay datos de coste. Verifica que OpenCost está desplegado en los
            clusters.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleRefresh}
          >
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-6", className)}>
      <FiltersBar
        summary={data}
        catalog={catalog ?? data}
        filters={filters}
        onFiltersChange={handleFiltersChange}
        onRefresh={handleRefresh}
      />

      <WarningsBanner warnings={data.warnings} />

      <KpiBar summary={data} />

      <section className="space-y-3">
        <SectionHeader
          title="Distribución del coste"
          description="Dónde se concentra el gasto por entorno y cuál es la cobertura spot."
          accent="hsl(280 90% 60%)"
        />
        <div className="grid gap-6 lg:grid-cols-2 items-start">
          <CostByEnvironmentChart
            environments={data.environments}
            onEnvironmentClick={handleEnvClick}
          />
          <SpotCoveragePanel environments={data.environments} />
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Atribución por squad"
          description="Cuánto cuesta lo que despliega cada equipo y qué parte podría rebajarse."
          accent="hsl(258 82% 60%)"
        />
        <SquadAttributionChart
          squads={data.squads}
          onSquadClick={handleSquadClick}
        />
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Nodegroups: nodos de más"
          description="La zona en rojo mide los nodos que el autoscaler no puede liberar por sobre-provisionamiento."
          accent="hsl(0 76% 60%)"
        />
        <NodegroupBreakdownChart nodegroups={data.nodegroups} />
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Eficiencia vs coste"
          description="Cada punto es un workload. Abajo a la derecha están las mejores oportunidades de rightsizing."
          accent="hsl(200 90% 60%)"
        />
        <EfficiencyScatterChart
          workloads={data.workloads}
          recommendations={data.recommendations}
        />
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Recomendaciones"
          description="Ordenadas por ahorro potencial. Haz clic para ver el bloque de configuración listo para copiar."
          accent="hsl(158 74% 45%)"
        />
        <RecommendationsTable
          recommendations={data.recommendations}
          onRowClick={handleRecommendationClick}
          selectedIndex={selectedRec}
        />
      </section>

      <RecommendationDetailPanel
        recommendation={selectedRecommendation}
        open={panelOpen}
        onOpenChange={handlePanelOpenChange}
      />
    </div>
  );
}
