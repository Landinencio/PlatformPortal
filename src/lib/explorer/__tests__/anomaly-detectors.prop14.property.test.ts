// Feature: ai-portal-explorer, Property 14: Serie temporal truncada antes del fin del rango es una anomalía
/**
 * Property-based test for the Anomaly_Detectors — serie temporal truncada.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/anomaly-detectors.ts
 *
 * Property 14: Serie temporal truncada antes del fin del rango es una anomalía.
 *   Para TODO Visit_Result, `detectTruncatedSeriesAnomaly(visit, tolerance)`
 *   devuelve una Anomaly NO nula de categoría `truncated-series` SI Y SOLO SI:
 *     - `dataSignal.timeSeries` está presente (no nulo),
 *     - `requestedEnd` y `lastDataPoint` son no nulos,
 *     - `pointCount > 0`,
 *     - y el hueco en días `(requestedEnd - lastDataPoint)` supera la tolerancia.
 *   En cualquier otro caso devuelve `null`. El oráculo replica el cálculo UTC
 *   de `daysBetween` del módulo. Se ejercita con una tolerancia fija y con la
 *   tolerancia por defecto (DEFAULT_SERIES_END_TOLERANCE_DAYS).
 *
 * **Validates: Requirements 5.7**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/anomaly-detectors.prop14.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  detectTruncatedSeriesAnomaly,
  DEFAULT_SERIES_END_TOLERANCE_DAYS,
} from "../anomaly-detectors";
import type {
  DataSignal,
  Route,
  TimeSeriesSignal,
  VisitResult,
} from "../types";
import { arbAppRole } from "./arbitraries";

/* ------------------------------------------------------------------ */
/*  Oráculo: replica daysBetween (UTC) del módulo bajo prueba           */
/* ------------------------------------------------------------------ */

/**
 * Diferencia en días entre dos fechas ISO (YYYY-MM-DD) en UTC. Espejo exacto
 * de la función privada `daysBetween` de anomaly-detectors.ts: devuelve
 * `endISO - startISO`, o `null` si alguna fecha no es parseable.
 */
function daysBetween(startISO: string, endISO: string): number | null {
  const start = Date.parse(`${startISO}T00:00:00Z`);
  const end = Date.parse(`${endISO}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  return Math.round((end - start) / 86_400_000);
}

/**
 * Oráculo del IFF de la Property 14: ¿debe `detectTruncatedSeriesAnomaly`
 * devolver una Anomaly para este Visit_Result y tolerancia?
 */
function expectsTruncated(signal: DataSignal | null, tolerance: number): boolean {
  const ts = signal?.timeSeries;
  if (!ts || !ts.requestedEnd || !ts.lastDataPoint) {
    return false;
  }
  if (ts.pointCount <= 0) {
    return false;
  }
  const gap = daysBetween(ts.lastDataPoint, ts.requestedEnd);
  if (gap === null || gap <= tolerance) {
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/*  Arbitraries locales: fechas ISO, TimeSeriesSignal y VisitResult     */
/* ------------------------------------------------------------------ */

/** Epoch base (UTC) para generar fechas ISO deterministas. */
const BASE_EPOCH = Date.UTC(2025, 0, 1); // 2025-01-01

/** Convierte un desplazamiento en días desde la base a `YYYY-MM-DD`. */
function isoDate(offsetDays: number): string {
  return new Date(BASE_EPOCH + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Arbitrary de TimeSeriesSignal que cubre el espacio relevante:
 *  - `lastDataPoint` a veces null y, cuando existe, con huecos respecto al fin
 *    del rango que van desde negativos (punto posterior al fin) hasta muy
 *    grandes, pasando por el entorno de la tolerancia (0/1/2 días);
 *  - `firstDataPoint` a veces null;
 *  - `pointCount` incluyendo 0 y valores positivos.
 * `requestedStart`/`requestedEnd` son siempre fechas ISO válidas (acorde al
 * tipo `TimeSeriesSignal`, cuyos campos de rango son string no nulos).
 */
const arbTimeSeriesSignal: fc.Arbitrary<TimeSeriesSignal> = fc
  .record({
    startOffset: fc.integer({ min: 0, max: 1000 }),
    spanDays: fc.integer({ min: 1, max: 120 }),
    // gap = requestedEnd - lastDataPoint. Negativo => punto posterior al fin.
    lastGapDays: fc.integer({ min: -5, max: 130 }),
    lastNull: fc.boolean(),
    firstNull: fc.boolean(),
    pointCount: fc.integer({ min: 0, max: 50 }),
  })
  .map(({ startOffset, spanDays, lastGapDays, lastNull, firstNull, pointCount }) => {
    const requestedStart = isoDate(startOffset);
    const requestedEnd = isoDate(startOffset + spanDays);
    const lastDataPoint = lastNull ? null : isoDate(startOffset + spanDays - lastGapDays);
    const firstDataPoint = firstNull ? null : requestedStart;
    return {
      requestedStart,
      requestedEnd,
      firstDataPoint,
      lastDataPoint,
      pointCount,
    } satisfies TimeSeriesSignal;
  });

/** DataSignal centrado en la serie temporal (resto de señales neutras). */
const arbDataSignal: fc.Arbitrary<DataSignal> = fc.record({
  isEmptyState: fc.boolean(),
  rowCount: fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
  timeSeries: fc.option(arbTimeSeriesSignal, { nil: null }),
  pagination: fc.constant(null),
  totals: fc.constant({} as Record<string, number>),
}) as fc.Arbitrary<DataSignal>;

const arbRoute: fc.Arbitrary<Route> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  kind: fc.constantFrom<"ui" | "api">("ui", "api"),
  path: fc.constantFrom("/metrics", "/finops", "/api/metrics/team-activity", "/admin"),
  section: fc.constantFrom("metrics", "finops", "admin"),
}) as fc.Arbitrary<Route>;

/**
 * Arbitrary de VisitResult con `dataSignal` a veces null (para cubrir la rama
 * "sin señal de serie"). El resto de campos son neutros: la heurística sólo
 * depende de `dataSignal.timeSeries`, pero rellenamos un Visit completo.
 */
const arbVisitResult: fc.Arbitrary<VisitResult> = fc
  .record({
    runId: fc.uuid(),
    scenarioId: fc.string({ minLength: 1, maxLength: 16 }),
    route: arbRoute,
    role: arbAppRole,
    dataSignal: fc.option(arbDataSignal, { nil: null }),
  })
  .map(({ runId, scenarioId, route, role, dataSignal }) => ({
    runId,
    scenarioId,
    route,
    role,
    params: {},
    httpStatus: 200,
    latencyMs: 100,
    timedOut: false,
    consoleErrors: [],
    failedRequests: [],
    domErrorStates: [],
    dataSignal,
    screenshotRef: null,
    accessObserved: "granted" as const,
  })) as fc.Arbitrary<VisitResult>;

/* ------------------------------------------------------------------ */
/*  Aserción reutilizable del IFF                                       */
/* ------------------------------------------------------------------ */

function assertIff(visit: VisitResult, tolerance: number, expected: boolean): void {
  const result =
    tolerance === DEFAULT_SERIES_END_TOLERANCE_DAYS
      ? // Ejercita también la firma con tolerancia por defecto.
        pickDefaultOrExplicit(visit, tolerance)
      : detectTruncatedSeriesAnomaly(visit, tolerance);

  if (expected) {
    assert.ok(result !== null, "se esperaba una Anomaly de serie truncada");
    assert.equal(result!.category, "truncated-series", "categoría truncated-series");
    // Identidad: la Anomaly refiere al mismo Visit_Result.
    assert.equal(result!.runId, visit.runId, "runId preservado");
    assert.equal(result!.route, visit.route, "route preservada");
    assert.equal(result!.role, visit.role, "role preservado");
    assert.equal(result!.scenarioId, visit.scenarioId, "scenarioId preservado");
    assert.equal(result!.detector, "deterministic", "detector determinista");
  } else {
    assert.equal(result, null, "no se esperaba Anomaly");
  }
}

/**
 * Para el caso de la tolerancia por defecto, invocamos la firma de un solo
 * argumento `detectTruncatedSeriesAnomaly(visit)` (que aplica
 * DEFAULT_SERIES_END_TOLERANCE_DAYS) de forma aleatoria, garantizando que ambas
 * rutas de la firma quedan cubiertas.
 */
function pickDefaultOrExplicit(visit: VisitResult, tolerance: number) {
  return detectTruncatedSeriesAnomaly(visit);
}

/* ------------------------------------------------------------------ */
/*  Property 14a: tolerancia fija arbitraria                            */
/* ------------------------------------------------------------------ */

test("Property 14: truncated-series IFF la serie termina antes del fin del rango (tolerancia fija)", () => {
  fc.assert(
    fc.property(arbVisitResult, fc.integer({ min: 0, max: 5 }), (visit, tolerance) => {
      const expected = expectsTruncated(visit.dataSignal, tolerance);
      assertIff(visit, tolerance, expected);
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 14b: tolerancia por defecto                                */
/* ------------------------------------------------------------------ */

test("Property 14: truncated-series IFF la serie termina antes del fin del rango (tolerancia por defecto)", () => {
  fc.assert(
    fc.property(arbVisitResult, (visit) => {
      const tolerance = DEFAULT_SERIES_END_TOLERANCE_DAYS;
      const expected = expectsTruncated(visit.dataSignal, tolerance);
      assertIff(visit, tolerance, expected);
    }),
    { numRuns: 100 },
  );
});
