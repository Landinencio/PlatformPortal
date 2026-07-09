// Feature: ai-portal-explorer, Property 20: Round-trip JSON del Triage_Result
/**
 * Property-based test for the Triage_Engine JSON round-trip.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/triage-engine.ts
 *
 * Property 20: Round-trip JSON del Triage_Result.
 *   Para TODO Triage_Result válido, deserializar su forma serializada a JSON
 *   produce un Triage_Result equivalente:
 *     deserializeTriageResult(serializeTriageResult(t)) deepEquals t
 *   Es decir, el round-trip serialize→deserialize es la identidad.
 *
 * **Validates: Requirements 6.7**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/triage-engine.prop20.property.test.ts
 */

// Polyfill de Web Streams globals (Node 16) ANTES de cargar el AWS SDK vía
// triage-engine. Los imports de ES se evalúan en orden, así que este va primero.
import "./web-streams-polyfill";

import test from "node:test";
import assert from "node:assert/strict";
// `deepEqual` no-estricto: igualdad estructural por valor que IGNORA el
// prototipo (en `node:assert/strict`, `deepEqual` es un alias de
// `deepStrictEqual` y sí compara prototipos). Lo necesitamos porque fast-check
// construye los objetos generados con prototipo nulo, mientras que `JSON.parse`
// devuelve objetos con `Object.prototype`.
import { deepEqual as looseDeepEqual } from "node:assert";
import * as fc from "fast-check";

import {
  serializeTriageResult,
  deserializeTriageResult,
} from "../triage-engine";
import { SEVERITY_ORDER } from "../types";
import type {
  AnomalyCategory,
  AnomalyEvidence,
  DataSignal,
  DomErrorState,
  FailedRequest,
  PaginationSignal,
  Severity,
  TimeSeriesSignal,
  TriageResult,
  TriageStatus,
} from "../types";
import { arbAppRole } from "./arbitraries";

/* ------------------------------------------------------------------ */
/*  Conjuntos de valores válidos (espejo de las uniones de types.ts)    */
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

const DOM_ERROR_KINDS: readonly DomErrorState["kind"][] = [
  "error-message",
  "blank-page",
  "empty-state",
  "render-exception",
] as const;

/* ------------------------------------------------------------------ */
/*  Arbitraries: AnomalyEvidence anidada (JSON-safe)                    */
/* ------------------------------------------------------------------ */
//
// Para que el round-trip JSON sea la identidad estricta evitamos valores que
// JSON no preserva: nada de `undefined` como valor de propiedad presente, ni
// `NaN`/`Infinity`/`-0` en los números (JSON.stringify los convierte). Por eso
// usamos enteros para los campos numéricos y añadimos las propiedades opcionales
// (`expectedAccess`/`observedAccess`) SOLO cuando están presentes (nunca como
// `undefined`), reproduciendo fielmente la forma de un Triage_Result real.

const arbFailedRequest: fc.Arbitrary<FailedRequest> = fc.record({
  url: fc.webUrl(),
  method: fc.constantFrom("GET", "HEAD"),
  status: fc.option(fc.integer({ min: 400, max: 599 }), { nil: null }),
});

const arbDomErrorState: fc.Arbitrary<DomErrorState> = fc.record({
  kind: fc.constantFrom(...DOM_ERROR_KINDS),
  detail: fc.string({ maxLength: 30 }),
});

const arbTimeSeriesSignal: fc.Arbitrary<TimeSeriesSignal> = fc.record({
  requestedStart: fc.constantFrom("2026-01-01", "2026-03-15", "2025-12-01"),
  requestedEnd: fc.constantFrom("2026-01-31", "2026-06-15", "2026-02-28"),
  firstDataPoint: fc.option(fc.constantFrom("2026-01-02", "2026-03-16"), { nil: null }),
  lastDataPoint: fc.option(fc.constantFrom("2026-01-30", "2026-06-10"), { nil: null }),
  pointCount: fc.integer({ min: 0, max: 365 }),
});

const arbPaginationSignal: fc.Arbitrary<PaginationSignal> = fc.record({
  pageIndex: fc.integer({ min: 0, max: 50 }),
  hasNextControl: fc.boolean(),
  pageItemSignature: fc.string({ maxLength: 16 }),
});

const arbDataSignal: fc.Arbitrary<DataSignal> = fc.record({
  isEmptyState: fc.boolean(),
  rowCount: fc.option(fc.integer({ min: 0, max: 10000 }), { nil: null }),
  timeSeries: fc.option(arbTimeSeriesSignal, { nil: null }),
  pagination: fc.option(arbPaginationSignal, { nil: null }),
  totals: fc.dictionary(
    fc.string({ minLength: 1, maxLength: 12 }),
    fc.integer({ min: -100000, max: 100000 }),
    { maxKeys: 4 },
  ),
});

/** Base de la evidencia sin las propiedades opcionales de acceso. */
const arbEvidenceBase = fc.record({
  summary: fc.string({ maxLength: 40 }),
  httpStatus: fc.option(fc.integer({ min: 100, max: 599 }), { nil: null }),
  latencyMs: fc.option(fc.integer({ min: 0, max: 60000 }), { nil: null }),
  consoleErrors: fc.array(fc.string({ maxLength: 30 }), { maxLength: 3 }),
  failedRequests: fc.array(arbFailedRequest, { maxLength: 3 }),
  domErrorStates: fc.array(arbDomErrorState, { maxLength: 2 }),
  dataSignal: fc.option(arbDataSignal, { nil: null }),
  screenshotRef: fc.option(fc.constant("s3://explorer/screenshot.png"), { nil: null }),
});

const arbAccess: fc.Arbitrary<"granted" | "denied"> = fc.constantFrom("granted", "denied");

/**
 * Evidencia completa: añade `expectedAccess`/`observedAccess` SOLO cuando se
 * generan presentes, para que la forma del objeto coincida exactamente tras el
 * round-trip (JSON elimina las claves cuyo valor es `undefined`).
 */
const arbEvidence: fc.Arbitrary<AnomalyEvidence> = arbEvidenceBase
  .chain((base) =>
    fc
      .tuple(
        fc.option(arbAccess, { nil: undefined }),
        fc.option(arbAccess, { nil: undefined }),
      )
      .map(([expected, observed]) => {
        const evidence: AnomalyEvidence = { ...base };
        if (expected !== undefined) evidence.expectedAccess = expected;
        if (observed !== undefined) evidence.observedAccess = observed;
        return evidence;
      }),
  );

/* ------------------------------------------------------------------ */
/*  Arbitrary: TriageResult (forma completa de types.ts)                */
/* ------------------------------------------------------------------ */

const arbTriageResult: fc.Arbitrary<TriageResult> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 24 }),
  route: arbRoutePath(),
  role: arbAppRole,
  severity: fc.constantFrom<Severity>(...SEVERITY_ORDER),
  category: fc.constantFrom(...ANOMALY_CATEGORIES),
  probable_cause: fc.string({ minLength: 1, maxLength: 80 }),
  suggested_fix: fc.string({ minLength: 1, maxLength: 80 }),
  evidence: arbEvidence,
  status: fc.constantFrom(...TRIAGE_STATUSES),
}) as fc.Arbitrary<TriageResult>;

function arbRoutePath(): fc.Arbitrary<string> {
  return fc
    .constantFrom(
      "metrics",
      "finops",
      "admin",
      "synthetics",
      "api/metrics/team-activity",
      "access-management",
      "",
    )
    .map((s) => `/${s}`);
}

/* ------------------------------------------------------------------ */
/*  Property 20: round-trip serialize → deserialize === identidad       */
/* ------------------------------------------------------------------ */

test("Property 20: deserializeTriageResult(serializeTriageResult(t)) reconstruye t", () => {
  fc.assert(
    fc.property(arbTriageResult, (t) => {
      const roundTripped = deserializeTriageResult(serializeTriageResult(t));
      // Igualdad estructural por valor (round-trip = identidad), ignorando el
      // prototipo (artefacto del generador, no de los datos serializados).
      looseDeepEqual(roundTripped, t);
      // Guarda estricta adicional: la serialización canónica es estable a través
      // del round-trip (no se pierde ni reordena ningún dato).
      assert.equal(serializeTriageResult(roundTripped), serializeTriageResult(t));
    }),
    { numRuns: 100 },
  );
});
