/**
 * AI Portal Explorer — Scenario_Generator.
 *
 * Feature: ai-portal-explorer
 *
 * Genera, para cada Route que admite parámetros, el conjunto de Scenarios a
 * explorar: un producto cartesiano ACOTADO y DETERMINISTA de rangos de fechas
 * seguros × valores de filtro seguros. Todos los valores provienen de la
 * Scenario_Matrix (configurable); el generador nunca inventa valores ni emite
 * mutaciones — solo combina `safeValues` y `DateRangeSpec`.
 *
 * La matriz por defecto incluye DELIBERADAMENTE un rango etiquetado
 * `"crosses-90d-boundary"` (2026-01-01–2026-03-28, `expectsData: true`): es el
 * rango del bug real de la pestaña Gestión (la snapshot `gitlab_mr_analytics`
 * se re-upserta a 90 días, así que los rangos históricos quedan vacíos). El
 * Explorer debe poder DETECTARLO probando ese rango y reconociendo el
 * empty-state como anomalía funcional.
 *
 * _Requirements: 4.5_
 */

import { createHash } from "crypto";

import type { PortalSection } from "@/lib/rbac";
import type { FilterSpec, Route, Scenario } from "./types";

/**
 * Matriz de scenarios configurable por sección. Define qué rangos de fechas y
 * filtros seguros se prueban en cada Route que admite parámetros.
 */
export interface ScenarioMatrix {
  dateRanges: DateRangeSpec[];
  filtersBySection: Partial<Record<PortalSection, FilterSpec[]>>;
}

export interface DateRangeSpec {
  /** "last-7d", "last-90d", "crosses-90d-boundary", "historic-q1"... */
  label: string;
  /**
   * Fecha de inicio. Admite dos formas, resueltas al generar:
   *  - Literal ISO `YYYY-MM-DD` (p.ej. "2026-01-01") → se usa tal cual.
   *  - Offset relativo a `runDate` con formato `"<n>d"` (p.ej. "-7d", "-90d",
   *    "0d") → se resuelve sumando `n` días naturales a `runDate`.
   */
  startDate: string;
  endDate: string;
  /** ¿Se espera que este rango devuelva datos? Alimenta `Scenario.expectsData`. */
  expectsData: boolean;
}

/**
 * Matriz por defecto. Incluye DELIBERADAMENTE un rango que cruza el límite de
 * 90 días (`crosses-90d-boundary`) — el rango del bug de Gestión.
 *
 * Los rangos recientes se expresan como offsets relativos a `runDate` para que
 * el generador sea determinista pero sensible a la fecha de ejecución; los
 * rangos históricos fijos se expresan como fechas literales.
 */
export const DEFAULT_SCENARIO_MATRIX: ScenarioMatrix = {
  dateRanges: [
    // Ventanas recientes: deben tener datos (dentro de la retención de 90d).
    { label: "last-7d", startDate: "-7d", endDate: "0d", expectsData: true },
    { label: "last-90d", startDate: "-90d", endDate: "0d", expectsData: true },
    // Rango del bug de Gestión: cruza el límite de 90 días y SÍ esperamos datos.
    {
      label: "crosses-90d-boundary",
      startDate: "2026-01-01",
      endDate: "2026-03-28",
      expectsData: true,
    },
    // Histórico profundo (Q1 2025): por la retención puede estar vacío de forma
    // legítima, así que no esperamos datos (evita falsos positivos).
    {
      label: "historic-q1",
      startDate: "2025-01-01",
      endDate: "2025-03-31",
      expectsData: false,
    },
  ],
  filtersBySection: {
    metrics: [{ key: "team", safeValues: ["digital", "retail"] }],
    finops: [{ key: "accountIds", safeValues: ["444455556666"] }],
  },
};

/** Una dimensión del producto cartesiano: un conjunto ordenado de opciones. */
interface DateOption {
  params: Record<string, string>;
  expectsData: boolean;
  label?: string;
}

interface FilterOption {
  key: string;
  value: string;
}

/** Resuelve una fecha de la matriz a `YYYY-MM-DD` (literal u offset a runDate). */
function resolveDate(value: string, runDate: string): string {
  const trimmed = value.trim();
  const relative = /^-?\d+d$/.exec(trimmed);
  if (relative) {
    const days = parseInt(trimmed.slice(0, -1), 10);
    const base = new Date(`${runDate}T00:00:00.000Z`);
    base.setUTCDate(base.getUTCDate() + days);
    return base.toISOString().slice(0, 10);
  }
  // Literal: se asume YYYY-MM-DD ya resuelto.
  return trimmed;
}

/**
 * Filtros aplicables a una Route: solo las claves que la Route admite
 * (`route.paramSpec.filters`). Para cada clave, los `safeValues` de la matriz
 * (override por sección) prevalecen sobre los de la propia Route si existen.
 * Orden estable por clave para garantizar determinismo.
 */
function applicableFilters(route: Route, matrix: ScenarioMatrix): FilterSpec[] {
  const routeFilters = route.paramSpec?.filters ?? [];
  if (routeFilters.length === 0) return [];

  const sectionOverrides = matrix.filtersBySection[route.section] ?? [];
  const overrideByKey = new Map(sectionOverrides.map((f) => [f.key, f]));

  return routeFilters
    .map((rf) => {
      const override = overrideByKey.get(rf.key);
      const safeValues = override ? override.safeValues : rf.safeValues;
      return { key: rf.key, safeValues };
    })
    .filter((f) => f.safeValues.length > 0)
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Dimensión de fechas: una opción por DateRangeSpec, o una opción vacía. */
function dateOptions(route: Route, matrix: ScenarioMatrix, runDate: string): DateOption[] {
  if (!route.paramSpec?.dateRange) {
    // La Route no admite rango de fechas: una única opción sin params de fecha.
    return [{ params: {}, expectsData: true, label: undefined }];
  }
  return matrix.dateRanges.map((spec) => ({
    params: {
      startDate: resolveDate(spec.startDate, runDate),
      endDate: resolveDate(spec.endDate, runDate),
    },
    expectsData: spec.expectsData,
    label: spec.label,
  }));
}

/**
 * Genera los Scenarios de una Route a partir de la matriz: producto cartesiano
 * acotado de rangos de fechas × filtros seguros. Determinista (orden estable) e
 * independiente de `runId`/timestamp. Solo combina valores de la matriz.
 *
 * _Requirements: 4.5_
 */
export function generateScenarios(
  route: Route,
  matrix: ScenarioMatrix,
  runDate: string,
): Scenario[] {
  const dates = dateOptions(route, matrix, runDate);
  const filters = applicableFilters(route, matrix);

  // Producto cartesiano de los conjuntos de valores de cada filtro, en orden
  // estable. Empieza con una combinación vacía y va expandiendo por filtro.
  let filterCombos: FilterOption[][] = [[]];
  for (const filter of filters) {
    const next: FilterOption[][] = [];
    for (const combo of filterCombos) {
      for (const value of filter.safeValues) {
        next.push([...combo, { key: filter.key, value }]);
      }
    }
    filterCombos = next;
  }

  const scenarios: Scenario[] = [];
  for (const date of dates) {
    for (const combo of filterCombos) {
      const params: Record<string, string> = { ...date.params };
      for (const { key, value } of combo) {
        params[key] = value;
      }
      scenarios.push({
        scenarioId: buildScenarioId(route, params),
        route,
        params,
        expectsData: date.expectsData,
        label: date.label,
      });
    }
  }

  return scenarios;
}

/**
 * ID de scenario estable y determinista: hash de `route.id` + los parámetros
 * ordenados de forma canónica. Independiente de `runId`/timestamp, de modo que
 * dos runs sobre el mismo estado produzcan los mismos `scenarioId`.
 */
export function buildScenarioId(route: Route, params: Record<string, string>): string {
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  const digest = createHash("sha1").update(`${route.id}|${canonical}`).digest("hex").slice(0, 16);
  return `scn_${digest}`;
}
