/**
 * Shared formatting utilities for dashboard components.
 * Extracted from engineering-dashboard.tsx for reuse across components.
 */

import { format } from "date-fns";

export function formatDuration(hours: number) {
  if (!Number.isFinite(hours) || hours <= 0) return "0h";
  if (hours >= 24) {
    const days = hours / 24;
    return `${days >= 10 ? days.toFixed(1) : days.toFixed(2)}d`;
  }
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours * 60)}m`;
}

export function formatDisplayDate(value: string) {
  return format(new Date(value), "dd MMM yyyy");
}

export function formatTimestamp(value: string) {
  return format(new Date(value), "dd MMM yyyy HH:mm");
}

export function shortSha(value: string) {
  return value.slice(0, 8);
}

export function formatAxisCount(value: number) {
  return Number.isFinite(value) ? String(Math.round(value)) : "0";
}

export function formatAxisPercent(value: number) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : "0%";
}

export function formatAxisDurationTick(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0h";
  if (value >= 24) {
    const days = value / 24;
    return `${days >= 10 ? Math.round(days) : days.toFixed(1)}d`;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}h`;
}

export function signed(value: number, suffix = "") {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(1)}${suffix}`;
}

export function trendStateClass(value: number, inverse = false) {
  const improved = inverse ? value < 0 : value > 0;
  if (improved) return "bg-success/15 text-success";
  if (value === 0) return "bg-muted text-muted-foreground";
  return "bg-danger/15 text-danger";
}

export function describeLeadTime(value: number | null, rawValue: number | null, discarded: boolean) {
  if (discarded && rawValue !== null) {
    return `descartado (${formatDuration(rawValue)} bruto)`;
  }
  if (value !== null) {
    return formatDuration(value);
  }
  return "sin traza";
}
