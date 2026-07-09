/**
 * Unit tests for the Iskay Citation_Guard ("loguea y mide" mode).
 *
 * Feature: iskay-finops-specialist — task 9 (Citation_Guard).
 *
 * Covers:
 *  - `extractCitedAmounts`: $-prefixed, USD-suffixed, US thousands+decimal,
 *    EU thousands+decimal, multiple amounts in the same paragraph,
 *    de-duplication, and rejection of bare numbers without a currency hint.
 *  - `verifyCitations`: matched amounts, missing amounts, ±0.5% tolerance,
 *    recursive scanning of nested objects/arrays/tool-result wrappers,
 *    empty / malformed inputs (never throws).
 *
 * The guard is "log and measure" only — it must NEVER throw or block the
 * response — so the tests assert pure behaviour without any side effect.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  extractCitedAmounts,
  verifyCitations,
  normalizeAmount,
  collectNumbers,
  approxEqual,
} from "../finops-citation-guard";

/* ------------------------------------------------------------------ */
/*  extractCitedAmounts                                                 */
/* ------------------------------------------------------------------ */

test("extractCitedAmounts: $-prefixed simple amount", () => {
  assert.deepEqual(extractCitedAmounts("El total es $1,234.56 este mes."), [1234.56]);
});

test("extractCitedAmounts: trailing USD with US thousands+decimal", () => {
  assert.deepEqual(extractCitedAmounts("Marketplace: 12,345.67 USD"), [12345.67]);
});

test("extractCitedAmounts: bare integer + USD suffix", () => {
  assert.deepEqual(extractCitedAmounts("Forecast 1234 USD a fin de mes"), [1234]);
});

test("extractCitedAmounts: thousands separator without decimal", () => {
  assert.deepEqual(extractCitedAmounts("Bedrock costó 1,234 USD"), [1234]);
});

test("extractCitedAmounts: simple decimal without thousands", () => {
  assert.deepEqual(extractCitedAmounts("$1234.5 al día"), [1234.5]);
});

test("extractCitedAmounts: EU style 1.234,56 USD", () => {
  // European-style decimals are normalised to a JS Number.
  assert.deepEqual(extractCitedAmounts("Total: 1.234,56 USD"), [1234.56]);
});

test("extractCitedAmounts: multiple amounts in the same text, sorted, deduped", () => {
  const txt =
    "Gross $10,000.00 menos Marketplace 2,345.67 USD = Net $7,654.33. " +
    "El día 15 fue $10,000.00 (duplicado).";
  assert.deepEqual(extractCitedAmounts(txt), [2345.67, 7654.33, 10000]);
});

test("extractCitedAmounts: ignores bare numbers without $ or USD", () => {
  // "1234" alone is NOT a citation: avoids grabbing account ids, percentages,
  // resource counts, etc. The guard is intentionally conservative.
  assert.deepEqual(extractCitedAmounts("Tenemos 22 cuentas y 1234 recursos"), []);
});

test("extractCitedAmounts: tilde / approx prefix is tolerated", () => {
  assert.deepEqual(extractCitedAmounts("Aproximadamente ~$1,200.00"), [1200]);
  assert.deepEqual(extractCitedAmounts("≈ 999.99 USD"), [999.99]);
});

test("extractCitedAmounts: empty / non-string input returns []", () => {
  assert.deepEqual(extractCitedAmounts(""), []);
  assert.deepEqual(extractCitedAmounts(undefined as unknown as string), []);
  assert.deepEqual(extractCitedAmounts(null as unknown as string), []);
});

test("extractCitedAmounts: euro symbol after the number is captured", () => {
  assert.deepEqual(extractCitedAmounts("Coste: 1,500.00 €"), [1500]);
});

/* ------------------------------------------------------------------ */
/*  normalizeAmount                                                     */
/* ------------------------------------------------------------------ */

test("normalizeAmount: us style (1,234.56)", () => {
  assert.equal(normalizeAmount("1,234.56"), 1234.56);
});

test("normalizeAmount: eu style (1.234,56)", () => {
  assert.equal(normalizeAmount("1.234,56"), 1234.56);
});

test("normalizeAmount: plain integer with thousands", () => {
  assert.equal(normalizeAmount("1,234"), 1234);
});

test("normalizeAmount: plain decimal", () => {
  assert.equal(normalizeAmount("1234.5"), 1234.5);
});

test("normalizeAmount: garbage → NaN", () => {
  assert.ok(Number.isNaN(normalizeAmount("abc")));
  assert.ok(Number.isNaN(normalizeAmount("")));
});

/* ------------------------------------------------------------------ */
/*  approxEqual                                                         */
/* ------------------------------------------------------------------ */

test("approxEqual: exact match within ±$1 floor", () => {
  assert.ok(approxEqual(1234.56, 1234.56));
  assert.ok(approxEqual(10, 10.5));
});

test("approxEqual: within ±0.5% relative tolerance", () => {
  // 0.4% delta on a $10k figure must match.
  assert.ok(approxEqual(10000, 10040));
  // 0.6% delta on a $10k figure must NOT match.
  assert.ok(!approxEqual(10000, 10060));
});

test("approxEqual: NaN / Infinity safe", () => {
  assert.ok(!approxEqual(NaN, 10));
  assert.ok(!approxEqual(10, Infinity));
});

/* ------------------------------------------------------------------ */
/*  collectNumbers (recursive scan)                                     */
/* ------------------------------------------------------------------ */

test("collectNumbers: walks nested objects and arrays", () => {
  const value = {
    totalCostUSD: 1234.56,
    accounts: [
      { id: "111111111111", costUSD: 500 },
      { id: "222222222222", costUSD: 734.56, services: [{ name: "EC2", cost: 300 }] },
    ],
  };
  const nums = collectNumbers(value);
  assert.ok(nums.includes(1234.56));
  assert.ok(nums.includes(500));
  assert.ok(nums.includes(734.56));
  assert.ok(nums.includes(300));
});

test("collectNumbers: does NOT coerce numeric-looking strings", () => {
  // Account ids, ISO dates, etc. must not be picked as numbers.
  const value = { account: "111111111111", date: "2026-05-01", cost: 42 };
  assert.deepEqual(collectNumbers(value).sort(), [42]);
});

test("collectNumbers: skips null / undefined / Infinity / NaN", () => {
  const value = {
    a: null,
    b: undefined,
    c: NaN,
    d: Infinity,
    e: 7,
  };
  assert.deepEqual(collectNumbers(value).sort(), [7]);
});

/* ------------------------------------------------------------------ */
/*  verifyCitations — end-to-end                                        */
/* ------------------------------------------------------------------ */

test("verifyCitations: cited amount that matches a tool result", () => {
  const text = "El total este mes es $1,234.56.";
  const toolResults = [{ output: { totalCostUSD: 1234.56, accounts: [] } }];
  const out = verifyCitations(text, toolResults);
  assert.deepEqual(out.cited, [1234.56]);
  assert.deepEqual(out.matched, [1234.56]);
  assert.deepEqual(out.missing, []);
});

test("verifyCitations: cited amount with NO matching tool result is reported missing", () => {
  const text = "El total fue $9,999.99.";
  const toolResults = [{ output: { totalCostUSD: 1234.56 } }];
  const out = verifyCitations(text, toolResults);
  assert.deepEqual(out.cited, [9999.99]);
  assert.deepEqual(out.matched, []);
  assert.deepEqual(out.missing, [9999.99]);
});

test("verifyCitations: tolerance handling — 0.4% delta still matches", () => {
  const text = "Marketplace 10,040.00 USD.";
  const toolResults = [{ output: { netCost: 10000 } }];
  const out = verifyCitations(text, toolResults);
  assert.deepEqual(out.matched, [10040]);
  assert.deepEqual(out.missing, []);
});

test("verifyCitations: tolerance handling — 1% delta is missing", () => {
  const text = "Marketplace 10,100.00 USD.";
  const toolResults = [{ output: { netCost: 10000 } }];
  const out = verifyCitations(text, toolResults);
  assert.deepEqual(out.missing, [10100]);
  assert.deepEqual(out.matched, []);
});

test("verifyCitations: recursive scanning of deeply nested tool results", () => {
  const text = "El top mover fue Bedrock con $300.00.";
  // Wrap the cost three levels deep, mixing arrays and objects, to confirm
  // `collectNumbers` doesn't bottom out early.
  const toolResults = [
    {
      output: {
        movers: [
          { service: "EC2", deltas: [{ delta: -50 }] },
          { service: "Bedrock (GenAI)", deltas: [{ delta: 300 }] },
        ],
      },
    },
  ];
  const out = verifyCitations(text, toolResults);
  assert.deepEqual(out.matched, [300]);
  assert.deepEqual(out.missing, []);
});

test("verifyCitations: empty text → empty result, never throws", () => {
  const out = verifyCitations("", { totalCostUSD: 1234 });
  assert.deepEqual(out, { cited: [], matched: [], missing: [] });
});

test("verifyCitations: empty toolResults → all citations are missing", () => {
  const out = verifyCitations("Total $123.45", []);
  assert.deepEqual(out.cited, [123.45]);
  assert.deepEqual(out.missing, [123.45]);
  assert.deepEqual(out.matched, []);
});

test("verifyCitations: malformed toolResults (null / circular-ish) does not throw", () => {
  // Build a deliberately weird shape: undefined leaves, mixed types.
  const weird: any = { a: undefined, b: null, c: { d: [null, "x", { e: 42 }] } };
  const out = verifyCitations("Tenemos $42.00 en infra", weird);
  assert.deepEqual(out.matched, [42]);
});

test("verifyCitations: multiple cited amounts, partial match", () => {
  const text =
    "Gross $10,000.00, Marketplace 2,345.67 USD, Net $7,654.33.";
  // Only Gross and Net live in the tool output; Marketplace has no number.
  const toolResults = [
    { output: { gross: 10000, net: 7654.33, accounts: [{ id: "1", cost: 99 }] } },
  ];
  const out = verifyCitations(text, toolResults);
  assert.deepEqual(out.cited, [2345.67, 7654.33, 10000]);
  assert.deepEqual(out.matched.sort((a, b) => a - b), [7654.33, 10000]);
  assert.deepEqual(out.missing, [2345.67]);
});
