/**
 * AI Portal Explorer — Anomaly_Detectors.
 *
 * Feature: ai-portal-explorer
 *
 * El corazón testeable del QA funcional: heurísticas deterministas que
 * transforman un Visit_Result en Anomalies. Todas son funciones PURAS
 * (sin I/O, sin estado), de modo que dos runs sobre el mismo estado del
 * portal produzcan exactamente el mismo conjunto de Anomalies (Req 9.4).
 *
 * Este fichero contiene los detectores técnicos y de rendimiento, más los
 * helpers compartidos (buildAnomalyId, anomalyEquivalenceKey, DetectorConfig)
 * que el resto de detectores funcionales y el orquestador (tarea 8.2)
 * construyen sobre la misma base.
 *
 * _Requirements: 5.6, 5.7, 10.6, 8.4_
 */

import { createHash } from "node:crypto";

import type { AppRole } from "@/lib/rbac";
import type {
  Anomaly,
  AnomalyCategory,
  AnomalyEvidence,
  Route,
  Scenario,
  TriageResult,
  VisitResult,
} from "./types";

/** Configuración de los detectores deterministas para un Exploration_Run. */
export interface DetectorConfig {
  /** Umbral de latencia (ms) por encima del cual una Visit es Anomaly de rendimiento. (Req 5.6) */
  latencyThresholdMs: number;
  /** Tolerancia (días) para considerar truncada una serie temporal. */
  seriesEndToleranceDays: number;
}

/**
 * ID de anomalía determinista a partir de run+route+role+category+scenario.
 *
 * Es estable para un run dado: el mismo Visit_Result clasificado con la misma
 * categoría produce siempre el mismo `anomalyId`. La equivalencia entre runs
 * para regresiones NO usa este id (usa {@link anomalyEquivalenceKey}).
 */
export function buildAnomalyId(
  runId: string,
  route: Route,
  role: AppRole,
  category: AnomalyCategory,
  scenarioId: string,
): string {
  const digest = createHash("sha1")
    .update(`${runId}|${route.id}|${role}|${category}|${scenarioId}`)
    .digest("hex")
    .slice(0, 16);
  return `anom_${digest}`;
}

/**
 * Clave de equivalencia para regresiones: Route + Role + categoría. (Req 8.4)
 *
 * Independiente del run (no incluye runId ni scenarioId ni timestamps), de modo
 * que una misma anomalía detectada en dos runs distintos comparta clave.
 *
 * Acepta tanto un Anomaly (cuyo `route` es un objeto Route) como un
 * TriageResult (cuyo `route` es el path string), normalizando ambos al path.
 */
export function anomalyEquivalenceKey(a: Anomaly | TriageResult): string {
  const routePath = typeof a.route === "string" ? a.route : a.route.path;
  return `${routePath}|${a.role}|${a.category}`;
}

/**
 * Construye la evidencia estructurada de una Anomaly a partir de un Visit_Result.
 * Centraliza el mapeo Visit_Result -> AnomalyEvidence para todos los detectores.
 */
function buildEvidence(visit: VisitResult, summary: string): AnomalyEvidence {
  return {
    summary,
    httpStatus: visit.httpStatus,
    latencyMs: visit.latencyMs,
    consoleErrors: visit.consoleErrors.map((e) => e.message),
    failedRequests: visit.failedRequests,
    domErrorStates: visit.domErrorStates,
    dataSignal: visit.dataSignal,
    screenshotRef: visit.screenshotRef,
    observedAccess: visit.accessObserved,
  };
}

/**
 * Construye una Anomaly completa para un Visit_Result y categoría dados,
 * derivando el anomalyId determinista y la evidencia estructurada.
 */
function buildAnomaly(
  visit: VisitResult,
  category: AnomalyCategory,
  summary: string,
): Anomaly {
  return {
    anomalyId: buildAnomalyId(visit.runId, visit.route, visit.role, category, visit.scenarioId),
    runId: visit.runId,
    route: visit.route,
    role: visit.role,
    scenarioId: visit.scenarioId,
    category,
    detector: "deterministic",
    evidence: buildEvidence(visit, summary),
  };
}

/**
 * Heurísticas técnicas: produce una Anomaly por cada categoría técnica
 * presente en el Visit_Result (console-error, failed-request, dom-error).
 *
 * Un Visit_Result con al menos un Console_Error, una Failed_Request o un
 * DOM_Error_State se clasifica como Anomaly. (Req 5.7)
 */
export function detectTechnicalAnomalies(visit: VisitResult): Anomaly[] {
  const anomalies: Anomaly[] = [];

  if (visit.consoleErrors.length > 0) {
    anomalies.push(
      buildAnomaly(
        visit,
        "console-error",
        `${visit.consoleErrors.length} error(es) de consola durante la visita a ${visit.route.path}.`,
      ),
    );
  }

  if (visit.failedRequests.length > 0) {
    anomalies.push(
      buildAnomaly(
        visit,
        "failed-request",
        `${visit.failedRequests.length} petición(es) de red fallida(s) durante la visita a ${visit.route.path}.`,
      ),
    );
  }

  if (visit.domErrorStates.length > 0) {
    anomalies.push(
      buildAnomaly(
        visit,
        "dom-error",
        `${visit.domErrorStates.length} estado(s) de error en el DOM durante la visita a ${visit.route.path}.`,
      ),
    );
  }

  return anomalies;
}

/**
 * Latencia por encima del umbral configurable: marca el Visit_Result como
 * Anomaly de categoría rendimiento (`performance`) sii `latencyMs > thresholdMs`.
 * (Req 5.6)
 */
export function detectLatencyAnomaly(visit: VisitResult, thresholdMs: number): Anomaly | null {
  if (visit.latencyMs > thresholdMs) {
    return buildAnomaly(
      visit,
      "performance",
      `Latencia ${visit.latencyMs}ms supera el umbral de ${thresholdMs}ms en ${visit.route.path}.`,
    );
  }
  return null;
}

/**
 * Timeout: la Visit superó el tiempo máximo configurado y se marca como
 * Anomaly de categoría `timeout` sii `visit.timedOut`. (Req 10.6)
 */
export function detectTimeoutAnomaly(visit: VisitResult): Anomaly | null {
  if (visit.timedOut) {
    return buildAnomaly(
      visit,
      "timeout",
      `La visita a ${visit.route.path} superó el tiempo máximo configurado.`,
    );
  }
  return null;
}

/** Tolerancia por defecto (días) para considerar truncada una serie temporal. */
export const DEFAULT_SERIES_END_TOLERANCE_DAYS = 1;

/**
 * Diferencia en días entre dos fechas ISO (`YYYY-MM-DD`), calculada en UTC para
 * ser determinista e independiente de la zona horaria del proceso. Devuelve
 * `endISO - startISO` (positivo si `endISO` es posterior). `null` si alguna
 * fecha no es parseable.
 */
function daysBetween(startISO: string, endISO: string): number | null {
  const start = Date.parse(`${startISO}T00:00:00Z`);
  const end = Date.parse(`${endISO}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  return Math.round((end - start) / 86_400_000);
}

/** Rango de fechas efectivo de una Visit: params del scenario o señal de serie. */
function visitDateRange(visit: VisitResult): { start: string; end: string } | null {
  const paramStart = visit.params.startDate;
  const paramEnd = visit.params.endDate;
  if (paramStart && paramEnd) {
    return { start: paramStart, end: paramEnd };
  }
  const series = visit.dataSignal?.timeSeries;
  if (series && series.requestedStart && series.requestedEnd) {
    return { start: series.requestedStart, end: series.requestedEnd };
  }
  return null;
}

/**
 * Empty-state con expectativa de datos: el scenario esperaba datos
 * (`expectsData`) pero el Visit_Result presenta un empty-state o `rowCount` 0.
 * Es la heurística que captura el bug de Gestión (HTTP 200 con datos vacíos).
 *
 * @returns Anomaly de categoría `empty-state` o `null`.
 */
export function detectEmptyStateAnomaly(visit: VisitResult, scenario: Scenario): Anomaly | null {
  if (!scenario.expectsData) {
    return null;
  }
  const signal = visit.dataSignal;
  if (!signal) {
    return null;
  }
  const isEmpty = signal.isEmptyState || signal.rowCount === 0;
  if (!isEmpty) {
    return null;
  }
  return buildAnomaly(
    visit,
    "empty-state",
    `El scenario esperaba datos pero ${visit.route.path} devolvió un empty-state (rowCount=${
      signal.rowCount ?? "n/d"
    }).`,
  );
}

/**
 * Serie truncada: la serie temporal del Visit_Result termina antes del fin del
 * rango pedido (`lastDataPoint < requestedEnd` más allá de la tolerancia), pese
 * a contener datos. La tolerancia es opcional para respetar la firma de diseño
 * `detectTruncatedSeriesAnomaly(visit)`; el orquestador inyecta la del
 * DetectorConfig.
 *
 * @returns Anomaly de categoría `truncated-series` o `null`.
 */
export function detectTruncatedSeriesAnomaly(
  visit: VisitResult,
  toleranceDays: number = DEFAULT_SERIES_END_TOLERANCE_DAYS,
): Anomaly | null {
  const series = visit.dataSignal?.timeSeries;
  if (!series || !series.requestedEnd || !series.lastDataPoint) {
    return null;
  }
  // Sin datos no hay truncamiento (eso lo cubre empty-state).
  if (series.pointCount <= 0) {
    return null;
  }
  const gap = daysBetween(series.lastDataPoint, series.requestedEnd);
  if (gap === null || gap <= toleranceDays) {
    return null;
  }
  return buildAnomaly(
    visit,
    "truncated-series",
    `La serie de ${visit.route.path} termina en ${series.lastDataPoint}, ${gap} día(s) antes del fin del rango pedido (${series.requestedEnd}); tolerancia ${toleranceDays}.`,
  );
}

/**
 * Paginación estancada: la página siguiente conserva un control "siguiente"
 * habilitado pero repite la firma de items de la anterior, es decir, no avanza.
 *
 * @returns Anomaly de categoría `stuck-pagination` (sobre `next`) o `null`.
 */
export function detectStuckPaginationAnomaly(
  prev: VisitResult,
  next: VisitResult,
): Anomaly | null {
  const prevPage = prev.dataSignal?.pagination;
  const nextPage = next.dataSignal?.pagination;
  if (!prevPage || !nextPage) {
    return null;
  }
  if (!nextPage.hasNextControl) {
    return null;
  }
  if (nextPage.pageItemSignature !== prevPage.pageItemSignature) {
    return null;
  }
  return buildAnomaly(
    next,
    "stuck-pagination",
    `La paginación de ${next.route.path} no avanza: la página ${nextPage.pageIndex} repite los items de la página ${prevPage.pageIndex} pese a ofrecer control "siguiente".`,
  );
}

/**
 * Totales incoherentes: dos Visits con rangos solapados donde uno contiene
 * estrictamente al otro producen totales que violan la relación esperada (el
 * total de un rango mayor no puede ser menor que el de un sub-rango). Compara
 * las claves de `totals` comunes a ambas Visits.
 *
 * @returns Anomaly de categoría `incoherent-totals` (sobre la Visit de rango
 *   mayor) o `null`.
 */
export function detectIncoherentTotals(a: VisitResult, b: VisitResult): Anomaly | null {
  const rangeA = visitDateRange(a);
  const rangeB = visitDateRange(b);
  const totalsA = a.dataSignal?.totals;
  const totalsB = b.dataSignal?.totals;
  if (!rangeA || !rangeB || !totalsA || !totalsB) {
    return null;
  }

  const equalRange = rangeA.start === rangeB.start && rangeA.end === rangeB.end;
  if (equalRange) {
    return null; // sin relación mayor/sub-rango no aplica la heurística
  }

  const aContainsB = rangeA.start <= rangeB.start && rangeA.end >= rangeB.end;
  const bContainsA = rangeB.start <= rangeA.start && rangeB.end >= rangeA.end;

  let larger: VisitResult;
  let smaller: VisitResult;
  let largerTotals: Record<string, number>;
  let smallerTotals: Record<string, number>;
  if (aContainsB) {
    larger = a;
    smaller = b;
    largerTotals = totalsA;
    smallerTotals = totalsB;
  } else if (bContainsA) {
    larger = b;
    smaller = a;
    largerTotals = totalsB;
    smallerTotals = totalsA;
  } else {
    return null; // solapamiento parcial: relación ambigua, no se marca
  }

  for (const key of Object.keys(largerTotals)) {
    if (!(key in smallerTotals)) {
      continue;
    }
    const largerValue = largerTotals[key];
    const smallerValue = smallerTotals[key];
    if (!Number.isFinite(largerValue) || !Number.isFinite(smallerValue)) {
      continue; // los NaN los cubre detectSuspiciousNulls
    }
    if (largerValue < smallerValue) {
      return buildAnomaly(
        larger,
        "incoherent-totals",
        `Total incoherente en "${key}" de ${larger.route.path}: el rango mayor (${largerValue}) es menor que el sub-rango (${smallerValue}).`,
      );
    }
  }

  return null;
}

/**
 * Valores sospechosos: KPIs donde se esperaba un número pero el total es NaN o
 * no finito (proviene de `null` / `"-"` / `NaN` en el DOM o el JSON).
 *
 * @returns Anomaly de categoría `suspicious-null` o `null`.
 */
export function detectSuspiciousNulls(visit: VisitResult): Anomaly | null {
  const totals = visit.dataSignal?.totals;
  if (!totals) {
    return null;
  }
  const suspicious = Object.keys(totals).filter((key) => !Number.isFinite(totals[key]));
  if (suspicious.length === 0) {
    return null;
  }
  return buildAnomaly(
    visit,
    "suspicious-null",
    `Valor(es) sospechoso(s) (no numérico/NaN) en KPI(s) [${suspicious.join(", ")}] de ${visit.route.path}.`,
  );
}

/**
 * Orquestador: aplica todos los detectores deterministas que operan sobre un
 * único Visit_Result (técnicos, latencia, timeout, empty-state, serie truncada,
 * valores sospechosos) y devuelve el conjunto de Anomalies resultante.
 *
 * Los detectores por pares (stuck-pagination, incoherent-totals) necesitan dos
 * Visits y los aplica el Run_Orchestrator por separado.
 *
 * Es una función pura: el mismo Visit_Result + Scenario + DetectorConfig
 * produce siempre el mismo conjunto de Anomalies. (Req 5.6, 5.7, 9.4, 10.6)
 */
export function detectAnomalies(
  visit: VisitResult,
  scenario: Scenario,
  config: DetectorConfig,
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  anomalies.push(...detectTechnicalAnomalies(visit));

  const latency = detectLatencyAnomaly(visit, config.latencyThresholdMs);
  if (latency) {
    anomalies.push(latency);
  }

  const timeout = detectTimeoutAnomaly(visit);
  if (timeout) {
    anomalies.push(timeout);
  }

  const emptyState = detectEmptyStateAnomaly(visit, scenario);
  if (emptyState) {
    anomalies.push(emptyState);
  }

  const truncated = detectTruncatedSeriesAnomaly(visit, config.seriesEndToleranceDays);
  if (truncated) {
    anomalies.push(truncated);
  }

  const suspicious = detectSuspiciousNulls(visit);
  if (suspicious) {
    anomalies.push(suspicious);
  }

  return anomalies;
}
