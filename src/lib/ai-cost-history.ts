/**
 * AI cost history (Kiro licenses + Bedrock inference).
 *
 * Reads the daily AI-cost series straight from the CUR via Athena (same model as
 * the rest of the Costs tab), so there is NO snapshot table and NO backfill: the
 * full history is available on demand for whatever date range / account subset the
 * dashboard requests.
 *
 * Data source: fetchAiCostSeries(startDate, endDate, accountIds) from athena-cur.ts
 * (one query, grouped by day + account + source). Account names are resolved via
 * aws-account-catalog.ts so the UI shows friendly names instead of ids.
 *
 * The cost-shaping helpers (buildDaysFromSeries, detectAiCostAnomalies) are pure
 * (no I/O) so they can be unit/property tested in isolation.
 */

import { fetchAiCostSeries, type AiCostSeriesRow } from "@/lib/athena-cur";
import { fetchAwsAccountCatalog, buildAwsAccountNameMap } from "@/lib/aws-account-catalog";
import { cached, cacheKey } from "@/lib/cache";

/** Cache TTL for the AI cost history (Athena is the expensive part). */
const AI_COST_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

export interface AiCostByAccount {
  accountId: string;
  accountName: string;
  kiroCost: number;
  bedrockCost: number;
  totalCost: number;
}

export interface AiCostDay {
  date: string; // YYYY-MM-DD
  kiroCost: number;
  bedrockCost: number;
  totalAiCost: number;
  byAccount: AiCostByAccount[];
}

export interface AiCostHistory {
  days: AiCostDay[];
  anomalyDays: string[]; // dates whose totalAiCost exceeds mean + k*stddev
  totals: { kiro: number; bedrock: number; total: number };
}

/* ------------------------------------------------------------------ */
/*  Pure helpers (no I/O) — tested in isolation                        */
/* ------------------------------------------------------------------ */

/** Round a monetary amount to 2 decimals, tolerating float artifacts. */
function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Folds a flat CUR series (day, account, source, cost) into the per-day AiCostDay
 * shape with a friendly per-account breakdown and rounded totals. Pure.
 *
 * Rounding strategy (so totals stay consistent): round each per-account component
 * FIRST, then derive day/period aggregates by summing the rounded components.
 */
export function buildDaysFromSeries(
  series: AiCostSeriesRow[],
  accountNameMap: Record<string, string> = {},
): AiCostDay[] {
  // day -> accountId -> { kiro, bedrock }
  const byDay = new Map<string, Map<string, { kiro: number; bedrock: number }>>();

  for (const row of series) {
    if (!row.date) continue;
    let accounts = byDay.get(row.date);
    if (!accounts) {
      accounts = new Map();
      byDay.set(row.date, accounts);
    }
    let entry = accounts.get(row.accountId);
    if (!entry) {
      entry = { kiro: 0, bedrock: 0 };
      accounts.set(row.accountId, entry);
    }
    if (row.source === "kiro") entry.kiro += Number(row.cost) || 0;
    else entry.bedrock += Number(row.cost) || 0;
  }

  const days: AiCostDay[] = [];
  for (const [date, accounts] of byDay) {
    let kiroTotal = 0;
    let bedrockTotal = 0;
    const byAccount: AiCostByAccount[] = [];

    for (const [accountId, c] of accounts) {
      const kiroCost = round2(c.kiro);
      const bedrockCost = round2(c.bedrock);
      const totalCost = round2(kiroCost + bedrockCost);
      // Drop accounts that net to zero (e.g. Kiro credits cancelling charges).
      if (kiroCost === 0 && bedrockCost === 0) continue;
      kiroTotal += kiroCost;
      bedrockTotal += bedrockCost;
      byAccount.push({
        accountId,
        accountName: accountNameMap[accountId] || accountId,
        kiroCost,
        bedrockCost,
        totalCost,
      });
    }

    byAccount.sort((a, b) => b.totalCost - a.totalCost);

    const kiroCost = round2(kiroTotal);
    const bedrockCost = round2(bedrockTotal);
    days.push({
      date,
      kiroCost,
      bedrockCost,
      totalAiCost: round2(kiroCost + bedrockCost),
      byAccount,
    });
  }

  days.sort((a, b) => a.date.localeCompare(b.date));
  return days;
}

/**
 * Detects anomalous days over a window. A day is anomalous iff its totalAiCost
 * exceeds BOTH mean + 2*stddev AND 1.5 * mean over the window. With <= 1 day of
 * data there is no statistical base, so it returns [].
 */
export function detectAiCostAnomalies(days: AiCostDay[]): string[] {
  if (!Array.isArray(days) || days.length <= 1) return [];

  const totals = days.map((d) => (Number.isFinite(d.totalAiCost) ? d.totalAiCost : 0));
  const n = totals.length;
  const mean = totals.reduce((s, v) => s + v, 0) / n;
  const variance = totals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n;
  const stddev = Math.sqrt(variance);

  const upperThreshold = mean + 2 * stddev;
  const relativeThreshold = 1.5 * mean;

  const anomalies: string[] = [];
  for (const day of days) {
    const total = Number.isFinite(day.totalAiCost) ? day.totalAiCost : 0;
    if (total > upperThreshold && total > relativeThreshold) {
      anomalies.push(day.date);
    }
  }
  return anomalies;
}

/* ------------------------------------------------------------------ */
/*  Read (CUR-direct, cached)                                          */
/* ------------------------------------------------------------------ */

/**
 * Reads the AI cost history for [startDate, endDate] straight from the CUR,
 * optionally restricted to a subset of accounts (the dashboard's CUR selection).
 * Cached 10 min per (range, accounts). Computes anomalyDays over the window
 * (empty with <= 1 day).
 */
export async function getAiCostHistory(
  startDate: string,
  endDate: string,
  accountIds?: string[],
): Promise<AiCostHistory> {
  const key = cacheKey("ai-cost", {
    startDate,
    endDate,
    accounts: accountIds && accountIds.length > 0 ? [...accountIds].sort().join(",") : "all",
  });

  return cached(key, async () => {
    const [series, catalog] = await Promise.all([
      fetchAiCostSeries(startDate, endDate, accountIds),
      fetchAwsAccountCatalog().catch(() => []),
    ]);

    const accountNameMap = buildAwsAccountNameMap(catalog);
    const days = buildDaysFromSeries(series, accountNameMap);

    const totals = days.reduce(
      (acc, d) => {
        acc.kiro += d.kiroCost;
        acc.bedrock += d.bedrockCost;
        acc.total += d.totalAiCost;
        return acc;
      },
      { kiro: 0, bedrock: 0, total: 0 },
    );

    return {
      days,
      anomalyDays: detectAiCostAnomalies(days),
      totals: {
        kiro: round2(totals.kiro),
        bedrock: round2(totals.bedrock),
        total: round2(totals.total),
      },
    };
  }, AI_COST_CACHE_TTL_MS);
}
