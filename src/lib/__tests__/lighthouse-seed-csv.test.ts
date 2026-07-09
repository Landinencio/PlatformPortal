/**
 * Integration tests for the impure Lighthouse CSV ingester
 * (`ops/lighthouse-seed-csv.js`), exercised through its exported `runSeed(deps)`
 * orchestrator with **injected dependencies** — a fake in-memory DB and an
 * inline CSV reader — so no real PostgreSQL or filesystem is touched.
 *
 * Feature: lighthouse-url-expansion (task 3.2)
 *
 * The fake DB models the `(monitor_id, route)` unique constraint of
 * `lighthouse_targets` with a Map. Its `query` mock:
 *   - answers the monitors SELECT with the five brand rows, and
 *   - implements the UPSERT: when the SQL carries `ON CONFLICT` it overwrites
 *     the map entry (idempotent, never throws); otherwise a second insert of an
 *     existing key throws a simulated unique-violation (23505). Because
 *     `runSeed` always uses `ON CONFLICT`, re-running is safe — that is exactly
 *     what these tests prove.
 *
 * The module under test is plain CommonJS under `ops/`; tsx imports it by
 * relative path without a build step. The `npm test` glob
 * `src/lib/__tests__/*.test.ts` picks this file up automatically.
 *
 * Covers Requirements 8.4, 10.1, 10.2, 13.1, 13.2.
 */

import test from "node:test";
import assert from "node:assert/strict";

// CommonJS module imported by relative path (see design.md).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const seed = require("../../../ops/lighthouse-seed-csv.js");
const { runSeed } = seed;

/**
 * The five brand monitor rows as returned by
 * `SELECT id, url FROM synthetic_monitors WHERE id IN (1,2,3,4,5)`.
 * `runSeed` normalizes each `url` to its host (lowercased) internally.
 */
const MONITOR_ROWS: { id: number; url: string }[] = [
  { id: 1, url: "https://www.animalis.com" },
  { id: 2, url: "https://www.kiwoko.com" },
  { id: 3, url: "https://www.kiwoko.pt" },
  { id: 4, url: "https://www.tiendanimal.es" },
  { id: 5, url: "https://www.tiendanimal.pt" },
];

interface FakeRow {
  monitor_id: number;
  route: string;
  page_type: string;
  priority: number;
  source: string;
  enabled: boolean;
}

interface FakeDb {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  store: Map<string, FakeRow>;
  /** Deterministic, comparable snapshot of the table state. */
  snapshot: () => string;
}

/** `(monitor_id, route)` composite key, mirroring the unique constraint. */
function rowKey(monitorId: number, route: string): string {
  return `${monitorId}\u0000${route}`;
}

/**
 * Builds a fresh fake DB. The `query` mock handles the monitors SELECT and the
 * `lighthouse_targets` UPSERT with real ON CONFLICT semantics; any insert that
 * would violate the unique key WITHOUT an `ON CONFLICT` clause throws a
 * simulated Postgres unique-violation (so the test genuinely fails if the
 * ingester ever drops the idempotent upsert).
 */
function makeFakeDb(): FakeDb {
  const store = new Map<string, FakeRow>();

  const query = async (sql: string, params?: unknown[]) => {
    if (sql.includes("synthetic_monitors")) {
      return { rows: MONITOR_ROWS };
    }

    if (sql.includes("INSERT INTO lighthouse_targets")) {
      const [monitorId, route, pageType, priority] = (params || []) as [
        number,
        string,
        string,
        number
      ];
      const key = rowKey(monitorId, route);
      const hasOnConflict = /ON CONFLICT/i.test(sql);

      if (store.has(key) && !hasOnConflict) {
        const err: Error & { code?: string } = new Error(
          `duplicate key value violates unique constraint "lighthouse_targets_monitor_id_route_key"`
        );
        err.code = "23505";
        throw err;
      }

      // ON CONFLICT (monitor_id, route) DO UPDATE → overwrite the entry.
      store.set(key, {
        monitor_id: monitorId,
        route,
        page_type: pageType,
        priority,
        source: "csv",
        enabled: true,
      });
      return { rows: [] };
    }

    throw new Error(`unexpected SQL in fake db: ${sql}`);
  };

  const snapshot = () =>
    JSON.stringify(
      Array.from(store.values()).sort((a, b) =>
        a.monitor_id !== b.monitor_id
          ? a.monitor_id - b.monitor_id
          : a.route < b.route
          ? -1
          : a.route > b.route
          ? 1
          : 0
      )
    );

  return { query, store, snapshot };
}

/** Silent log sink so the summary output does not clutter the test report. */
const noopLog = () => {};

/* ------------------------------------------------------------------ */
/*  Req 10.1, 10.2, 8.4: idempotent upsert (re-run leaves same state)  */
/* ------------------------------------------------------------------ */

test("Req 10.1/10.2: re-running the ingest leaves identical DB state with no unique violation", async () => {
  const csv = [
    "url;type;n",
    "https://www.animalis.com/;home;5",
    "https://www.kiwoko.com/p/1;pdp;3",
    "https://www.kiwoko.com/p/1;pdp;3", // duplicate (monitor_id, route)
    "https://www.tiendanimal.es/categoria;plp;4",
  ].join("\n");

  const db = makeFakeDb();
  const deps = { readCsv: () => csv, query: db.query, log: noopLog };

  const first = await runSeed(deps);
  const afterFirst = db.snapshot();

  const second = await runSeed(deps);
  const afterSecond = db.snapshot();

  // Idempotence: the table state is byte-for-byte equivalent after both runs.
  assert.equal(afterFirst, afterSecond, "DB state must be identical after re-run");

  // The duplicate CSV row collapses to a single (monitor_id, route) target.
  assert.equal(db.store.size, 3, "duplicate route must not create a second row");
  assert.equal(first.targets, 3);
  assert.equal(second.targets, 3);

  // Req 10.2: no unique-key violation on either run.
  assert.equal(first.upsertErrors, 0, "first run must not raise upsert errors");
  assert.equal(second.upsertErrors, 0, "re-run must not raise a unique violation");
});

/* ------------------------------------------------------------------ */
/*  Req 13.1: summary of upserted rows per monitor_id                  */
/* ------------------------------------------------------------------ */

test("Req 13.1: summary reports upserted rows per monitor_id", async () => {
  const csv = [
    "url;type;n",
    "https://www.animalis.com/;home;5",
    "https://www.animalis.com/cat;plp;4",
    "https://www.kiwoko.com/;home;5",
    "https://www.kiwoko.pt/;home;5",
    "https://www.kiwoko.pt/blog/a;blog;2",
    "https://www.kiwoko.pt/blog/b;blog;2",
    "https://www.tiendanimal.es/x;pdp;3",
    "https://www.tiendanimal.pt/y;pdp;3",
  ].join("\n");

  const db = makeFakeDb();
  const result = await runSeed({ readCsv: () => csv, query: db.query, log: noopLog });

  assert.equal(result.monitors, 5);
  assert.deepEqual(
    result.upsertedByMonitor,
    { 1: 2, 2: 1, 3: 3, 4: 1, 5: 1 },
    "rows upserted per monitor_id must match the crafted CSV"
  );
  assert.equal(result.targets, 8);
  assert.equal(result.upsertErrors, 0);
  // Clean CSV: nothing discarded.
  assert.deepEqual(result.discardsByReason, {});
});

/* ------------------------------------------------------------------ */
/*  Req 13.2: discards broken down by reason                           */
/* ------------------------------------------------------------------ */

test("Req 13.2: summary breaks down discards by reason", async () => {
  const csv = [
    "url;type;n",
    "https://www.animalis.com/;home;5",
    "https://www.animalis.com/;home;5", // duplicate (monitor_id, route)
    "https://tiendas.tiendanimal.es/x;store locator;1", // cross_subdomain
    "ftp://www.kiwoko.com/x;plp;3", // invalid_format (bad scheme)
    "bad;line", // invalid_format (wrong field count, parse-level)
    "https://www.tiendanimal.es/z;wibble;3", // unrecognized_type (still ingested)
  ].join("\n");

  const db = makeFakeDb();
  const result = await runSeed({ readCsv: () => csv, query: db.query, log: noopLog });

  assert.deepEqual(
    result.discardsByReason,
    {
      // 1 wrong-field-count (parse) + 1 bad-scheme (ftp) = 2
      invalid_format: 2,
      cross_subdomain: 1,
      unrecognized_type: 1,
      duplicate: 1,
    },
    "discards must be counted per reason"
  );

  // The unrecognized-type row is still ingested (other), the home dedupes to 1.
  assert.equal(result.targets, 2);
  assert.equal(db.store.size, 2);
  assert.equal(result.parseErrors, 1);
});

/* ------------------------------------------------------------------ */
/*  Req 8.4 / DRY_RUN: no writes, but a populated summary              */
/* ------------------------------------------------------------------ */

test("DRY_RUN performs no writes but still returns a populated summary", async () => {
  const csv = [
    "url;type;n",
    "https://www.animalis.com/;home;5",
    "https://www.kiwoko.com/p;pdp;3",
  ].join("\n");

  const db = makeFakeDb();
  const result = await runSeed({
    readCsv: () => csv,
    query: db.query,
    dryRun: true,
    log: noopLog,
  });

  // No upserts hit the DB under DRY_RUN.
  assert.equal(db.store.size, 0, "DRY_RUN must not write any rows");
  assert.equal(result.dryRun, true);

  // The summary is still fully populated (what WOULD be upserted).
  assert.equal(result.targets, 2);
  assert.deepEqual(result.upsertedByMonitor, { 1: 1, 2: 1 });
  assert.equal(result.monitors, 5);
});
