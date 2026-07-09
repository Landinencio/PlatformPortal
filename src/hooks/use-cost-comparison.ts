"use client";

/**
 * use-cost-comparison.ts
 *
 * Network orchestration hook for the FinOps cost comparison explorer (PARTE B).
 *
 * Given the dashboard's `selectedAccountIds` and the explorer's `selectedMonths`,
 * it fires one `/api/finops/cur-direct` request per month IN PARALLEL via
 * `Promise.allSettled`, using `monthRange` to derive each month's
 * `startDate`/`endDate` and propagating `accountIds`.
 *
 * Partial-failure isolation (Req 10.4): a single failed month never prevents the
 * others. Successful months land in `snapshotsByMonth`; failed (rejected or
 * non-ok) months land in `monthErrors` keyed by month.
 *
 * The hook exposes `loading` and a memoized `comparisonFor(level, drill)` bound
 * to the current `snapshotsByMonth` — a thin, stable wrapper over the pure
 * `buildComparison` from `finops-cost-comparison.ts` (which tolerates missing
 * months by zero-filling them).
 *
 * Reuses the existing CUR data path (Req 10.1) and its 10-minute cache (Req 10.2):
 * identical `{startDate, endDate, accountIds}` requests are served from cache by
 * the endpoint.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CurFullSnapshot } from "@/lib/athena-cur";
import {
  buildComparison,
  monthRange,
  sortMonths,
  type ComparisonLevel,
  type ComparisonResult,
  type MonthKey,
} from "@/lib/finops-cost-comparison";

interface UseCostComparisonResult {
  /** Successfully fetched snapshots, keyed by month. */
  snapshotsByMonth: Record<MonthKey, CurFullSnapshot>;
  /** Per-month error messages for months whose fetch failed (isolated). */
  monthErrors: Record<MonthKey, string>;
  /** True while any month's fetch is in flight. */
  loading: boolean;
  /**
   * Memoized comparison builder bound to the current `snapshotsByMonth`.
   * Recomputes (new function identity) only when the snapshots change, so
   * callers can safely use it as an effect/memo dependency.
   */
  comparisonFor: (level: ComparisonLevel, drill: { accountId?: string; service?: string }) => ComparisonResult;
}

/**
 * Builds a stable dependency key from a list of ids/months so the fetch effect
 * re-runs when (and only when) the actual set changes — independent of array
 * identity or ordering.
 */
function stableKey(values: string[]): string {
  return [...values].sort().join(",");
}

export function useCostComparison(
  selectedAccountIds: string[],
  selectedMonths: MonthKey[],
): UseCostComparisonResult {
  const [snapshotsByMonth, setSnapshotsByMonth] = useState<Record<MonthKey, CurFullSnapshot>>({});
  const [monthErrors, setMonthErrors] = useState<Record<MonthKey, string>>({});
  const [loading, setLoading] = useState(false);

  // Stable keys decouple the effect from array identity: re-fetch only when the
  // actual account set or month set changes (Req 4.4).
  const accountsKey = stableKey(selectedAccountIds);
  const monthsKey = stableKey(selectedMonths);

  useEffect(() => {
    const months = sortMonths(selectedMonths);

    // Nothing to compare: reset to empty state and skip fetching (the UI, task
    // 9.x, enforces the >=2 rule — the hook stays flexible and fetches whatever
    // months it is given, but an empty selection means no work).
    if (months.length === 0) {
      setSnapshotsByMonth({});
      setMonthErrors({});
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const fetchMonth = async (
      month: MonthKey,
    ): Promise<{ month: MonthKey; snapshot: CurFullSnapshot }> => {
      const { startDate, endDate } = monthRange(month);
      const params = new URLSearchParams({ startDate, endDate });
      // Propagate accountIds only when there are selected accounts (defensive;
      // the dashboard always passes them, but an empty set must not send an
      // empty/garbage param).
      if (selectedAccountIds.length > 0) {
        params.set("accountIds", selectedAccountIds.join(","));
      }

      const response = await fetch(`/api/finops/cur-direct?${params.toString()}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`cur-direct returned ${response.status} for ${month}`);
      }
      const snapshot = (await response.json()) as CurFullSnapshot;
      return { month, snapshot };
    };

    const run = async () => {
      // All months in parallel; allSettled isolates per-month failures (Req 10.4).
      const settled = await Promise.allSettled(months.map((month) => fetchMonth(month)));

      if (cancelled) {
        // A newer batch superseded this one — don't overwrite fresher state.
        return;
      }

      const nextSnapshots: Record<MonthKey, CurFullSnapshot> = {};
      const nextErrors: Record<MonthKey, string> = {};

      settled.forEach((outcome, index) => {
        const month = months[index];
        if (outcome.status === "fulfilled") {
          nextSnapshots[outcome.value.month] = outcome.value.snapshot;
        } else {
          const reason = outcome.reason;
          nextErrors[month] = reason instanceof Error ? reason.message : String(reason);
        }
      });

      setSnapshotsByMonth(nextSnapshots);
      setMonthErrors(nextErrors);
      setLoading(false);
    };

    void run();

    return () => {
      // Guard against race conditions / stale updates: an outdated batch that
      // resolves after the inputs changed must not clobber newer state.
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsKey, monthsKey]);

  const comparisonFor = useCallback(
    (level: ComparisonLevel, drill: { accountId?: string; service?: string }): ComparisonResult =>
      buildComparison(snapshotsByMonth, level, drill),
    [snapshotsByMonth],
  );

  return useMemo(
    () => ({ snapshotsByMonth, monthErrors, loading, comparisonFor }),
    [snapshotsByMonth, monthErrors, loading, comparisonFor],
  );
}
