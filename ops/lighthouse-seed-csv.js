#!/usr/bin/env node
/**
 * Lighthouse CSV seeder — impure I/O orchestrator for the Lighthouse URL
 * expansion feature.
 *
 * Reads the curated CSV (`web_core_vitals_urls.csv`), loads the brand monitors
 * from `synthetic_monitors`, runs the pure transformation pipeline from
 * `ops/lib/csv-ingest.js` (parseCsv → buildTargets) and upserts the resulting
 * targets into `lighthouse_targets` with `source='csv'`, `enabled=TRUE` and a
 * fresh `last_seen_at`. The upsert is idempotent (`ON CONFLICT (monitor_id,
 * route) DO UPDATE`) so the seeder can be re-run safely.
 *
 * This module separates the pure-ish core (`runSeed`) — which receives its
 * dependencies (a db query function and a file reader) injected — from the
 * real wiring (fs + pg) that lives in the `require.main === module` block.
 * That split lets the integration tests (task 3.2) exercise DRY_RUN and the
 * idempotent upsert with mocked dependencies, without a real DB or filesystem.
 *
 * Env vars:
 *   DATABASE_URL — PostgreSQL connection string (required; fail-fast if absent)
 *   CSV_PATH     — path to the curated CSV (optional, default
 *                  `web_core_vitals_urls.csv` at the project root)
 *   DRY_RUN=1    — run the whole pipeline + summary WITHOUT writing to the DB
 */

"use strict";

const { parseCsv, buildTargets } = require("./lib/csv-ingest");

/** Monitors whose curated URLs are ingested (1..5; monitor 6 = Comerzzia, excluded). */
const MONITOR_IDS = [1, 2, 3, 4, 5];

/** Default CSV location (project root). */
const DEFAULT_CSV_PATH = "web_core_vitals_urls.csv";

/** SQL that loads the brand monitors used to map hosts → monitor_id. */
const SELECT_MONITORS_SQL =
  "SELECT id, url FROM synthetic_monitors WHERE id IN (1,2,3,4,5)";

/** Idempotent upsert into lighthouse_targets (Req 8, 10). */
const UPSERT_SQL = `INSERT INTO lighthouse_targets
  (monitor_id, route, page_type, priority, source, enabled, last_seen_at)
VALUES ($1, $2, $3, $4, 'csv', TRUE, NOW())
ON CONFLICT (monitor_id, route) DO UPDATE SET
  page_type = EXCLUDED.page_type,
  priority  = EXCLUDED.priority,
  source    = 'csv',
  enabled   = TRUE,
  last_seen_at = NOW()`;

/** Human-readable labels for each discard reason (for the summary). */
const DISCARD_LABELS = {
  duplicate: "duplicada",
  cross_subdomain: "cross-subdominio",
  invalid_format: "formato inválido",
  unrecognized_type: "tipo no reconocido",
};

/**
 * Normalizes a `synthetic_monitors.url` into a `Monitor_Base_Host` for the pure
 * pipeline: `https://www.tiendanimal.es` → `www.tiendanimal.es`. Monitors whose
 * URL is malformed or hostless are skipped (they cannot map any CSV host).
 *
 * @param {{ id:number, url:string }[]} rows
 * @returns {{ id:number, host:string }[]}
 */
function normalizeMonitors(rows) {
  /** @type {{ id:number, host:string }[]} */
  const monitors = [];
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    if (!row || typeof row.url !== "string") {
      continue;
    }
    let host;
    try {
      host = new URL(row.url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (host === "") {
      continue;
    }
    monitors.push({ id: row.id, host });
  }
  return monitors;
}

/**
 * Aggregates a list of discards into a count per reason.
 *
 * @param {{ reason:string, detail:string }[]} discards
 * @returns {Record<string, number>}
 */
function summarizeDiscards(discards) {
  /** @type {Record<string, number>} */
  const byReason = {};
  for (const d of Array.isArray(discards) ? discards : []) {
    byReason[d.reason] = (byReason[d.reason] || 0) + 1;
  }
  return byReason;
}

/**
 * Core orchestrator with **injected dependencies** (testable without a real DB
 * or filesystem).
 *
 * @param {Object} deps
 * @param {() => string} deps.readCsv         - returns the raw CSV text (throws if unreadable).
 * @param {(sql:string, params?:any[]) => Promise<{ rows:any[] }>} deps.query
 *        - executes a SQL statement (pg-style); only used when `dryRun` is false
 *          for the upserts, always used to load monitors.
 * @param {boolean} [deps.dryRun=false]       - if true, skip all writes.
 * @param {(msg:string) => void} [deps.log]   - log sink (default console.log).
 * @returns {Promise<{
 *   dryRun:boolean,
 *   monitors:number,
 *   parseErrors:number,
 *   targets:number,
 *   upsertedByMonitor:Record<number, number>,
 *   upsertErrors:number,
 *   discardsByReason:Record<string, number>,
 * }>}
 */
async function runSeed(deps) {
  const { readCsv, query } = deps;
  const dryRun = Boolean(deps.dryRun);
  const log = typeof deps.log === "function" ? deps.log : console.log;

  // 1. Read the CSV (fail-fast handled by the caller / wiring; readCsv throws).
  const csvText = readCsv();

  // 2. Load monitors and normalize their base host.
  const { rows: monitorRows } = await query(SELECT_MONITORS_SQL);
  const monitors = normalizeMonitors(monitorRows);

  // 3. Pure pipeline: parse → build targets + discards.
  const { records, errors: parseErrors } = parseCsv(csvText);
  const { targets, discards } = buildTargets(records, monitors);

  // 4. Upsert each target (idempotent). A per-row error is logged and does NOT
  //    abort the rest (Req 8.4, 10.2). Skipped entirely under DRY_RUN.
  /** @type {Record<number, number>} */
  const upsertedByMonitor = {};
  let upsertErrors = 0;

  if (!dryRun) {
    for (const t of targets) {
      try {
        await query(UPSERT_SQL, [t.monitorId, t.route, t.pageType, t.priority]);
        upsertedByMonitor[t.monitorId] =
          (upsertedByMonitor[t.monitorId] || 0) + 1;
      } catch (err) {
        upsertErrors++;
        const detail = err && err.message ? err.message.slice(0, 120) : String(err);
        log(`  ! upsert failed for monitor_id=${t.monitorId} route="${t.route}": ${detail}`);
      }
    }
  } else {
    // Under DRY_RUN, report what WOULD be upserted per monitor.
    for (const t of targets) {
      upsertedByMonitor[t.monitorId] = (upsertedByMonitor[t.monitorId] || 0) + 1;
    }
  }

  // 5. Build discard summary by reason. Parse-level errors are also
  //    `invalid_format` discards (Req 13.2).
  const discardsByReason = summarizeDiscards([...parseErrors, ...discards]);

  const result = {
    dryRun,
    monitors: monitors.length,
    parseErrors: parseErrors.length,
    targets: targets.length,
    upsertedByMonitor,
    upsertErrors,
    discardsByReason,
  };

  emitSummary(result, log);
  return result;
}

/**
 * Emits the final human-readable summary: rows upserted per monitor_id and
 * discards grouped by reason (Req 13.1, 13.2).
 *
 * @param {{
 *   dryRun:boolean, monitors:number, targets:number, upsertErrors:number,
 *   upsertedByMonitor:Record<number, number>, discardsByReason:Record<string, number>,
 * }} result
 * @param {(msg:string) => void} log
 */
function emitSummary(result, log) {
  log("");
  log("=".repeat(60));
  log(`Lighthouse CSV seed summary${result.dryRun ? " (DRY_RUN — no writes)" : ""}`);
  log("=".repeat(60));
  log(`Monitors loaded: ${result.monitors}`);
  log(`Targets built:   ${result.targets}`);

  log(`${result.dryRun ? "Would upsert" : "Upserted"} per monitor_id:`);
  const monitorIds = Object.keys(result.upsertedByMonitor)
    .map(Number)
    .sort((a, b) => a - b);
  if (monitorIds.length === 0) {
    log("  (none)");
  } else {
    for (const id of monitorIds) {
      log(`  monitor_id=${id}: ${result.upsertedByMonitor[id]}`);
    }
  }

  if (!result.dryRun && result.upsertErrors > 0) {
    log(`Upsert errors: ${result.upsertErrors}`);
  }

  log("Discards by reason:");
  const reasons = Object.keys(result.discardsByReason);
  if (reasons.length === 0) {
    log("  (none)");
  } else {
    for (const reason of reasons) {
      const label = DISCARD_LABELS[reason] || reason;
      log(`  ${label}: ${result.discardsByReason[reason]}`);
    }
  }
  log("=".repeat(60));
}

// ──────────────────────────────────────────────────────────────────────────
// Real wiring (fs + pg). Guarded behind require.main so importing the module
// (tests, DRY_RUN with injected deps) never opens a DB connection.
// ──────────────────────────────────────────────────────────────────────────

async function main() {
  const fs = require("fs");
  const { Pool } = require("pg");

  const DATABASE_URL = process.env.DATABASE_URL;
  const csvPath = process.env.CSV_PATH || DEFAULT_CSV_PATH;
  const dryRun = process.env.DRY_RUN === "1";

  // Fail-fast: DATABASE_URL is required.
  if (!DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  // Fail-fast: the CSV must be readable (precondition, not a per-row discard).
  let readCsv;
  try {
    const csvText = fs.readFileSync(csvPath, "utf-8");
    readCsv = () => csvText;
  } catch (err) {
    console.error(`Cannot read CSV at "${csvPath}": ${err.message}`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  const query = (sql, params) => pool.query(sql, params);

  try {
    await runSeed({ readCsv, query, dryRun, log: console.log });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = {
  MONITOR_IDS,
  DEFAULT_CSV_PATH,
  SELECT_MONITORS_SQL,
  UPSERT_SQL,
  DISCARD_LABELS,
  normalizeMonitors,
  summarizeDiscards,
  runSeed,
  emitSummary,
};
