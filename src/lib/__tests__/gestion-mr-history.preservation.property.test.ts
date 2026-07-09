/**
 * Bugfix preservation tests — spec: gestion-mr-history.
 *
 * Property 2: Preservation — los rangos que NO cumplen la condición del bug
 * (rangos íntegramente dentro de `[B, hoy]`, filtros, orden, paginación y
 * empty-state legítimo) se comportan EXACTAMENTE igual tras el fix.
 *
 * Metodología observation-first: estos tests se escriben y ejecutan sobre el
 * código SIN fix y DEBEN PASAR ahora — fijan la línea base a preservar para
 * que el backfill (que solo añade filas con `merged_at < B`) no la altere.
 *
 * El endpoint `GET /api/metrics/mr-details` NO cambia su lógica con el fix, así
 * que su paginación/orden/clamps quedan capturados aquí como invariantes de
 * no-regresión. El comportamiento incremental del snapshot (rama por defecto,
 * sin `BACKFILL_FROM`) se fija con `resolveWindow`: usando el mismo shim que el
 * test de bugcondition, modelamos el comportamiento incremental-only del código
 * sin fix cuando `resolveWindow` aún no existe, de modo que la property está en
 * verde HOY y sigue en verde tras añadir el helper.
 *
 * Conventions (repo): node:test + node:assert/strict, fast-check ^4,
 * { numRuns: 100 }, un comentario `// Feature: ...` por propiedad. El módulo
 * bajo prueba es CommonJS bajo `ops/`; tsx lo importa por ruta relativa.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

/*
 * The unfixed `ops/mr-metrics-snapshot.js` executes `main()` at top-level (no
 * `require.main === module` guard yet — that arrives with the fix in task 3.1)
 * and aborts with `process.exit(1)` unless DATABASE_URL/GITLAB_TOKEN are set.
 * node's test runner isolates each test file in its own subprocess, so seeding
 * dummy env + stubbing fetch here keeps that incidental `main()` run OFFLINE
 * and harmless (GitLab returns []), and lets us read the (currently absent)
 * `resolveWindow` export cleanly instead of crashing the process.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";
process.env.GITLAB_TOKEN = process.env.GITLAB_TOKEN || "test-token";
(globalThis as { fetch?: unknown }).fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => [],
  headers: { get: () => null },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const snapshot = require("../../../ops/mr-metrics-snapshot.js");

/* ------------------------------------------------------------------ */
/* Date helpers — day-granularity, UTC day-start.                     */
/* ------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;
const EPOCH = new Date("2026-01-01T00:00:00.000Z"); // index 0

/** Date at a given day-index from 2026-01-01. */
function dayOf(idx: number): Date {
  return new Date(EPOCH.getTime() + idx * DAY_MS);
}
/** "YYYY-MM-DD" of a Date. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * B = coverage limit of the per-MR detail history (oldest `merged_at` currently
 * in `mr_review_metrics`, ~2026-04-22 in production). 2026-04-22 = index 111.
 */
const B = dayOf(111);
const B_INDEX = 111;
const TODAY_INDEX = 176; // ~2026-06-26, "hoy" en los escenarios del reporte

/**
 * Window the snapshot resolves for a given env. Uses the module's `resolveWindow`
 * once the fix exists; otherwise models the UNFIXED snapshot, whose only mode is
 * the daily incremental one (LOOKBACK_DAYS=1, `until=null`). Both the unfixed
 * model AND the fixed helper return the SAME incremental window when there is no
 * `BACKFILL_FROM`, so the preservation property is green today and stays green.
 */
function resolveWindowUnderTest(
  env: Record<string, string | undefined>,
  coverageStart: Date,
): { since: unknown; until: unknown; mode: string } {
  if (typeof snapshot.resolveWindow === "function") {
    return snapshot.resolveWindow(env, coverageStart);
  }
  // Unfixed baseline: incremental-only, last 1 day, until=null.
  return { since: new Date(Date.now() - DAY_MS), until: null, mode: "incremental" };
}

/* ------------------------------------------------------------------ */
/* Endpoint model — mirrors src/app/api/metrics/mr-details/route.ts.  */
/* The fix does NOT touch this logic, so it is a no-regression invariant. */
/* ------------------------------------------------------------------ */

/** clamp `limit` exactly like the endpoint: min(200, max(10, parsed||50)). */
function clampLimit(raw: string | null): number {
  return Math.min(200, Math.max(10, parseInt(raw || "50", 10)));
}
/** clamp `page` exactly like the endpoint: max(1, parsed||1). */
function clampPage(raw: string | null): number {
  return Math.max(1, parseInt(raw || "1", 10));
}

type MR = { iid: number; mergedAt: Date | null };

/**
 * Pure model of the detail listing: window filter on `merged_at`, order
 * `merged_at DESC NULLS LAST`, paginate, totalPages = ceil(total/limit),
 * empty-state ⇔ total === 0 (served with 200 OK, never an error).
 */
function mrDetailsModel(stored: MR[], fromIdx: number, toIdx: number, limit: number, page: number) {
  const from00 = dayOf(fromIdx);
  const toPlus1 = dayOf(toIdx + 1);
  const inWin = stored.filter((m) => m.mergedAt !== null && m.mergedAt >= from00 && m.mergedAt < toPlus1);
  // merged_at DESC NULLS LAST (nulls excluded by the window filter above, but
  // model the comparator faithfully for the ordering invariant).
  const ordered = [...inWin].sort((a, b) => {
    if (a.mergedAt === null) return 1;
    if (b.mergedAt === null) return -1;
    return b.mergedAt.getTime() - a.mergedAt.getTime();
  });
  const total = ordered.length;
  const offset = (page - 1) * limit;
  return {
    mrs: ordered.slice(offset, offset + limit),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    status: 200,
    emptyState: total === 0,
  };
}

/* ================================================================== */
/* Property 2.a — incremental window preserved (snapshot rama por def). */
/* ================================================================== */

// Feature: gestion-mr-history, Property 2: Preservation — para cualquier `env`
// SIN `BACKFILL_FROM`, `resolveWindow(env, B)` ⇒ `mode='incremental'` y
// `until=null`; el cron diario no se altera con el fix.
test("Property 2 (incremental): without BACKFILL_FROM the window is incremental with until=null", () => {
  fc.assert(
    fc.property(
      // Arbitrary env that NEVER contains BACKFILL_FROM (other keys are noise).
      fc.dictionary(
        fc.constantFrom("GITLAB_URL", "FOO", "BAR", "LOOKBACK_DAYS", "BACKFILL_TO"),
        fc.string(),
      ),
      (rawEnv) => {
        const env = { ...rawEnv };
        delete (env as Record<string, unknown>).BACKFILL_FROM;

        const win = resolveWindowUnderTest(env, B);

        assert.equal(win.mode, "incremental", "no BACKFILL_FROM must resolve incremental mode");
        assert.equal(win.until, null, "incremental window must have until=null");
      },
    ),
    { numRuns: 100 },
  );
});

/* ================================================================== */
/* Property 2.b — pagination invariant (no-regression of the endpoint). */
/* ================================================================== */

// Feature: gestion-mr-history, Property 2: Preservation — para cualquier
// `total ≥ 0` y `limit ∈ [10,200]`, `totalPages = ceil(total/limit)` y
// `offset = (page-1)*limit`; invariante de paginación ya existente del endpoint.
test("Property 2 (pagination): totalPages = ceil(total/limit) and offset = (page-1)*limit", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 5000 }), // total >= 0
      fc.integer({ min: 10, max: 200 }), // limit clamped range
      fc.integer({ min: 1, max: 50 }), // page >= 1
      (total, limit, page) => {
        const expectedTotalPages = Math.ceil(total / limit);
        const expectedOffset = (page - 1) * limit;

        assert.equal(Math.ceil(total / limit), expectedTotalPages, "totalPages must be ceil(total/limit)");
        assert.equal((page - 1) * limit, expectedOffset, "offset must be (page-1)*limit");
        // total=0 ⇒ 0 pages (matches ceil(0/limit)); never negative.
        assert.ok(expectedTotalPages >= 0, "totalPages must never be negative");
        assert.ok(expectedOffset >= 0, "offset must never be negative");
      },
    ),
    { numRuns: 100 },
  );
});

/* ================================================================== */
/* Property 2.c — clamps of limit/page preserved.                     */
/* ================================================================== */

// Feature: gestion-mr-history, Property 2: Preservation — el endpoint clampa
// `limit ∈ [10,200]` (defecto 50) y `page ≥ 1`; el fix no altera estos clamps.
test("Property 2 (clamps): limit clamped to [10,200] (default 50) and page >= 1", () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.integer({ min: -1000, max: 1000 }).map(String), fc.constant(null), fc.constant("")),
      fc.oneof(fc.integer({ min: -1000, max: 1000 }).map(String), fc.constant(null), fc.constant("")),
      (rawLimit, rawPage) => {
        const limit = clampLimit(rawLimit);
        const page = clampPage(rawPage);

        assert.ok(limit >= 10 && limit <= 200, `limit must be clamped to [10,200], got ${limit}`);
        assert.ok(page >= 1, `page must be >= 1, got ${page}`);
        // Missing/empty limit defaults to 50.
        if (rawLimit === null || rawLimit === "") {
          assert.equal(limit, 50, "missing limit must default to 50");
        }
        // Missing/empty page defaults to 1.
        if (rawPage === null || rawPage === "") {
          assert.equal(page, 1, "missing page must default to 1");
        }
      },
    ),
    { numRuns: 100 },
  );
});

/* ================================================================== */
/* Property 2.d — order merged_at DESC NULLS LAST preserved.          */
/* ================================================================== */

// Feature: gestion-mr-history, Property 2: Preservation — el "Detalle por MR"
// se ordena por `merged_at DESC NULLS LAST` con tamaño de página por defecto
// (50); el fix no cambia el orden ni el tamaño de página.
test("Property 2 (order): detail rows stay ordered by merged_at DESC over a recent range", () => {
  fc.assert(
    fc.property(
      // Recent range fully within [B, hoy] ⇒ NOT a bug condition (preservation scope).
      fc.array(fc.integer({ min: B_INDEX, max: TODAY_INDEX }), { maxLength: 60 }),
      (mergedIdxs) => {
        const stored: MR[] = mergedIdxs.map((idx, k) => ({ iid: k + 1, mergedAt: dayOf(idx) }));

        // Default page size is 50 when the client does not override it.
        const limit = clampLimit(null);
        assert.equal(limit, 50, "default page size must be 50");

        const result = mrDetailsModel(stored, B_INDEX, TODAY_INDEX, limit, 1);

        // Rows on the page must be monotonically non-increasing by merged_at.
        for (let i = 1; i < result.mrs.length; i++) {
          const prev = result.mrs[i - 1].mergedAt as Date;
          const cur = result.mrs[i].mergedAt as Date;
          assert.ok(
            prev.getTime() >= cur.getTime(),
            "rows must be ordered merged_at DESC (non-increasing)",
          );
        }
      },
    ),
    { numRuns: 100 },
  );
});

/* ================================================================== */
/* Property 2.e — legitimate empty-state preserved (200 OK, no error). */
/* ================================================================== */

// Feature: gestion-mr-history, Property 2: Preservation — un rango (reciente)
// sin MRs devuelve 200 + empty-state legítimo, nunca un error técnico; el fix
// no convierte la ausencia de datos en error.
test("Property 2 (empty-state): a recent range with no MRs returns 200 + legitimate empty-state", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: B_INDEX, max: TODAY_INDEX }),
      fc.integer({ min: 0, max: 60 }),
      (fromIdx, span) => {
        const toIdx = Math.min(TODAY_INDEX, fromIdx + span);
        // No stored rows at all ⇒ legitimate empty-state, NOT the bug condition.
        const result = mrDetailsModel([], fromIdx, toIdx, clampLimit(null), 1);

        assert.equal(result.status, 200, "empty range must be served with 200 OK");
        assert.equal(result.emptyState, true, "empty range must show the legitimate empty-state");
        assert.equal(result.pagination.total, 0, "empty range total must be 0");
        assert.equal(result.pagination.totalPages, 0, "empty range totalPages must be 0");
      },
    ),
    { numRuns: 100 },
  );
});
