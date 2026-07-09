"use client";

/**
 * comparison-explorer.tsx
 *
 * FinOps cost comparison explorer (PARTE B) — UI layer.
 *
 * Renders an accessible modal (shadcn `Dialog`, backed by Radix: `role="dialog"`,
 * `aria-labelledby` via `DialogTitle`, Esc-to-close and focus trap by default)
 * that lets a FinOps user compare two or more months with hierarchical
 * drill-down (account → service → resource).
 *
 * State and data flow:
 * - `ComparisonExplorerDialog` owns `selectedMonths`, `level` and `drillPath`,
 *   and inherits `selectedAccountIds` from the dashboard (Req 3.3). Closing only
 *   calls `onOpenChange` — it never mutates parent state (Req 3.4).
 * - It calls `useCostComparison(selectedAccountIds, monthsToFetch)` which fetches
 *   one `cur-direct` snapshot per month and exposes `comparisonFor(level, drill)`,
 *   `loading` and per-month `monthErrors`.
 *
 * Sub-components in this file:
 * - `MonthPicker`        — pick ≥2 months; blocks generation with <2 (Req 4.2).
 * - `ComparisonBreadcrumb` — keyboard-activable navigation back up a level (Req 5.4, 11.5).
 * - `ComparisonTable`    — `<th scope>` table with per-month amount, Δ$, Δ%, trend (Req 11.3, 6.x).
 *
 * NOTE: `ComparisonChart` (Recharts) is appended to this same file by task 9.2.
 * A clearly marked placeholder slot is left below the table.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BarChart2,
  ChevronRight,
  Loader2,
  Minus,
  Search,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BotonVolver } from "@/components/navigation/boton-volver";
import { cn } from "@/lib/utils";
import { useCostComparison } from "@/hooks/use-cost-comparison";
import type {
  ComparisonLevel,
  ComparisonResult,
  ComparisonRow,
  MonthKey,
  Trend,
} from "@/lib/finops-cost-comparison";

// ---------------------------------------------------------------------------
// Formatting helpers (local, matching other finops components)
// ---------------------------------------------------------------------------

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fmtMoney(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return USD.format(v);
}

/** Signed money, for the absolute delta column (Δ$). CUR bills in USD. */
function fmtDelta(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${USD.format(Math.abs(v))}`;
}

/** Percentage variation. `null` (base 0) is rendered as "n/a" (Req 6.6). */
function fmtPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "n/a";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(1)}%`;
}

/** Human label for a "YYYY-MM" month key in Spanish (e.g. "jun 2026"). */
function fmtMonthLabel(month: MonthKey): string {
  const [year, m] = month.split("-");
  const monthIdx = Number(m) - 1;
  const date = new Date(Date.UTC(Number(year), monthIdx, 1));
  const label = date.toLocaleDateString("es-ES", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return label.replace(".", "");
}

// ---------------------------------------------------------------------------
// Candidate months
// ---------------------------------------------------------------------------

/** Builds the last `count` month keys ("YYYY-MM"), newest first. */
function recentMonths(count: number, now: Date = new Date()): MonthKey[] {
  const months: MonthKey[] = [];
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-11
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(year, month - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    months.push(key);
  }
  return months;
}

const MIN_MONTHS = 2;
const CANDIDATE_MONTH_COUNT = 12;

// ---------------------------------------------------------------------------
// Trend indicator
// ---------------------------------------------------------------------------

function TrendIndicator({ trend }: { trend: Trend }) {
  // Cost going up is "bad" (red/destructive), down is "good" (green/success).
  if (trend === "up") {
    return (
      <span className="inline-flex items-center gap-1 text-destructive" title="Sube">
        <TrendingUp className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">Tendencia al alza</span>
      </span>
    );
  }
  if (trend === "down") {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400" title="Baja">
        <TrendingDown className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">Tendencia a la baja</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground" title="Estable">
      <Minus className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">Sin variación</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// MonthPicker
// ---------------------------------------------------------------------------

interface MonthPickerProps {
  candidates: MonthKey[];
  selected: MonthKey[];
  onToggle: (month: MonthKey) => void;
  canGenerate: boolean;
}

function MonthPicker({ candidates, selected, onToggle, canGenerate }: MonthPickerProps) {
  const selectedSet = new Set(selected);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Meses a comparar</p>
        <p className="text-xs text-muted-foreground">
          {selected.length} seleccionado{selected.length === 1 ? "" : "s"}
        </p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Selección de meses">
        {candidates.map((month) => {
          const active = selectedSet.has(month);
          return (
            <button
              key={month}
              type="button"
              onClick={() => onToggle(month)}
              aria-pressed={active}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-background hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {fmtMonthLabel(month)}
            </button>
          );
        })}
      </div>
      {!canGenerate && (
        <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          Selecciona al menos dos meses
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ComparisonBreadcrumb
// ---------------------------------------------------------------------------

interface ComparisonBreadcrumbProps {
  level: ComparisonLevel;
  drillPath: { accountId?: string; service?: string };
  accountLabel?: string;
  serviceLabel?: string;
  onBack: () => void;
  onReset: () => void;
}

function ComparisonBreadcrumb({
  level,
  drillPath,
  accountLabel,
  serviceLabel,
  onBack,
  onReset,
}: ComparisonBreadcrumbProps) {
  const atRoot = level === "account";

  return (
    <div className="flex items-center gap-2">
      {/*
       * Reutiliza el Boton_Volver único (R6.4). La navegación aquí es entre
       * NIVELES INTERNOS por estado local (cuenta→servicio→recurso), no por
       * ruta: por eso se usa `onClick={onBack}` en vez de `destination`, que
       * dispararía un `router.push` y sacaría al usuario del explorador. En el
       * nivel raíz (cuentas) el control queda deshabilitado.
       */}
      <BotonVolver onClick={onBack} disabled={atRoot} />
      <nav aria-label="Ruta de navegación" className="flex items-center gap-1 text-sm">
        <button
          type="button"
          onClick={onReset}
          className={cn(
            "rounded px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            atRoot ? "font-semibold text-foreground" : "text-muted-foreground hover:text-foreground hover:underline",
          )}
        >
          Cuentas
        </button>
        {drillPath.accountId && (
          <>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <span
              className={cn(
                "px-1",
                level === "service" ? "font-semibold text-foreground" : "text-muted-foreground",
              )}
            >
              {accountLabel || drillPath.accountId}
            </span>
          </>
        )}
        {drillPath.service && (
          <>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <span className="px-1 font-semibold text-foreground">
              {serviceLabel || drillPath.service}
            </span>
          </>
        )}
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ComparisonTable
// ---------------------------------------------------------------------------

interface ComparisonTableProps {
  result: ComparisonResult;
  loading: boolean;
  monthErrors: Record<MonthKey, string>;
  onDrill: (row: ComparisonRow) => void;
}

function ComparisonTable({ result, loading, monthErrors, onDrill }: ComparisonTableProps) {
  const { months, rows, level } = result;
  const canDrill = level === "account" || level === "service";
  const errorMonths = Object.entries(monthErrors);
  // Δ$/Δ%/Tendencia only make sense comparing exactly two months (reciente −
  // antiguo). With >2 months the comparison is a progression, so those columns
  // are hidden and the per-month amounts + the line chart carry the story.
  const showDelta = months.length === 2;

  return (
    <div className="space-y-3">
      {errorMonths.length > 0 && (
        <div className="space-y-1">
          {errorMonths.map(([month, message]) => (
            <p
              key={month}
              role="alert"
              className="flex items-center gap-1.5 text-sm text-destructive"
            >
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              No se pudieron cargar los datos de {fmtMonthLabel(month)}: {message}
            </p>
          ))}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          <span>Cargando comparativa…</span>
        </div>
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No hay datos para los meses y cuentas seleccionados.
        </p>
      ) : (
        <div className="relative w-full overflow-auto">
          <table className="w-full caption-bottom border-collapse text-sm">
            <caption className="sr-only">
              Comparativa de coste por {level === "account" ? "cuenta" : level === "service" ? "servicio" : "recurso"}{" "}
              entre {months.map(fmtMonthLabel).join(", ")}
            </caption>
            <thead className="border-b">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">
                  {level === "account" ? "Cuenta" : level === "service" ? "Servicio" : "Recurso"}
                </th>
                {months.map((month) => (
                  <th
                    key={month}
                    scope="col"
                    className="px-3 py-2 text-right font-medium text-muted-foreground"
                  >
                    {fmtMonthLabel(month)}
                  </th>
                ))}
                {showDelta && (
                  <>
                    <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">
                      Δ$
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">
                      Δ%
                    </th>
                    <th scope="col" className="px-3 py-2 text-center font-medium text-muted-foreground">
                      Tendencia
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-b transition-colors hover:bg-muted/50">
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    {canDrill ? (
                      <button
                        type="button"
                        onClick={() => onDrill(row)}
                        className="text-left font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                        title={`Desglosar ${row.label}`}
                      >
                        {row.label}
                      </button>
                    ) : (
                      <span className="font-medium">{row.label}</span>
                    )}
                  </th>
                  {months.map((month) => (
                    <td key={month} className="px-3 py-2 text-right tabular-nums">
                      {fmtMoney(row.byMonth[month] ?? 0)}
                    </td>
                  ))}
                  {showDelta && (
                    <>
                      <td
                        className={cn(
                          "px-3 py-2 text-right font-medium tabular-nums",
                          row.deltaAbs > 0
                            ? "text-destructive"
                            : row.deltaAbs < 0
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-muted-foreground",
                        )}
                      >
                        {fmtDelta(row.deltaAbs)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {fmtPct(row.deltaPct)}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className="inline-flex justify-center">
                          <TrendIndicator trend={row.trend} />
                        </span>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ComparisonChart
// ---------------------------------------------------------------------------

/** Distinct chart series colours, reusing the dashboard's theme tokens. */
const CHART_COLORS = [
  "hsl(var(--primary))",
  "hsl(var(--info))",
  "hsl(var(--success))",
  "hsl(var(--warning))",
  "hsl(var(--danger))",
  "hsl(210 15% 60%)",
  "hsl(280 40% 55%)",
  "hsl(30 80% 55%)",
];

/** Top entities shown in the chart, to avoid clutter (rows are pre-sorted by |Δ$|). */
const CHART_TOP_N = 8;

function levelNoun(level: ComparisonLevel): string {
  return level === "account" ? "cuenta" : level === "service" ? "servicio" : "recurso";
}

function levelNounPlural(level: ComparisonLevel): string {
  return level === "account" ? "cuentas" : level === "service" ? "servicios" : "recursos";
}

interface ComparisonChartProps {
  result: ComparisonResult;
}

/**
 * Visual comparison of the top entities across the selected months.
 *
 * - Exactly 2 months  → grouped bar chart (one bar per month, grouped by entity).
 * - More than 2 months → line chart (one line per entity, X axis = months in
 *   chronological order) showing the cost progression.
 *
 * The chart is a pure function of `result`, so it re-renders automatically when
 * the level (drill-down) or the month selection change (Req 7.2, 7.3).
 *
 * Accessibility (Req 11.4): the chart is wrapped in a `<figure>`/`<figcaption>`
 * and the SVG itself is hidden from assistive tech (`aria-hidden`). An
 * equivalent, screen-reader-only `<table>` (months as columns, entities as
 * rows, with `<th scope>`) carries the same values so the graphic is never the
 * only way to access the data.
 */
function ComparisonChart({ result }: ComparisonChartProps) {
  const { months, rows, level } = result;

  // Rows already arrive sorted by descending |deltaAbs|; keep the most relevant.
  const topRows = useMemo(() => rows.slice(0, CHART_TOP_N), [rows]);

  const isProgression = months.length > 2;

  // Bar chart data (2 months): one record per entity, one numeric key per month.
  const barData = useMemo(
    () =>
      topRows.map((row) => {
        const item: Record<string, number | string> = { name: row.label };
        for (const month of months) item[month] = row.byMonth[month] ?? 0;
        return item;
      }),
    [topRows, months],
  );

  // Line chart data (>2 months): one record per month, one numeric key per entity.
  const lineData = useMemo(
    () =>
      months.map((month) => {
        const item: Record<string, number | string> = { name: fmtMonthLabel(month) };
        for (const row of topRows) item[row.key] = row.byMonth[month] ?? 0;
        return item;
      }),
    [topRows, months],
  );

  if (months.length === 0 || topRows.length === 0) {
    // The table already renders the "no data" message; nothing to chart.
    return null;
  }

  const figcaption = isProgression
    ? `Progresión de coste de ${levelNounPlural(level)} a lo largo de ${months
        .map(fmtMonthLabel)
        .join(", ")}`
    : `Comparación de coste por ${levelNoun(level)} entre ${months
        .map(fmtMonthLabel)
        .join(" y ")}`;

  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-medium text-foreground">
        {isProgression ? "Progresión de coste" : "Comparación de coste"}
        {topRows.length < rows.length && (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            (top {topRows.length} por variación)
          </span>
        )}
      </figcaption>

      {/* Visual chart — hidden from assistive tech; the sr-only table below is
          the accessible equivalent (Req 11.4). */}
      <div className="h-72 w-full" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          {isProgression ? (
            <LineChart data={lineData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} width={80} tickFormatter={(v) => fmtMoney(Number(v))} />
              <Tooltip
                formatter={(value: number | string, name: string) => [fmtMoney(Number(value)), name]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {topRows.map((row, i) => (
                <Line
                  key={row.key}
                  type="monotone"
                  dataKey={row.key}
                  name={row.label}
                  stroke={CHART_COLORS[i % CHART_COLORS.length]}
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          ) : (
            <BarChart data={barData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} interval={0} />
              <YAxis tick={{ fontSize: 12 }} width={80} tickFormatter={(v) => fmtMoney(Number(v))} />
              <Tooltip
                formatter={(value: number | string, name: string) => [fmtMoney(Number(value)), name]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {months.map((month, i) => (
                <Bar
                  key={month}
                  dataKey={month}
                  name={fmtMonthLabel(month)}
                  fill={CHART_COLORS[i % CHART_COLORS.length]}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>

      {/* Accessible textual equivalent of the chart (Req 11.4). */}
      <table className="sr-only">
        <caption>
          {figcaption}. Datos equivalentes a la gráfica, con los meses como columnas y
          {` ${levelNounPlural(level)}`} como filas.
        </caption>
        <thead>
          <tr>
            <th scope="col">{levelNoun(level).charAt(0).toUpperCase() + levelNoun(level).slice(1)}</th>
            {months.map((month) => (
              <th key={month} scope="col">
                {fmtMonthLabel(month)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {topRows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              {months.map((month) => (
                <td key={month}>{fmtMoney(row.byMonth[month] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// ComparisonExplorerDialog
// ---------------------------------------------------------------------------

export interface ComparisonExplorerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Inherited from the dashboard's Filtro_Cuentas (Req 3.3). */
  selectedAccountIds: string[];
}

export function ComparisonExplorerDialog({
  open,
  onOpenChange,
  selectedAccountIds,
}: ComparisonExplorerDialogProps) {
  const candidates = useMemo(() => recentMonths(CANDIDATE_MONTH_COUNT), []);

  const [selectedMonths, setSelectedMonths] = useState<MonthKey[]>([]);
  const [committedMonths, setCommittedMonths] = useState<MonthKey[]>([]);
  const [level, setLevel] = useState<ComparisonLevel>("account");
  const [drillPath, setDrillPath] = useState<{ accountId?: string; service?: string }>({});

  // The pending selection can be generated once it has >=2 months (Req 4.2)...
  const canGenerate = selectedMonths.length >= MIN_MONTHS;
  // ...but data is fetched ONLY for the committed months — i.e. after the user
  // presses "Comparar". This avoids firing one heavy cur-direct request per
  // month toggle (which overlapped and triggered 500s when selecting quickly).
  const hasComparison = committedMonths.length >= MIN_MONTHS;

  const { comparisonFor, loading, monthErrors } = useCostComparison(
    selectedAccountIds,
    committedMonths,
  );

  // Commit the current selection and (re)start at the account level. Drill state
  // only changes via navigation otherwise (Req 5.5).
  const handleGenerate = () => {
    if (!canGenerate) return;
    setLevel("account");
    setDrillPath({});
    setCommittedMonths([...selectedMonths]);
  };

  // If the committed comparison is cleared, drop back to the account level.
  useEffect(() => {
    if (!hasComparison) {
      setLevel("account");
      setDrillPath({});
    }
  }, [hasComparison]);

  const result = comparisonFor(level, drillPath);

  // Resolve human labels for the breadcrumb from the current account-level data.
  const accountResult = useMemo(
    () => comparisonFor("account", {}),
    [comparisonFor],
  );
  const accountLabel = drillPath.accountId
    ? accountResult.rows.find((r) => r.key === drillPath.accountId)?.label
    : undefined;
  const serviceResult = useMemo(
    () =>
      drillPath.accountId
        ? comparisonFor("service", { accountId: drillPath.accountId })
        : null,
    [comparisonFor, drillPath.accountId],
  );
  const serviceLabel = drillPath.service
    ? serviceResult?.rows.find((r) => r.key === drillPath.service)?.label
    : undefined;

  const handleToggleMonth = (month: MonthKey) => {
    setSelectedMonths((prev) =>
      prev.includes(month) ? prev.filter((m) => m !== month) : [...prev, month],
    );
  };

  const handleDrill = (row: ComparisonRow) => {
    if (level === "account") {
      setDrillPath({ accountId: row.key });
      setLevel("service");
    } else if (level === "service") {
      setDrillPath((prev) => ({ accountId: prev.accountId, service: row.key }));
      setLevel("resource");
    }
  };

  const handleBack = () => {
    if (level === "resource") {
      setDrillPath((prev) => ({ accountId: prev.accountId }));
      setLevel("service");
    } else if (level === "service") {
      setDrillPath({});
      setLevel("account");
    }
  };

  const handleReset = () => {
    setDrillPath({});
    setLevel("account");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Explorador de comparativas de coste</DialogTitle>
          <DialogDescription>
            Compara dos o más meses con desglose por cuenta, servicio y recurso.
            {selectedAccountIds.length > 0 ? (
              <>
                {" "}
                <Badge variant="secondary" className="ml-1 align-middle">
                  {selectedAccountIds.length} cuenta{selectedAccountIds.length === 1 ? "" : "s"}
                </Badge>
              </>
            ) : (
              <> Todas las cuentas.</>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <MonthPicker
            candidates={candidates}
            selected={selectedMonths}
            onToggle={handleToggleMonth}
            canGenerate={canGenerate}
          />

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={handleGenerate} disabled={!canGenerate || loading}>
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Search className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              Comparar
            </Button>
            {hasComparison && (
              <span className="text-xs text-muted-foreground">
                Comparando {committedMonths.length} meses
                {(selectedMonths.length !== committedMonths.length ||
                  selectedMonths.some((m) => !committedMonths.includes(m))) && (
                  <span className="ml-1 text-warning">· pulsa Comparar para actualizar</span>
                )}
              </span>
            )}
          </div>

          {hasComparison && (
            <>
              <ComparisonBreadcrumb
                level={level}
                drillPath={drillPath}
                accountLabel={accountLabel}
                serviceLabel={serviceLabel}
                onBack={handleBack}
                onReset={handleReset}
              />

              <ComparisonTable
                result={result}
                loading={loading}
                monthErrors={monthErrors}
                onDrill={handleDrill}
              />

              {/* ----------------------------------------------------------------
               * ComparisonChart (task 9.2): Recharts comparison/progression chart
               * + accessible alternative table, fed by the same `result`. Pure
               * function of props, so it re-renders on level/month changes
               * (Req 7.2, 7.3). Only shown when not loading and there is data.
               * -------------------------------------------------------------- */}
              {!loading && result.rows.length > 0 && <ComparisonChart result={result} />}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
