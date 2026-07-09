/**
 * Contract tests for the shared engineering-metrics window/author helpers
 * (spec: dora-author-scoping — holistic DORA + Gestión wiring review).
 *
 * These lock down the two cross-cutting contracts whose inline duplication
 * caused the "custom range ignored" (Gestión tab) and "author filter does
 * nothing" (period comparison + MR details) regressions:
 *
 *   1. resolveDateWindow — explicit from/to wins over the rolling `days` window,
 *      both branches inclusive of the boundary days.
 *   2. expandAuthorUsernames — canonical author keys are translated to the
 *      GitLab usernames the per-username endpoints store, via the manager
 *      dashboard's published options.authors[].usernames map.
 *
 * Conventions: node:test + node:assert/strict, run with tsx (no network/DB).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  isValidIsoDate,
  resolveDateWindow,
  expandAuthorUsernames,
} from "../metrics-window";

test("isValidIsoDate accepts YYYY-MM-DD and rejects everything else", () => {
  assert.equal(isValidIsoDate("2026-06-01"), true);
  assert.equal(isValidIsoDate("2026-6-1"), false);
  assert.equal(isValidIsoDate("custom"), false);
  assert.equal(isValidIsoDate(""), false);
  assert.equal(isValidIsoDate(null), false);
  assert.equal(isValidIsoDate(undefined), false);
});

test("resolveDateWindow: valid from/to wins over days and is inclusive", () => {
  const { startDate, endDate, usedRange } = resolveDateWindow({
    from: "2026-05-01",
    to: "2026-05-07",
    days: 30,
  });
  assert.equal(usedRange, true);
  assert.equal(startDate.toISOString(), "2026-05-01T00:00:00.000Z");
  assert.equal(endDate.toISOString(), "2026-05-07T23:59:59.999Z");
});

test("resolveDateWindow: falls back to rolling `days` window when range invalid", () => {
  const now = new Date("2026-06-10T12:00:00.000Z");
  // Missing `to` → must NOT use range.
  const a = resolveDateWindow({ from: "2026-05-01", to: null, days: 7, now });
  assert.equal(a.usedRange, false);
  assert.equal(a.endDate.toISOString(), now.toISOString());
  assert.equal(a.startDate.toISOString(), "2026-06-03T12:00:00.000Z");

  // Non-ISO ("custom") → must NOT use range.
  const b = resolveDateWindow({ from: "custom", to: "custom", days: 30, now });
  assert.equal(b.usedRange, false);
});

test("resolveDateWindow: different ranges produce different windows (cache-key safety)", () => {
  const week1 = resolveDateWindow({ from: "2026-05-01", to: "2026-05-07", days: 7 });
  const week2 = resolveDateWindow({ from: "2026-05-08", to: "2026-05-14", days: 7 });
  assert.notEqual(week1.startDate.toISOString(), week2.startDate.toISOString());
  assert.notEqual(week1.endDate.toISOString(), week2.endDate.toISOString());
});

const AUTHOR_OPTIONS = [
  { key: "ada@corp.com", usernames: ["ada", "ada.lovelace"] },
  { key: "alan@corp.com", usernames: ["aturing"] },
  { key: "grace@corp.com", usernames: [] },
];

test("expandAuthorUsernames: empty selection ⇒ no filter", () => {
  assert.deepEqual(expandAuthorUsernames([], AUTHOR_OPTIONS), []);
});

test("expandAuthorUsernames: maps canonical keys to all underlying usernames", () => {
  const result = expandAuthorUsernames(["ada@corp.com"], AUTHOR_OPTIONS).sort();
  assert.deepEqual(result, ["ada", "ada.lovelace"]);
});

test("expandAuthorUsernames: multiple keys, deduped, ignores unknown keys", () => {
  const result = expandAuthorUsernames(
    ["ada@corp.com", "alan@corp.com", "ghost@corp.com"],
    AUTHOR_OPTIONS
  ).sort();
  assert.deepEqual(result, ["ada", "ada.lovelace", "aturing"]);
});

test("expandAuthorUsernames: identity with no usernames contributes nothing", () => {
  assert.deepEqual(expandAuthorUsernames(["grace@corp.com"], AUTHOR_OPTIONS), []);
});
