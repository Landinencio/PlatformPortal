/**
 * finops-cost-comparison.ts
 *
 * Pure, dependency-free core for the FinOps cost comparison explorer (PARTE B).
 * No React, no network: takes `CurFullSnapshot`s (one per month) and turns them
 * into hierarchical, month-over-month comparison rows.
 *
 * This file holds the type definitions plus the entity-extraction helpers
 * (`monthRange`, `sortMonths`, `extractEntities`). The comparative core
 * (`buildComparisonRows`, `computeDelta`, `buildProgression`, `buildComparison`)
 * is added by task 2.2.
 */

import type { CurFullSnapshot } from "./athena-cur";
import { formatAwsServiceName, truncateMiddle } from "./finops-format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Calendar month identifier in `"YYYY-MM"` form (e.g. `"2026-06"`). */
export type MonthKey = string;

/** Hierarchical drill-down level of the explorer. */
export type ComparisonLevel = "account" | "service" | "resource";

/** Direction of a cost variation between the oldest and newest compared month. */
export type Trend = "up" | "down" | "flat";

/** A single entity (account, service or resource) with its cost for one month. */
export interface EntityCost {
  key: string;
  label: string;
  cost: number;
}

/** A comparison row: one entity across all compared months, with deltas. */
export interface ComparisonRow {
  key: string;
  label: string;
  /** Always one entry per compared month; absent months are filled with 0. */
  byMonth: Record<MonthKey, number>;
  /** Newest month minus oldest month. */
  deltaAbs: number;
  /** `null` when the oldest (base) month is 0; otherwise a percentage. */
  deltaPct: number | null;
  trend: Trend;
}

/** Full result of a comparison at a given level and drill-down path. */
export interface ComparisonResult {
  level: ComparisonLevel;
  /** Compared months in ascending chronological order. */
  months: MonthKey[];
  rows: ComparisonRow[];
  drill: { accountId?: string; service?: string };
}

// ---------------------------------------------------------------------------
// Month helpers
// ---------------------------------------------------------------------------

const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Returns the natural calendar boundaries of a month as `YYYY-MM-DD` strings,
 * ready to feed `cur-direct` as `startDate` / `endDate`.
 *
 * `startDate` is the first day of the month, `endDate` is the last day of the
 * month (inclusive). Correctly handles 30/31-day months, February and leap
 * years (29 Feb on leap years, 28 otherwise).
 */
export function monthRange(month: MonthKey): { startDate: string; endDate: string } {
  const match = MONTH_KEY_RE.exec(month);
  if (!match) {
    throw new Error(`Invalid month key "${month}", expected "YYYY-MM"`);
  }
  const year = Number(match[1]);
  const monthNum = Number(match[2]); // 1-12
  if (monthNum < 1 || monthNum > 12) {
    throw new Error(`Invalid month "${month}", month must be 01-12`);
  }

  // Day 0 of the next month (1-indexed monthNum) is the last day of this month.
  const lastDay = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();

  return {
    startDate: `${match[1]}-${match[2]}-01`,
    endDate: `${match[1]}-${match[2]}-${pad2(lastDay)}`,
  };
}

/**
 * Returns a new array with the months sorted in ascending chronological order.
 * Does not mutate the input. Because `"YYYY-MM"` keys are fixed-width and
 * zero-padded, chronological order matches lexicographic order.
 */
export function sortMonths(months: MonthKey[]): MonthKey[] {
  return [...months].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the list of entities for a given level out of a single-month
 * snapshot, optionally scoped by a drill-down path:
 *
 * - `account`  → from `byAccount[]` (key = accountId, label = accountName).
 * - `service`  → from `byAccount[accountId].services[]` for `drill.accountId`
 *                (key = service code, label = `formatAwsServiceName`).
 * - `resource` → from `topResources[]` filtered by `drill.accountId` +
 *                `drill.service` (key = resourceId, label = shortened id).
 *
 * Returns `[]` when the required drill context is missing or no rows match.
 */
export function extractEntities(
  snapshot: CurFullSnapshot,
  level: ComparisonLevel,
  drill: { accountId?: string; service?: string },
): EntityCost[] {
  switch (level) {
    case "account":
      return (snapshot.byAccount ?? []).map((a) => ({
        key: a.accountId,
        label: a.accountName || a.accountId,
        cost: a.cost,
      }));

    case "service": {
      if (!drill.accountId) return [];
      const account = (snapshot.byAccount ?? []).find((a) => a.accountId === drill.accountId);
      if (!account) return [];
      return account.services.map((s) => ({
        key: s.service,
        label: formatAwsServiceName(s.service),
        cost: s.cost,
      }));
    }

    case "resource": {
      if (!drill.accountId || !drill.service) return [];
      return (snapshot.topResources ?? [])
        .filter((r) => r.accountId === drill.accountId && r.service === drill.service)
        .map((r) => ({
          key: r.resourceId,
          label: truncateMiddle(r.resourceId),
          cost: r.cost,
        }));
    }

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Comparative core
// ---------------------------------------------------------------------------

/** 2-decimal money rounding, matching `athena-cur.ts` `roundMoney`. */
function roundMoney(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Computes the variation between the oldest and newest compared month.
 *
 * - `deltaAbs = byMonth[months[last]] - byMonth[months[0]]` (missing months
 *   count as 0).
 * - `deltaPct = base === 0 ? null : (deltaAbs / base) * 100`, where
 *   `base = byMonth[months[0]]`. Never returns `Infinity`/`NaN`.
 * - `trend = deltaAbs > 0 ? "up" : deltaAbs < 0 ? "down" : "flat"`.
 *
 * `months` may be supplied in any order; it is sorted chronologically here so
 * "oldest" and "newest" are well defined regardless of caller ordering.
 */
export function computeDelta(
  byMonth: Record<MonthKey, number>,
  months: MonthKey[],
): { deltaAbs: number; deltaPct: number | null; trend: Trend } {
  const sorted = sortMonths(months);
  if (sorted.length === 0) {
    return { deltaAbs: 0, deltaPct: null, trend: "flat" };
  }

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const base = byMonth[first] ?? 0;
  const latest = byMonth[last] ?? 0;

  const deltaAbs = latest - base;
  const deltaPct = base === 0 ? null : (deltaAbs / base) * 100;
  const trend: Trend = deltaAbs > 0 ? "up" : deltaAbs < 0 ? "down" : "flat";

  return { deltaAbs, deltaPct, trend };
}

/**
 * Combines per-month entity lists into comparison rows.
 *
 * Invariants guaranteed:
 * - Every row's `byMonth` has EXACTLY one entry per month in `months`; an
 *   entity absent in a given month is zero-filled (`0`). This covers both
 *   additions (present only in newer months) and removals (present only in
 *   older months).
 * - Entities sharing the same `key` within a month are aggregated by summing
 *   their cost; a representative (first non-empty) label is kept.
 * - Rows are returned ordered by descending `|deltaAbs|`.
 */
export function buildComparisonRows(
  perMonth: Record<MonthKey, EntityCost[]>,
  months: MonthKey[],
): ComparisonRow[] {
  const sortedMonths = sortMonths(months);

  const labels = new Map<string, string>();
  const sums = new Map<string, Map<MonthKey, number>>();

  for (const month of sortedMonths) {
    const entities = perMonth[month] ?? [];
    for (const entity of entities) {
      // Keep the first representative label, preferring a non-empty one.
      const existingLabel = labels.get(entity.key);
      if (existingLabel === undefined) {
        labels.set(entity.key, entity.label || entity.key);
      } else if (!existingLabel && entity.label) {
        labels.set(entity.key, entity.label);
      }

      let monthMap = sums.get(entity.key);
      if (!monthMap) {
        monthMap = new Map<MonthKey, number>();
        sums.set(entity.key, monthMap);
      }
      monthMap.set(month, (monthMap.get(month) ?? 0) + entity.cost);
    }
  }

  const rows: ComparisonRow[] = [];
  for (const [key, monthMap] of sums.entries()) {
    const byMonth: Record<MonthKey, number> = {};
    for (const month of sortedMonths) {
      // Zero-fill: every month gets an entry; absent => 0.
      byMonth[month] = roundMoney(monthMap.get(month) ?? 0);
    }
    const { deltaAbs, deltaPct, trend } = computeDelta(byMonth, sortedMonths);
    rows.push({
      key,
      label: labels.get(key) ?? key,
      byMonth,
      deltaAbs,
      deltaPct,
      trend,
    });
  }

  // Descending order by magnitude of absolute variation.
  rows.sort((a, b) => Math.abs(b.deltaAbs) - Math.abs(a.deltaAbs));

  return rows;
}

/**
 * Returns a row's amounts in ascending chronological order, one value per
 * month in `months` (zero-filled for any month the row lacks). Suitable for
 * feeding a multi-month progression chart.
 */
export function buildProgression(row: ComparisonRow, months: MonthKey[]): number[] {
  return sortMonths(months).map((month) => row.byMonth[month] ?? 0);
}

/**
 * Pure orchestrator: turns a map of per-month snapshots into a
 * `ComparisonResult` at the requested level and drill-down path.
 *
 * Steps:
 * 1. Derive the chronologically-sorted month list from the snapshot keys.
 * 2. Extract entities per month via `extractEntities` (a month whose snapshot
 *    is missing/undefined contributes no entities — its values zero-fill,
 *    supporting partial-failure isolation: failed months simply contribute 0).
 * 3. Combine them into comparison rows with `buildComparisonRows`.
 *
 * No network, no React — safe to call from tests and from the explorer hook.
 */
export function buildComparison(
  snapshotsByMonth: Record<MonthKey, CurFullSnapshot>,
  level: ComparisonLevel,
  drill: { accountId?: string; service?: string },
): ComparisonResult {
  const months = sortMonths(Object.keys(snapshotsByMonth));

  const perMonth: Record<MonthKey, EntityCost[]> = {};
  for (const month of months) {
    const snapshot = snapshotsByMonth[month];
    perMonth[month] = snapshot ? extractEntities(snapshot, level, drill) : [];
  }

  const rows = buildComparisonRows(perMonth, months);

  return { level, months, rows, drill };
}
