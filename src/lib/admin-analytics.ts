/**
 * Admin Analytics — shared utilities for the analytics dashboard.
 * Trend calculation, time range helpers, and TypeScript interfaces.
 */

// ─── Interfaces ──────────────────────────────────────────────────────

export interface TrendData {
  currentValue: number;
  previousValue: number;
  percentChange: number | null; // null when previous is 0
  isNew: boolean;
}

export interface AnalyticsResponse<T> {
  period: { days: number; from: string; to: string };
  data: T;
}

export interface AnalyticsQueryParams {
  days: number;
}

// ─── Constants ───────────────────────────────────────────────────────

export const VALID_TIME_RANGES = [7, 30, 90, 180, 365] as const;
export type TimeRange = (typeof VALID_TIME_RANGES)[number];

// ─── Functions ───────────────────────────────────────────────────────

/**
 * Calculate trend data comparing current period to previous equivalent period.
 * - When previousValue > 0: returns percentage change rounded to 1 decimal
 * - When previousValue = 0: returns null with isNew = true
 */
export function calculateTrend(currentValue: number, previousValue: number): TrendData {
  if (previousValue === 0) {
    return {
      currentValue,
      previousValue,
      percentChange: null,
      isNew: true,
    };
  }

  const percentChange = Math.round(((currentValue - previousValue) / previousValue) * 1000) / 10;

  return {
    currentValue,
    previousValue,
    percentChange,
    isNew: false,
  };
}

/**
 * Get date ranges for current and previous period.
 * Previous period is the same duration immediately before the current period.
 */
export function getDateRange(days: number): {
  from: Date;
  to: Date;
  previousFrom: Date;
  previousTo: Date;
} {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const previousTo = new Date(from.getTime());
  const previousFrom = new Date(previousTo.getTime() - days * 24 * 60 * 60 * 1000);

  return { from, to, previousFrom, previousTo };
}

/**
 * Validate the `days` query parameter.
 * Returns a valid number from VALID_TIME_RANGES or defaults to 30.
 */
export function validateDaysParam(days: unknown): number {
  const parsed = typeof days === "string" ? parseInt(days, 10) : typeof days === "number" ? days : NaN;
  if (isNaN(parsed) || !(VALID_TIME_RANGES as readonly number[]).includes(parsed)) {
    return 30;
  }
  return parsed;
}

/**
 * Build SQL interval string from days.
 */
export function daysToInterval(days: number): string {
  return `${days} days`;
}

/**
 * Helper to build trend queries using CTEs.
 * Returns a SQL fragment that computes current and previous period counts.
 */
export function buildTrendCTE(
  table: string,
  dateColumn: string,
  days: number,
  whereClause?: string,
): string {
  const where = whereClause ? `AND ${whereClause}` : "";
  return `
    (SELECT COUNT(*) as value FROM ${table}
     WHERE ${dateColumn} >= NOW() - INTERVAL '${days} days' ${where}) as current_val,
    (SELECT COUNT(*) as value FROM ${table}
     WHERE ${dateColumn} >= NOW() - INTERVAL '${days * 2} days'
       AND ${dateColumn} < NOW() - INTERVAL '${days} days' ${where}) as previous_val
  `;
}
