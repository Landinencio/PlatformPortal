// Feature: ai-portal-explorer, Property 15: Paginación estancada es una anomalía
/**
 * Property-based test for the Anomaly_Detectors — stuck pagination heuristic.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/anomaly-detectors.ts
 *
 * Property 15: Paginación estancada es una anomalía.
 *   Para TODO par de páginas consecutivas (prev, next) de una misma lista,
 *   `detectStuckPaginationAnomaly(prev, next)` devuelve una Anomaly NO nula de
 *   categoría `stuck-pagination` SI Y SOLO SI:
 *     - ambos `prev.dataSignal.pagination` y `next.dataSignal.pagination` están
 *       presentes, Y
 *     - `next.pagination.hasNextControl === true`, Y
 *     - `next.pagination.pageItemSignature === prev.pagination.pageItemSignature`
 *       (la paginación no avanza pese a ofrecer un control "siguiente").
 *   En cualquier otro caso devuelve `null`.
 *
 * **Validates: Requirements 5.7**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/anomaly-detectors.prop15.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { detectStuckPaginationAnomaly } from "../anomaly-detectors";
import type { PaginationSignal, Route, VisitResult } from "../types";
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
  path: fc.constantFrom("/metrics", "/finops", "/admin", "/synthetics").map((s) => s),
  section: fc.constantFrom(...SECTIONS),
}) as fc.Arbitrary<Route>;

/**
 * Firmas de items extraídas de un pool DELIBERADAMENTE pequeño para que la
 * igualdad de `pageItemSignature` entre prev y next ocurra con frecuencia
 * (≈ caso "no avanza") además del caso mayoritario en que difieren.
 */
const arbSignature: fc.Arbitrary<string> = fc.constantFrom("sigA", "sigB", "sigC", "");

const arbPagination: fc.Arbitrary<PaginationSignal> = fc.record({
  pageIndex: fc.integer({ min: 0, max: 20 }),
  hasNextControl: fc.boolean(),
  pageItemSignature: arbSignature,
});

/**
 * `pagination` varía: a veces ausente (null) y a veces presente. Cuando está
 * ausente, el detector no puede comparar y debe devolver null.
 */
const arbMaybePagination: fc.Arbitrary<PaginationSignal | null> = fc.option(arbPagination, {
  nil: null,
  // Sesgo hacia paginación presente para ejercitar el núcleo de la heurística.
  freq: 4,
});

/**
 * Construye un VisitResult mínimo pero completo, con una `pagination` dada
 * (o `null`) inyectada en su `dataSignal`. El resto de campos son benignos:
 * lo único que mira el detector es `dataSignal.pagination`.
 */
function makeVisit(pagination: PaginationSignal | null, route: Route, role: VisitResult["role"]): VisitResult {
  return {
    runId: "run-prop15",
    scenarioId: "scn-prop15",
    route,
    role,
    params: {},
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
      pagination,
      totals: {},
    },
    screenshotRef: null,
    accessObserved: "granted",
  };
}

/**
 * Oráculo independiente que reimplementa la condición IFF de Property 15 a
 * partir de las paginaciones de prev/next.
 */
function expectStuck(
  prevPage: PaginationSignal | null,
  nextPage: PaginationSignal | null,
): boolean {
  if (!prevPage || !nextPage) {
    return false;
  }
  return (
    nextPage.hasNextControl === true &&
    nextPage.pageItemSignature === prevPage.pageItemSignature
  );
}

/* ------------------------------------------------------------------ */
/*  Property 15                                                         */
/* ------------------------------------------------------------------ */

test("Property 15: detectStuckPaginationAnomaly marca stuck-pagination IFF hay control siguiente y la firma no cambia", () => {
  fc.assert(
    fc.property(
      arbMaybePagination,
      arbMaybePagination,
      arbRoute,
      arbAppRole,
      (prevPage, nextPage, route, role) => {
        const prev = makeVisit(prevPage, route, role);
        const next = makeVisit(nextPage, route, role);

        const result = detectStuckPaginationAnomaly(prev, next);
        const shouldBeAnomaly = expectStuck(prevPage, nextPage);

        if (shouldBeAnomaly) {
          assert.notEqual(result, null, "se esperaba una Anomaly de paginación estancada");
          assert.equal(
            result?.category,
            "stuck-pagination",
            "la categoría debe ser stuck-pagination",
          );
          // La anomalía se reporta sobre la página `next`.
          assert.equal(result?.role, role, "role coherente con la Visit next");
          assert.equal(result?.route.path, route.path, "route coherente con la Visit next");
        } else {
          assert.equal(result, null, "no debería producirse anomalía de paginación estancada");
        }
      },
    ),
    { numRuns: 100 },
  );
});
