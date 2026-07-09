// Feature: ai-portal-explorer, Property 16: Totales incoherentes entre rangos solapados son una anomalía
/**
 * Property-based test for the Anomaly_Detectors — incoherent totals heuristic.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/anomaly-detectors.ts
 *
 * Property 16: Totales incoherentes entre rangos solapados son una anomalía.
 *   Para TODO par de Visits (a, b) con rangos de fechas derivados de
 *   `params.startDate/endDate`, `detectIncoherentTotals(a, b)` devuelve una
 *   Anomaly NO nula de categoría `incoherent-totals` SI Y SOLO SI:
 *     - ambos `dataSignal.totals` están presentes, Y
 *     - uno de los rangos contiene ESTRICTAMENTE al otro (el mayor contiene al
 *       menor; rangos iguales → null; solapamiento parcial/disjunto → null), Y
 *     - existe una clave común de `totals` en la que el valor del rango mayor es
 *       menor que el del sub-rango (ambos finitos).
 *   En cualquier otro caso devuelve `null`.
 *
 * **Validates: Requirements 5.7**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/anomaly-detectors.prop16.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { detectIncoherentTotals } from "../anomaly-detectors";
import type { Route, VisitResult } from "../types";
import type { PortalSection } from "@/lib/rbac";
import { arbAppRole } from "./arbitraries";

/* ------------------------------------------------------------------ */
/*  Arbitraries locales                                                 */
/* ------------------------------------------------------------------ */

const SECTIONS: readonly PortalSection[] = [
  "home",
  "metrics",
  "finops",
  "admin",
  "synthetics",
] as const;

const arbRoute: fc.Arbitrary<Route> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  kind: fc.constantFrom<"ui" | "api">("ui", "api"),
  path: fc.constantFrom("/metrics", "/finops", "/admin", "/synthetics"),
  section: fc.constantFrom(...SECTIONS),
}) as fc.Arbitrary<Route>;

/** Fecha ISO YYYY-MM-DD a partir de un offset de días desde 2026-01-01. */
function isoFromDayOffset(offset: number): string {
  const base = Date.UTC(2026, 0, 1);
  const d = new Date(base + offset * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Genera un rango {start, end} con start <= end, a partir de dos offsets de día
 * en una ventana pequeña (0..30) para que el solapamiento, la igualdad y la
 * contención entre rangos ocurran con frecuencia.
 */
const arbRange: fc.Arbitrary<{ start: string; end: string }> = fc
  .tuple(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 }))
  .map(([x, y]) => {
    const lo = Math.min(x, y);
    const hi = Math.max(x, y);
    return { start: isoFromDayOffset(lo), end: isoFromDayOffset(hi) };
  });

/**
 * Diccionario de totales con claves de un pool DELIBERADAMENTE pequeño (para
 * que dos Visits compartan claves con frecuencia) y valores que incluyen
 * finitos y, ocasionalmente, no finitos (NaN/Infinity) para ejercitar el
 * filtro de finitud del detector.
 */
const arbTotalValue: fc.Arbitrary<number> = fc.oneof(
  { weight: 9, arbitrary: fc.double({ min: -1000, max: 1000, noNaN: true }) },
  { weight: 1, arbitrary: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY) },
);

const arbTotals: fc.Arbitrary<Record<string, number>> = fc.dictionary(
  fc.constantFrom("cost", "count", "errors", "latency"),
  arbTotalValue,
  { maxKeys: 4 },
);

/**
 * Construye un VisitResult mínimo con un rango (inyectado vía params) y un
 * diccionario de totales. El detector solo mira `params.startDate/endDate`
 * (o la serie) y `dataSignal.totals`; el resto de campos son benignos.
 */
function makeVisit(
  range: { start: string; end: string },
  totals: Record<string, number>,
  route: Route,
  role: VisitResult["role"],
): VisitResult {
  return {
    runId: "run-prop16",
    scenarioId: "scn-prop16",
    route,
    role,
    params: { startDate: range.start, endDate: range.end },
    httpStatus: 200,
    latencyMs: 100,
    timedOut: false,
    consoleErrors: [],
    failedRequests: [],
    domErrorStates: [],
    dataSignal: {
      isEmptyState: false,
      rowCount: 10,
      timeSeries: null,
      pagination: null,
      totals,
    },
    screenshotRef: null,
    accessObserved: "granted",
  };
}

/* ------------------------------------------------------------------ */
/*  Oráculo independiente                                              */
/* ------------------------------------------------------------------ */

/**
 * Reimplementa, de forma independiente del módulo, la lógica de contención +
 * comparación de Property 16. Devuelve true sii hay relación de contención
 * estricta (mayor contiene al menor, rangos NO iguales) y existe alguna clave
 * común donde el total del rango mayor es menor que el del sub-rango (ambos
 * finitos).
 */
function expectIncoherent(
  rangeA: { start: string; end: string },
  totalsA: Record<string, number>,
  rangeB: { start: string; end: string },
  totalsB: Record<string, number>,
): boolean {
  const equalRange = rangeA.start === rangeB.start && rangeA.end === rangeB.end;
  if (equalRange) {
    return false;
  }
  const aContainsB = rangeA.start <= rangeB.start && rangeA.end >= rangeB.end;
  const bContainsA = rangeB.start <= rangeA.start && rangeB.end >= rangeA.end;

  let largerTotals: Record<string, number>;
  let smallerTotals: Record<string, number>;
  if (aContainsB) {
    largerTotals = totalsA;
    smallerTotals = totalsB;
  } else if (bContainsA) {
    largerTotals = totalsB;
    smallerTotals = totalsA;
  } else {
    return false; // solapamiento parcial o disjunto
  }

  for (const key of Object.keys(largerTotals)) {
    if (!(key in smallerTotals)) {
      continue;
    }
    const largerValue = largerTotals[key];
    const smallerValue = smallerTotals[key];
    if (!Number.isFinite(largerValue) || !Number.isFinite(smallerValue)) {
      continue;
    }
    if (largerValue < smallerValue) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Property 16                                                         */
/* ------------------------------------------------------------------ */

test("Property 16: detectIncoherentTotals marca incoherent-totals IFF un rango contiene estrictamente al otro y hay una clave común con mayor < sub-rango", () => {
  fc.assert(
    fc.property(
      arbRange,
      arbTotals,
      arbRange,
      arbTotals,
      arbRoute,
      arbAppRole,
      (rangeA, totalsA, rangeB, totalsB, route, role) => {
        const a = makeVisit(rangeA, totalsA, route, role);
        const b = makeVisit(rangeB, totalsB, route, role);

        const result = detectIncoherentTotals(a, b);
        const shouldBeAnomaly = expectIncoherent(rangeA, totalsA, rangeB, totalsB);

        if (shouldBeAnomaly) {
          assert.notEqual(result, null, "se esperaba una Anomaly de totales incoherentes");
          assert.equal(
            result?.category,
            "incoherent-totals",
            "la categoría debe ser incoherent-totals",
          );
        } else {
          assert.equal(result, null, "no debería producirse anomalía de totales incoherentes");
        }
      },
    ),
    { numRuns: 100 },
  );
});
