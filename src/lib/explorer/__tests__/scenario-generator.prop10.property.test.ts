// Feature: ai-portal-explorer, Property 10: La generación de Scenarios es determinista y usa solo valores seguros
/**
 * Property-based test for the Scenario_Generator.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/scenario-generator.ts
 *
 * Property 10: La generación de Scenarios es determinista y usa solo valores seguros.
 *   - DETERMINISTA: para un mismo (route, matrix, runDate), `generateScenarios`
 *     produce exactamente los mismos Scenarios, en el mismo orden y con los
 *     mismos `scenarioId`.
 *   - SOLO VALORES SEGUROS: cada valor de parámetro de cada Scenario proviene
 *     EXCLUSIVAMENTE de los rangos de fechas de la matriz (startDate/endDate) o
 *     de los `safeValues` declarados (en la Route o en el override de sección de
 *     la matriz). El generador nunca inventa valores.
 *   - `buildScenarioId` es estable e independiente de runId/timestamp: depende
 *     únicamente de `route.id` + los parámetros canonicalizados.
 *
 * **Validates: Requirements 4.5**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/scenario-generator.prop10.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  generateScenarios,
  buildScenarioId,
  DEFAULT_SCENARIO_MATRIX,
} from "../scenario-generator";
import type { ScenarioMatrix } from "../scenario-generator";
import type { PortalSection } from "@/lib/rbac";
import type { Route } from "../types";

/* ------------------------------------------------------------------ */
/*  Arbitraries                                                        */
/* ------------------------------------------------------------------ */

const SECTIONS: readonly PortalSection[] = [
  "home",
  "metrics",
  "finops",
  "create-infra",
  "access-management",
  "incidents",
  "requests",
  "sonarqube",
  "synthetics",
  "infra-requests",
  "kiro-analytics",
  "admin",
] as const;

const FILTER_KEYS = ["team", "accountIds", "projectIds", "author"] as const;

/** A clean YYYY-MM-DD literal (no offset) so resolveDate is the identity. */
const arbIsoDate: fc.Arbitrary<string> = fc
  .date({
    min: new Date("2024-01-01T00:00:00.000Z"),
    max: new Date("2027-12-31T00:00:00.000Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10));

const arbSafeValues: fc.Arbitrary<string[]> = fc.uniqueArray(
  fc.string({ minLength: 1, maxLength: 6 }),
  { minLength: 0, maxLength: 4 },
);

const arbFilterSpec = fc.record({
  key: fc.constantFrom(...FILTER_KEYS),
  safeValues: arbSafeValues,
});

const arbDateRangeSpec = fc.record({
  label: fc.constantFrom("last-7d", "last-90d", "crosses-90d-boundary", "historic-q1", "custom"),
  startDate: arbIsoDate,
  endDate: arbIsoDate,
  expectsData: fc.boolean(),
});

const arbRoute: fc.Arbitrary<Route> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  kind: fc.constantFrom<"ui" | "api">("ui", "api"),
  path: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `/${s}`),
  section: fc.constantFrom(...SECTIONS),
  paramSpec: fc.option(
    fc.record({
      dateRange: fc.option(fc.boolean(), { nil: undefined }),
      filters: fc.option(fc.array(arbFilterSpec, { maxLength: 3 }), { nil: undefined }),
    }),
    { nil: undefined },
  ),
}) as fc.Arbitrary<Route>;

const arbMatrix: fc.Arbitrary<ScenarioMatrix> = fc.record({
  dateRanges: fc.array(arbDateRangeSpec, { minLength: 1, maxLength: 4 }),
  filtersBySection: fc.dictionary(
    fc.constantFrom(...SECTIONS),
    fc.array(arbFilterSpec, { maxLength: 3 }),
    { maxKeys: 3 },
  ),
}) as fc.Arbitrary<ScenarioMatrix>;

/* ------------------------------------------------------------------ */
/*  Independent "safe value source" oracles (no logic duplication)     */
/* ------------------------------------------------------------------ */

/** Every literal start/end date declared anywhere in the matrix. */
function allowedDateValues(matrix: ScenarioMatrix): Set<string> {
  const set = new Set<string>();
  for (const r of matrix.dateRanges) {
    set.add(r.startDate.trim());
    set.add(r.endDate.trim());
  }
  return set;
}

/**
 * Per-key union of every safeValue declared either on the Route's filters or in
 * ANY section override of the matrix. A generated filter value must belong to
 * one of these declared sources (no invented values).
 */
function allowedFilterValues(route: Route, matrix: ScenarioMatrix): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (key: string, val: string) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(val);
  };
  for (const f of route.paramSpec?.filters ?? []) {
    for (const v of f.safeValues) add(f.key, v);
  }
  for (const list of Object.values(matrix.filtersBySection)) {
    for (const f of list ?? []) {
      for (const v of f.safeValues) add(f.key, v);
    }
  }
  return map;
}

/* ------------------------------------------------------------------ */
/*  Property 10                                                        */
/* ------------------------------------------------------------------ */

test("Property 10: generateScenarios is deterministic and uses only safe values", () => {
  fc.assert(
    fc.property(arbRoute, arbMatrix, arbIsoDate, (route, matrix, runDate) => {
      const first = generateScenarios(route, matrix, runDate);
      const second = generateScenarios(route, matrix, runDate);

      // DETERMINISTA: misma salida, mismo orden, mismos scenarioId.
      assert.deepEqual(first, second);

      const allowedDates = allowedDateValues(matrix);
      const allowedFilters = allowedFilterValues(route, matrix);

      for (const sc of first) {
        // scenarioId estable e independiente de runId/timestamp: depende solo de
        // route.id + params canonicalizados.
        assert.equal(sc.scenarioId, buildScenarioId(route, sc.params));
        assert.equal(buildScenarioId(route, sc.params), buildScenarioId(route, sc.params));

        // La Route se preserva en el Scenario.
        assert.equal(sc.route, route);

        // SOLO VALORES SEGUROS: cada valor de parámetro proviene de la matriz.
        for (const [key, val] of Object.entries(sc.params)) {
          if (key === "startDate" || key === "endDate") {
            assert.ok(
              allowedDates.has(val),
              `date param ${key}=${val} no proviene de la Scenario_Matrix`,
            );
          } else {
            const safe = allowedFilters.get(key);
            assert.ok(
              safe !== undefined && safe.has(val),
              `filter param ${key}=${val} no es un safeValue declarado`,
            );
          }
        }
      }
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Directed examples (default matrix + offset resolution)             */
/* ------------------------------------------------------------------ */

test("Property 10 (example): default matrix is deterministic and resolves offsets stably", () => {
  const route: Route = {
    id: "metrics-ui",
    kind: "ui",
    path: "/metrics",
    section: "metrics",
    paramSpec: { dateRange: true, filters: [{ key: "team", safeValues: ["digital", "retail"] }] },
  };

  const r1 = generateScenarios(route, DEFAULT_SCENARIO_MATRIX, "2026-06-15");
  const r2 = generateScenarios(route, DEFAULT_SCENARIO_MATRIX, "2026-06-15");
  assert.deepEqual(r1, r2);

  // 4 rangos de fecha × 2 equipos = 8 scenarios.
  assert.equal(r1.length, 8);

  // El rango del bug de Gestión está presente con sus fechas literales.
  const crossing = r1.filter((s) => s.label === "crosses-90d-boundary");
  assert.ok(crossing.length > 0, "crosses-90d-boundary debe generarse");
  for (const s of crossing) {
    assert.equal(s.params.startDate, "2026-01-01");
    assert.equal(s.params.endDate, "2026-03-28");
    assert.equal(s.expectsData, true);
  }

  // Los offsets relativos se resuelven de forma estable contra runDate.
  const last7 = r1.find((s) => s.label === "last-7d");
  assert.ok(last7);
  assert.equal(last7!.params.startDate, "2026-06-08"); // -7d
  assert.equal(last7!.params.endDate, "2026-06-15"); // 0d
});

test("Property 10 (example): buildScenarioId depends only on route.id + canonical params", () => {
  const route: Route = { id: "metrics-ui", kind: "ui", path: "/metrics", section: "metrics" };
  const id1 = buildScenarioId(route, {
    startDate: "2026-01-01",
    endDate: "2026-03-28",
    team: "digital",
  });
  // Mismo conjunto de params en distinto orden de inserción => mismo id (canónico).
  const id2 = buildScenarioId(route, {
    team: "digital",
    endDate: "2026-03-28",
    startDate: "2026-01-01",
  });
  assert.equal(id1, id2);
  assert.match(id1, /^scn_[0-9a-f]{16}$/);
});
