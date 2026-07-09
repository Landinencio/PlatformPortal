/**
 * Bugfix pure-logic tests — spec: gestion-mr-history.
 *
 * Properties 3 & 4 validate the pure window-selection helper `resolveWindow`
 * exported by `ops/mr-metrics-snapshot.js` (task 3.1). They give formal support
 * to the preservation guarantee: the daily incremental cron is NEVER altered
 * (Property 3), and the one-off backfill NEVER invades the already-covered range
 * `[B, hoy]` (Property 4, `until <= B`).
 *
 * Property 3: resolveWindow incremental — sin `BACKFILL_FROM`, para cualquier
 *   `env`, `resolveWindow(env, B)` ⇒ `mode='incremental'` y `until=null`.
 * Property 4: resolveWindow backfill until≤B — con cualquier `BACKFILL_FROM < B`
 *   (y `BACKFILL_TO` opcional), `resolveWindow(env, B).mode='backfill'` y
 *   `until <= B` (= B cuando `BACKFILL_TO` ausente; <= B cuando presente y < B).
 *
 * Conventions (repo): node:test + node:assert/strict, fast-check ^4,
 * { numRuns: 100 }, un comentario `// Feature: ...` por propiedad. El módulo
 * bajo prueba es CommonJS bajo `ops/`; tsx lo importa por ruta relativa.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

/*
 * `ops/mr-metrics-snapshot.js` guards its startup with `require.main === module`,
 * so importing it for tests never runs `main()`, opens a DB connection, or hits
 * the network. We still seed dummy env + stub global.fetch (matching the sibling
 * gestion-mr-history tests) as defence in depth so this file stays fully OFFLINE.
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
 * Consistent with the bugcondition/preservation sibling tests.
 */
const B = dayOf(111);
const B_INDEX = 111;

/* ================================================================== */
/* Property 3 — incremental window when BACKFILL_FROM is absent.      */
/* ================================================================== */

// Feature: gestion-mr-history, Property 3: resolveWindow incremental — para
// cualquier `env` SIN `BACKFILL_FROM`, `resolveWindow(env, B)` ⇒
// `mode='incremental'` y `until=null`. El cron diario nunca se altera.
test("Property 3 (incremental): without BACKFILL_FROM the window is incremental with until=null", () => {
  fc.assert(
    fc.property(
      // Arbitrary dictionary of unrelated env keys (BACKFILL_FROM never present).
      fc.dictionary(
        fc.constantFrom("GITLAB_URL", "GITLAB_TOKEN", "DATABASE_URL", "LOOKBACK_DAYS", "BACKFILL_TO", "FOO", "BAR"),
        fc.string(),
      ),
      (rawEnv) => {
        const env = { ...rawEnv };
        delete (env as Record<string, unknown>).BACKFILL_FROM;

        const win = snapshot.resolveWindow(env, B);

        assert.equal(win.mode, "incremental", "no BACKFILL_FROM must resolve incremental mode");
        assert.equal(win.until, null, "incremental window must have until=null");
      },
    ),
    { numRuns: 100 },
  );
});

/* ================================================================== */
/* Property 4 — backfill window never invades [B, hoy] (until <= B).  */
/* ================================================================== */

// Feature: gestion-mr-history, Property 4: resolveWindow backfill until≤B — con
// cualquier `BACKFILL_FROM` estrictamente anterior a B (y `BACKFILL_TO`
// opcional/ausente), `resolveWindow(env, B).mode='backfill'` y `until <= B`. El
// backfill nunca invade el rango ya cubierto → soporte formal de la preservación.
test("Property 4 (backfill until<=B): BACKFILL_FROM < B yields backfill mode and until <= B", () => {
  fc.assert(
    fc.property(
      // BACKFILL_FROM strictly before B (indices 0..110).
      fc.integer({ min: 0, max: B_INDEX - 1 }),
      // BACKFILL_TO: absent, or a day in [from, B] (kept <= B so it stays valid).
      fc.option(fc.integer({ min: 0, max: B_INDEX }), { nil: undefined }),
      (fromIdx, toIdx) => {
        const from = isoDay(dayOf(fromIdx));
        const env: Record<string, string | undefined> = { BACKFILL_FROM: from };
        if (toIdx !== undefined) {
          // Clamp BACKFILL_TO to [from, B] so it is a sensible upper bound < or = B.
          env.BACKFILL_TO = isoDay(dayOf(Math.max(fromIdx, Math.min(toIdx, B_INDEX))));
        }

        const win = snapshot.resolveWindow(env, B);

        // Backfill mode is activated by the presence of BACKFILL_FROM.
        assert.equal(win.mode, "backfill", "BACKFILL_FROM must activate backfill mode");

        // until <= B always: when BACKFILL_TO is absent, until = coverageStart = B;
        // when present (and clamped <= B), until <= B.
        assert.ok(
          asDate(win.until).getTime() <= B.getTime(),
          `backfill window must not invade the covered range (until <= B), got until=${String(win.until)}`,
        );

        // When BACKFILL_TO is absent the default until is exactly coverageStart (B).
        if (toIdx === undefined) {
          assert.equal(
            asDate(win.until).getTime(),
            B.getTime(),
            "absent BACKFILL_TO must default until to coverageStart (B)",
          );
        }

        // since must equal the requested BACKFILL_FROM start of the window.
        assert.equal(asDate(win.since).getTime(), dayOf(fromIdx).getTime(), "since must equal BACKFILL_FROM");
      },
    ),
    { numRuns: 100 },
  );
});
