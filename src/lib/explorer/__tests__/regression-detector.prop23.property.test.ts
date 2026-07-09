// Feature: ai-portal-explorer, Property 23: La detección de regresiones es determinista por Route+Role+categoría
/**
 * Property-based test for the Regression_Detector.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/regression-detector.ts
 *
 * Property 23: La detección de regresiones es determinista por Route+Role+categoría.
 *   Para TODO conjunto de Triage_Results actual y baseline:
 *   - Si NO existe baseline comparable (`previous === null`) → `hasBaseline` es
 *     false y no se clasifica ninguna Regression (`regressions === []`)
 *     (Req 8.3).
 *   - Si existe baseline (lista) → `hasBaseline` es true y un Triage_Result del
 *     run actual es Regression si y solo si su clave de equivalencia
 *     (Route + Role + categoría) NO aparece en el conjunto de claves del
 *     baseline (Req 8.1, 8.2, 8.4).
 *   - Determinismo: invocar `detectRegressions` dos veces sobre la misma entrada
 *     produce resultados profundamente iguales.
 *   - Verificación bidireccional: toda Regression devuelta tiene una clave
 *     ausente del baseline; todo Triage_Result actual cuya clave SÍ está en el
 *     baseline NO se devuelve como Regression.
 *
 * **Validates: Requirements 8.1, 8.2, 8.3, 8.4**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/regression-detector.prop23.property.test.ts
 *
 * regression-detector.ts NO importa el AWS SDK, así que no se necesita polyfill
 * de Web Streams.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { detectRegressions } from "../regression-detector";
import { SEVERITY_ORDER } from "../types";
import type {
  AnomalyCategory,
  AnomalyEvidence,
  Severity,
  TriageResult,
  TriageStatus,
} from "../types";
import { arbAppRole } from "./arbitraries";

/* ------------------------------------------------------------------ */
/*  Conjuntos de validación (espejo de las uniones de types.ts)         */
/* ------------------------------------------------------------------ */

const ANOMALY_CATEGORIES: readonly AnomalyCategory[] = [
  "console-error",
  "failed-request",
  "dom-error",
  "performance",
  "timeout",
  "rbac",
  "empty-state",
  "truncated-series",
  "stuck-pagination",
  "incoherent-totals",
  "suspicious-null",
] as const;

const TRIAGE_STATUSES: readonly TriageStatus[] = [
  "triaged",
  "triage-unavailable",
  "triage-skipped-budget",
] as const;

/* ------------------------------------------------------------------ */
/*  Clave de equivalencia (espejo de regressionEquivalenceKey en el      */
/*  módulo bajo test): Route + Role + categoría (Req 8.4).               */
/* ------------------------------------------------------------------ */

function key(t: TriageResult): string {
  return `${t.route}::${t.role}::${t.category}`;
}

/* ------------------------------------------------------------------ */
/*  Arbitraries: Triage_Result con énfasis en route/role/categoría      */
/* ------------------------------------------------------------------ */

/**
 * Pool de rutas pequeño y deliberado para forzar colisiones de clave entre el
 * run actual y el baseline (y así ejercitar de verdad el filtrado por
 * equivalencia, no solo el caso "todo es nuevo").
 */
const arbRoutePath: fc.Arbitrary<string> = fc
  .constantFrom("metrics", "finops", "admin", "synthetics", "access-management")
  .map((s) => `/${s}`);

const arbSeverity: fc.Arbitrary<Severity> = fc.constantFrom(...SEVERITY_ORDER);

const arbEvidence: fc.Arbitrary<AnomalyEvidence> = fc.record({
  summary: fc.string({ maxLength: 20 }),
  httpStatus: fc.option(fc.integer({ min: 100, max: 599 }), { nil: null }),
  latencyMs: fc.option(fc.integer({ min: 0, max: 60000 }), { nil: null }),
  consoleErrors: fc.array(fc.string({ maxLength: 20 }), { maxLength: 2 }),
  failedRequests: fc.constant([]),
  domErrorStates: fc.constant([]),
  dataSignal: fc.constant(null),
  screenshotRef: fc.option(fc.constant("s3://explorer/s.png"), { nil: null }),
}) as fc.Arbitrary<AnomalyEvidence>;

/**
 * Triage_Result arbitrario. La clave de equivalencia depende solo de
 * route/role/category, así que esos tres se generan desde pools pequeños para
 * provocar solapamientos; el resto de campos varían libremente para verificar
 * que NO influyen en la clasificación.
 */
const arbTriageResult: fc.Arbitrary<TriageResult> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 16 }),
  route: arbRoutePath,
  role: arbAppRole,
  severity: arbSeverity,
  category: fc.constantFrom(...ANOMALY_CATEGORIES),
  probable_cause: fc.string({ maxLength: 20 }),
  suggested_fix: fc.string({ maxLength: 20 }),
  evidence: arbEvidence,
  status: fc.constantFrom(...TRIAGE_STATUSES),
}) as fc.Arbitrary<TriageResult>;

/** Conjunto de Triage_Results del run actual. */
const arbTriageSet: fc.Arbitrary<TriageResult[]> = fc.array(arbTriageResult, {
  maxLength: 12,
});

/** Baseline: una lista de Triage_Results o `null` (no hay run previo). */
const arbBaseline: fc.Arbitrary<TriageResult[] | null> = fc.option(
  fc.array(arbTriageResult, { maxLength: 12 }),
  { nil: null },
);

/* ------------------------------------------------------------------ */
/*  Property 23                                                         */
/* ------------------------------------------------------------------ */

test("Property 23: la detección de regresiones es determinista por Route+Role+categoría", () => {
  fc.assert(
    fc.property(arbTriageSet, arbBaseline, (current, previous) => {
      const report = detectRegressions(current, previous);

      // --- Determinismo: dos invocaciones idénticas → resultado idéntico. ---
      const report2 = detectRegressions(current, previous);
      assert.deepEqual(report2, report, "detectRegressions debe ser determinista");

      if (previous === null) {
        // --- Sin baseline comparable (Req 8.3). ---
        assert.equal(report.hasBaseline, false, "hasBaseline debe ser false sin baseline");
        assert.deepEqual(
          report.regressions,
          [],
          "sin baseline no se clasifica ninguna Regression",
        );
        return;
      }

      // --- Con baseline (Req 8.1, 8.2, 8.4). ---
      assert.equal(report.hasBaseline, true, "hasBaseline debe ser true con baseline");

      const baselineKeys = new Set(previous.map(key));

      // (a) Toda Regression devuelta tiene clave AUSENTE del baseline, y es uno
      //     de los Triage_Results del run actual (identidad por referencia).
      for (const reg of report.regressions) {
        assert.ok(
          !baselineKeys.has(key(reg)),
          `regresión ${key(reg)} no debe existir en el baseline`,
        );
        assert.ok(
          current.includes(reg),
          "cada regresión debe provenir del run actual",
        );
      }

      // (b) Caracterización IFF: para CADA Triage_Result actual, está en las
      //     regresiones si y solo si su clave no está en el baseline.
      for (const t of current) {
        const isNew = !baselineKeys.has(key(t));
        const isReported = report.regressions.includes(t);
        assert.equal(
          isReported,
          isNew,
          `Triage_Result con clave ${key(t)} debe clasificarse como regresión sii su clave no está en el baseline`,
        );
      }

      // (c) El orden y la cardinalidad coinciden con el filtrado del run actual
      //     (preserva el subconjunto exacto y su orden).
      const expected = current.filter((t) => !baselineKeys.has(key(t)));
      assert.deepEqual(
        report.regressions,
        expected,
        "regressions == subconjunto de current con clave ausente del baseline",
      );
    }),
    { numRuns: 100 },
  );
});
