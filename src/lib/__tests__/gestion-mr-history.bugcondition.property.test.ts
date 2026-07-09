/**
 * Bugfix exploration tests — spec: gestion-mr-history.
 *
 * Property 1: Bug Condition — Los rangos históricos con MRs reales muestran y
 * paginan el detalle por MR.
 *
 * CRITICAL: este test DEBE FALLAR sobre el código actual (sin fix). El fallo
 * confirma el bug: `ops/mr-metrics-snapshot.js` solo corre en modo incremental
 * (`LOOKBACK_DAYS = 1`, `getMergedMRs` usa `updated_after=hoy-1d`) y NUNCA
 * rellena hacia atrás, así que `mr_review_metrics` no tiene filas con
 * `merged_at < B` aunque GitLab sí tuviera MRs mergeados en ese periodo.
 * Resultado: el "Detalle por MR" sale vacío/truncado para rangos históricos.
 *
 * Este mismo test validará el fix cuando pase: tras añadir el modo backfill
 * (`resolveWindow(env, coverageStart)` con `BACKFILL_FROM`) el snapshot cubre
 * `[from, min(to, B))` y el endpoint reporta el recuento real.
 *
 * Counterexample de referencia (design.md): rango 2026-01-01..2026-03-28 sobre
 * `basket-api` → empty-state con 200 OK pese a existir MRs mergeados reales.
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
/** Coerce a Date | "YYYY-MM-DD" | ISO string into a UTC day-start Date. */
function asDate(v: unknown): Date {
  if (v instanceof Date) return v;
  return new Date(`${String(v).slice(0, 10)}T00:00:00.000Z`);
}

/**
 * B = coverage limit of the per-MR detail history (oldest `merged_at` currently
 * in `mr_review_metrics`, ~2026-04-22 in production). 2026-04-22 = index 111.
 */
const B = dayOf(111);
const B_INDEX = 111;
const MAX_INDEX = 242; // ~2026-08-31, the simulated GitLab universe horizon
const FAR_FUTURE = dayOf(100000);

/**
 * Window the snapshot resolves for a given env. Uses the module's `resolveWindow`
 * once the fix exists; otherwise models the UNFIXED snapshot, which has no
 * backfill mode: it always resolves an incremental window of LOOKBACK_DAYS=1
 * ending "now" and ignores BACKFILL_FROM entirely (so historical coverage is
 * empty). This is the precise behaviour that makes the property fail today.
 */
function resolveWindowUnderTest(
  env: Record<string, string | undefined>,
  coverageStart: Date,
): { since: unknown; until: unknown; mode: string } {
  if (typeof snapshot.resolveWindow === "function") {
    return snapshot.resolveWindow(env, coverageStart);
  }
  // Unfixed baseline: incremental-only, last 1 day, BACKFILL_FROM ignored.
  return { since: new Date(Date.now() - DAY_MS), until: null, mode: "incremental" };
}

type MR = { iid: number; mergedAt: Date };

/** Dedupe MRs by iid (UNIQUE project_id, mr_iid in the table). */
function dedupeByIid(mrs: MR[]): MR[] {
  const seen = new Map<number, MR>();
  for (const m of mrs) if (!seen.has(m.iid)) seen.set(m.iid, m);
  return [...seen.values()];
}

/**
 * Model of GET /api/metrics/mr-details over a set of stored rows. Mirrors the
 * real endpoint: window `merged_at >= from::date AND merged_at < to::date + 1d`,
 * order `merged_at DESC`, paginate, totalPages = ceil(total/limit).
 */
function mrDetailsModel(stored: MR[], from: string, to: string, limit: number, page: number) {
  const from00 = asDate(from);
  const toPlus1 = new Date(asDate(to).getTime() + DAY_MS);
  const inWin = stored
    .filter((m) => m.mergedAt >= from00 && m.mergedAt < toPlus1)
    .sort((a, b) => b.mergedAt.getTime() - a.mergedAt.getTime());
  const total = inWin.length;
  const offset = (page - 1) * limit;
  return {
    mrs: inWin.slice(offset, offset + limit),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    emptyState: total === 0,
  };
}

/**
 * Produce the rows `mr_review_metrics` would hold after the (parametrized)
 * backfill, given the real GitLab universe. `preExisting` models today's DB
 * (daily incremental only ⇒ rows with merged_at >= B). The backfill window adds
 * rows in [since, until); the union (deduped by iid) is what the endpoint reads.
 */
function storedAfterBackfill(gitlabMRs: MR[], fromIso: string): MR[] {
  const preExisting = gitlabMRs.filter((m) => m.mergedAt >= B);
  const win = resolveWindowUnderTest({ BACKFILL_FROM: fromIso }, B);
  const since = asDate(win.since);
  const until = win.until == null ? FAR_FUTURE : asDate(win.until);
  const added = gitlabMRs.filter((m) => m.mergedAt >= since && m.mergedAt < until);
  return dedupeByIid([...preExisting, ...added]);
}

/* ================================================================== */
/* Test A — snapshot window planning ⇒ endpoint covers the range.     */
/* ================================================================== */

// Feature: gestion-mr-history, Property 1: Bug Condition — para todo rango
// histórico (X.from < B) con MRs reales, mrDetails'(X) lista las filas de
// [X.from, min(X.to,B)], total = recuento real, totalPages = ceil(total/limit),
// y NO empty-state cuando el recuento real > 0.
test("Property 1 (Test A): historical/crossing ranges with real MRs are listed and paged", () => {
  fc.assert(
    fc.property(
      fc.record({
        fromIdx: fc.integer({ min: 0, max: 110 }), // from < B (index 111)
        span: fc.integer({ min: 0, max: 131 }),
        crossing: fc.boolean(),
        mergedDeltas: fc.array(fc.integer({ min: 0, max: 131 }), { maxLength: 25 }),
        histDelta: fc.integer({ min: 0, max: 110 }),
        limit: fc.integer({ min: 10, max: 200 }),
      }),
      (g) => {
        const fromIdx = g.fromIdx;

        // Resolve the upper bound of the query range.
        let toIdx = Math.min(MAX_INDEX, fromIdx + g.span);
        if (g.crossing) {
          // Ensure the range actually crosses B (to >= B).
          if (toIdx < B_INDEX) toIdx = Math.min(MAX_INDEX, B_INDEX + (g.span % 60));
        } else {
          // Fully historical: clamp to < B.
          toIdx = Math.min(toIdx, B_INDEX - 1);
          if (toIdx < fromIdx) toIdx = fromIdx;
        }

        const from = isoDay(dayOf(fromIdx));
        const to = isoDay(dayOf(toIdx));

        // Build the real GitLab universe of merged MRs across [from, to].
        const mergedIdx = new Set<number>();
        for (const d of g.mergedDeltas) mergedIdx.add(Math.min(toIdx, fromIdx + d));
        // Guarantee >=1 MR in the historical sub-window [from, min(to, B)) so the
        // bug condition holds: isBugCondition(X) = X.from < B AND existed MRs there.
        const histTop = Math.min(toIdx, B_INDEX - 1); // >= fromIdx (fromIdx <= 110)
        mergedIdx.add(fromIdx + (g.histDelta % (histTop - fromIdx + 1)));

        const gitlabMRs: MR[] = [...mergedIdx].map((idx, k) => ({ iid: k + 1, mergedAt: dayOf(idx) }));

        // Precondition: this input is a genuine bug condition.
        const realCount = gitlabMRs.filter(
          (m) => m.mergedAt >= asDate(from) && m.mergedAt < new Date(asDate(to).getTime() + DAY_MS),
        ).length;
        fc.pre(realCount > 0);

        const stored = storedAfterBackfill(gitlabMRs, from);
        const result = mrDetailsModel(stored, from, to, g.limit, 1);

        // Expected Behavior (Property 1):
        assert.equal(
          result.pagination.total,
          realCount,
          `pagination.total must equal the real MR count of the range (from=${from} to=${to})`,
        );
        assert.equal(
          result.pagination.totalPages,
          Math.ceil(realCount / g.limit),
          "totalPages must be ceil(total/limit) over the real count",
        );
        assert.equal(
          result.emptyState,
          false,
          "must NOT show empty-state when real merged MRs exist in the range",
        );
      },
    ),
    { numRuns: 100 },
  );
});

/* ================================================================== */
/* Test B — backfill fetch plan covers every historical MR.           */
/* ================================================================== */

// Feature: gestion-mr-history, Property 1: Bug Condition — dado un conjunto de
// MRs con merged_at en [from, B), el plan de backfill del snapshot SHALL
// incluirlos todos (modo backfill, until <= B). Sin fix no hay backfill ⇒ FALLA.
test("Property 1 (Test B): backfill window captures all historical MRs in [from, B)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 110 }), // fromIdx < B
      fc.array(fc.integer({ min: 0, max: 110 }), { minLength: 1, maxLength: 20 }), // merged-day indices < B
      (fromIdx, rawIdxs) => {
        const from = isoDay(dayOf(fromIdx));

        // Historical MRs entirely inside [from, B): clamp to >= fromIdx, < B.
        const idxs = rawIdxs.map((i) => Math.max(i, fromIdx)).filter((i) => i <= B_INDEX - 1);
        if (idxs.length === 0) idxs.push(fromIdx);
        const mrs: MR[] = idxs.map((idx, k) => ({ iid: k + 1, mergedAt: dayOf(idx) }));

        const win = resolveWindowUnderTest({ BACKFILL_FROM: from }, B);

        // The snapshot must enter backfill mode and never reach past B.
        assert.equal(
          win.mode,
          "backfill",
          "snapshot must resolve a backfill window when BACKFILL_FROM is set",
        );
        assert.ok(
          asDate(win.until).getTime() <= B.getTime(),
          "backfill window must not invade the already-covered range (until <= B)",
        );

        // Every historical MR in [from, B) must be captured by the fetch plan.
        const since = asDate(win.since);
        const until = asDate(win.until);
        const captured = mrs.filter((m) => m.mergedAt >= since && m.mergedAt < until);
        assert.equal(
          captured.length,
          mrs.length,
          "backfill must capture every merged MR in [from, B)",
        );
      },
    ),
    { numRuns: 100 },
  );
});
