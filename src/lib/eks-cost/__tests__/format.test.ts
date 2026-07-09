/**
 * Unit tests for `src/lib/eks-cost/format.ts`.
 *
 * Cover the canonical output shape of `formatEur` and `formatEurK`
 * across the four magnitude bands (< 1 000, 1 000-999 999, >= 1 000 000)
 * plus non-finite fallbacks. The compact form uses `es-ES` conventions
 * (comma as decimal separator, non-breaking space before the symbol).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { formatEur, formatEurK } from "@/lib/eks-cost/format";

const NBSP = "\u00A0";

/* ------------------------------------------------------------------ */
/*  formatEur — full form                                              */
/* ------------------------------------------------------------------ */

test("formatEur: zero renders as '0,00 €'", () => {
  assert.equal(formatEur(0), `0,00${NBSP}€`);
});

test("formatEur: small integer renders with two decimals", () => {
  assert.equal(formatEur(42), `42,00${NBSP}€`);
});

test("formatEur: value with cents is rendered with es-ES separators", () => {
  assert.equal(formatEur(128456.32), `128.456,32${NBSP}€`);
});

test("formatEur: negative value keeps sign and two decimals", () => {
  assert.equal(formatEur(-12.5), `-12,50${NBSP}€`);
});

test("formatEur: NaN falls back to '—'", () => {
  assert.equal(formatEur(Number.NaN), "—");
});

test("formatEur: Infinity falls back to '—'", () => {
  assert.equal(formatEur(Number.POSITIVE_INFINITY), "—");
  assert.equal(formatEur(Number.NEGATIVE_INFINITY), "—");
});

/* ------------------------------------------------------------------ */
/*  formatEurK — compact form                                          */
/* ------------------------------------------------------------------ */

test("formatEurK: zero renders as '0 €' with no decimals", () => {
  assert.equal(formatEurK(0), `0${NBSP}€`);
});

test("formatEurK: value below 1000 renders as integer euros", () => {
  assert.equal(formatEurK(42), `42${NBSP}€`);
  assert.equal(formatEurK(999), `999${NBSP}€`);
});

test("formatEurK: value below 1000 rounds to nearest integer", () => {
  assert.equal(formatEurK(999.4), `999${NBSP}€`);
  // Rounding at the boundary lands on 1000; es-ES only groups numbers >= 10 000,
  // so no thousands separator is applied to 4-digit integers.
  assert.equal(formatEurK(999.6), `1000${NBSP}€`);
});

test("formatEurK: 1000 renders as '1,0k €'", () => {
  assert.equal(formatEurK(1000), `1,0k${NBSP}€`);
});

test("formatEurK: mid-thousands render with 'k' suffix and one decimal", () => {
  assert.equal(formatEurK(12345.67), `12,3k${NBSP}€`);
  assert.equal(formatEurK(128456.32), `128,5k${NBSP}€`);
});

test("formatEurK: 1 000 000 renders as '1,0M €'", () => {
  assert.equal(formatEurK(1_000_000), `1,0M${NBSP}€`);
});

test("formatEurK: multi-million renders with 'M' suffix", () => {
  assert.equal(formatEurK(2_500_000), `2,5M${NBSP}€`);
});

test("formatEurK: negative preserves sign in the compact form", () => {
  assert.equal(formatEurK(-128456.32), `-128,5k${NBSP}€`);
  assert.equal(formatEurK(-42), `-42${NBSP}€`);
  assert.equal(formatEurK(-2_500_000), `-2,5M${NBSP}€`);
});

test("formatEurK: NaN falls back to '—'", () => {
  assert.equal(formatEurK(Number.NaN), "—");
});

test("formatEurK: Infinity falls back to '—'", () => {
  assert.equal(formatEurK(Number.POSITIVE_INFINITY), "—");
  assert.equal(formatEurK(Number.NEGATIVE_INFINITY), "—");
});
