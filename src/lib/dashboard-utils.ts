/**
 * Shared utility functions for dashboard modules.
 *
 * Extracted from metrics-dashboard.ts to reduce file size and improve testability.
 * These are pure functions with no DB or external dependencies.
 */

export function parseCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function nullableInt(value: unknown): number | null {
  const numeric = nullableNumber(value);
  return numeric === null ? null : Math.trunc(numeric);
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function blend(base: number, runtime: number, weight: number): number {
  const safeWeight = clamp(weight, 0, 1);
  return base * (1 - safeWeight) + runtime * safeWeight;
}

export function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function sumNumbers(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0);
}

export function sanitizeDeveloperEmail(value: string | null | undefined) {
  const raw = (value || "").trim().toLowerCase();
  if (!raw) return "unknown@unknown.local";
  if (raw.includes("@")) return raw;
  return `${raw}@unknown.local`;
}

export function resolveAuthorIdentitySeed(
  authorEmail: string | null | undefined,
  authorUsername: string | null | undefined
) {
  return sanitizeDeveloperEmail(authorEmail || authorUsername || null);
}

export function uniqueBy(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

export function localeCompare(left: string, right: string) {
  return left.localeCompare(right);
}

export type TrendMetric = {
  current: number;
  previous: number;
  change: number;
};

export function metric(current: number, previous: number): TrendMetric {
  const change = previous > 0 ? ((current - previous) / previous) * 100 : current > 0 ? 100 : 0;
  return { current, previous, change };
}
