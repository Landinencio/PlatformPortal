/**
 * Property tests for the pure FinOps cost-comparison core (PARTE B).
 *
 * Feature: finops-cost-comparison-explorer
 * Module under test: src/lib/finops-cost-comparison.ts
 *
 * This file hosts Properties 2 through 8 of the comparison core. Each property
 * lives in its own clearly-delimited section so that subsequent tasks
 * (2.4–2.9) can append their property below the last section without touching
 * the shared arbitraries defined at the top.
 *
 * Shared arbitraries (reusable by later properties):
 *  - arbMonthKey  — a single valid "YYYY-MM" key.
 *  - arbMonths    — a non-empty set (≥2) of distinct month keys.
 *  - arbEntityKey / arbLabel / arbCost — entity building blocks.
 *  - arbPerMonth  — a full scenario: { months, perMonth, facts } where
 *                   `perMonth` is the `Record<MonthKey, EntityCost[]>` input to
 *                   `buildComparisonRows` and `facts` is the flat ground-truth
 *                   used to derive expectations.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  buildComparison,
  buildComparisonRows,
  buildProgression,
  computeDelta,
  extractEntities,
  sortMonths,
  type EntityCost,
  type MonthKey,
} from "../finops-cost-comparison";
import type {
  CurCostByAccount,
  CurFullSnapshot,
  CurTopResource,
} from "../athena-cur";
import { scopeSnapshotToAccounts } from "../finops-scope";

/* ================================================================== */
/*  Shared arbitraries (used across Properties 2–8)                    */
/* ================================================================== */

/** A single valid calendar month key in "YYYY-MM" form. */
const arbMonthKey: fc.Arbitrary<MonthKey> = fc
  .tuple(fc.integer({ min: 2023, max: 2027 }), fc.integer({ min: 1, max: 12 }))
  .map(([year, month]) => `${year}-${String(month).padStart(2, "0")}`);

/** A set (distinct, ≥2) of months to compare, in arbitrary order. */
const arbMonths: fc.Arbitrary<MonthKey[]> = fc.uniqueArray(arbMonthKey, {
  minLength: 2,
  maxLength: 6,
});

/**
 * A small pool of entity keys so that the same key recurs across different
 * months (shared entities) and can repeat within a single month (exercising
 * the within-month summation path of `buildComparisonRows`).
 */
const arbEntityKey: fc.Arbitrary<string> = fc.constantFrom(
  "acc-a",
  "acc-b",
  "acc-c",
  "acc-d",
  "acc-e",
);

/** Labels include non-ASCII to exercise unicode-safe handling. */
const arbLabel: fc.Arbitrary<string> = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constantFrom("café-prod", "αβγ-data", "日本-retail", "naïve-ops", "Niño💸", "über"),
);

/** Costs include negatives (credits/refunds) and zero. */
const arbCost: fc.Arbitrary<number> = fc.double({
  min: -1000,
  max: 10000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** A single ground-truth fact: one `EntityCost` placed in one month. */
interface Fact {
  month: MonthKey;
  key: string;
  label: string;
  cost: number;
}

/** Builds the `buildComparisonRows` input from a month set + flat facts. */
function buildPerMonth(
  months: MonthKey[],
  facts: Fact[],
): Record<MonthKey, EntityCost[]> {
  const perMonth: Record<MonthKey, EntityCost[]> = {};
  for (const m of months) perMonth[m] = [];
  // Preserve fact order within each month so summation order matches the
  // implementation (it iterates each month's array in order).
  for (const f of facts) {
    perMonth[f.month].push({ key: f.key, label: f.label, cost: f.cost });
  }
  return perMonth;
}

/**
 * A complete comparison scenario. Entities are present in only SOME months
 * (each fact targets a single month drawn from `months`), so the generated
 * data naturally covers additions (entity only in newer months) and removals
 * (entity only in older months), as well as months with no data at all.
 */
const arbPerMonth: fc.Arbitrary<{
  months: MonthKey[];
  perMonth: Record<MonthKey, EntityCost[]>;
  facts: Fact[];
}> = arbMonths.chain((months) =>
  fc
    .array(
      fc.record({
        month: fc.constantFrom(...months),
        key: arbEntityKey,
        label: arbLabel,
        cost: arbCost,
      }),
      { maxLength: 30 },
    )
    .map((facts) => ({ months, perMonth: buildPerMonth(months, facts), facts })),
);

/* ------------------------------------------------------------------ */
/*  Expectation helpers                                                */
/* ------------------------------------------------------------------ */

/** Distinct entity keys present anywhere in the facts. */
function distinctKeys(facts: Fact[]): string[] {
  return [...new Set(facts.map((f) => f.key))];
}

/** Ground-truth summed cost for an entity in a given month (0 if absent). */
function expectedCost(facts: Fact[], key: string, month: MonthKey): number {
  return facts
    .filter((f) => f.key === key && f.month === month)
    .reduce((acc, f) => acc + f.cost, 0);
}

/* ================================================================== */
/*  Property 2: Completitud por zero-fill                              */
/* ================================================================== */

// Feature: finops-cost-comparison-explorer, Property 2: Completitud por zero-fill
test("Property 2: every row has a value for all months, zero where there was no data", () => {
  fc.assert(
    fc.property(arbPerMonth, ({ months, perMonth, facts }) => {
      const sortedMonths = sortMonths(months);
      const rows = buildComparisonRows(perMonth, months);

      // One row per distinct entity that appeared in any month.
      const keys = distinctKeys(facts);
      assert.equal(
        rows.length,
        keys.length,
        `expected ${keys.length} rows (one per distinct entity), got ${rows.length}`,
      );

      const rowByKey = new Map(rows.map((r) => [r.key, r]));

      for (const key of keys) {
        const row = rowByKey.get(key);
        assert.ok(row, `missing row for entity ${key}`);

        // (1) byMonth has EXACTLY the keys of the compared month set.
        const byMonthKeys = sortMonths(Object.keys(row.byMonth));
        assert.deepEqual(
          byMonthKeys,
          sortedMonths,
          `row ${key} byMonth keys ${JSON.stringify(byMonthKeys)} != months ${JSON.stringify(sortedMonths)}`,
        );

        // (2) Value per month equals the summed input cost; 0 where absent.
        for (const month of sortedMonths) {
          const present = facts.some((f) => f.key === key && f.month === month);
          const actual = row.byMonth[month];

          if (!present) {
            // Zero-fill: months with no data (incl. additions/removals) are 0.
            assert.equal(
              actual,
              0,
              `row ${key} month ${month} should be 0 (no data) but was ${actual}`,
            );
          } else {
            const expected = expectedCost(facts, key, month);
            assert.ok(
              Math.abs(actual - expected) < 0.01,
              `row ${key} month ${month}: expected ~${expected}, got ${actual}`,
            );
          }
        }
      }
    }),
    { numRuns: 100 },
  );
});

/* ================================================================== */
/*  Property 3 — appended by task 2.4                                  */
/* ================================================================== */

/**
 * A `byMonth` scenario for a single entity over a compared month set. Each
 * month is independently either ABSENT (no data → must count as 0) or present
 * with an arbitrary cost (explicitly including 0, so the first/last month can
 * model additions and removals). Returns the month set (in arbitrary order),
 * its chronological sort, and the resulting partial `byMonth` map.
 */
const arbByMonthScenario: fc.Arbitrary<{
  months: MonthKey[];
  sorted: MonthKey[];
  byMonth: Record<MonthKey, number>;
}> = arbMonths.chain((months) => {
  const sorted = sortMonths(months);
  // Allow explicit zeros (removals/additions) alongside absent months.
  const arbAmount = fc.oneof(
    fc.constant(0),
    arbCost,
    fc.option(arbCost, { nil: undefined }),
  );
  return fc.tuple(...sorted.map(() => arbAmount)).map((values) => {
    const byMonth: Record<MonthKey, number> = {};
    sorted.forEach((m, i) => {
      const v = values[i];
      if (v !== undefined) byMonth[m] = v;
    });
    return { months, sorted, byMonth };
  });
});

// Feature: finops-cost-comparison-explorer, Property 3: Variación absoluta = reciente − antiguo
test("Property 3: deltaAbs equals newest minus oldest month (missing months count as 0)", () => {
  fc.assert(
    fc.property(arbByMonthScenario, ({ months, sorted, byMonth }) => {
      const { deltaAbs, trend } = computeDelta(byMonth, months);

      // Ground truth: missing first/last month is treated as 0.
      const base = byMonth[sorted[0]] ?? 0;
      const latest = byMonth[sorted[sorted.length - 1]] ?? 0;

      // Exact equality — the delta math keeps the inputs untouched.
      assert.equal(
        deltaAbs,
        latest - base,
        `deltaAbs ${deltaAbs} != ${latest} - ${base}`,
      );

      // Trend sign must agree with the sign of deltaAbs.
      const expectedTrend =
        deltaAbs > 0 ? "up" : deltaAbs < 0 ? "down" : "flat";
      assert.equal(
        trend,
        expectedTrend,
        `trend ${trend} != ${expectedTrend} for deltaAbs ${deltaAbs}`,
      );

      // computeDelta must never leak Infinity/NaN into the absolute delta.
      assert.ok(
        Number.isFinite(deltaAbs),
        `deltaAbs should be finite, got ${deltaAbs}`,
      );
    }),
    { numRuns: 100 },
  );
});

// Feature: finops-cost-comparison-explorer, Property 3: Variación absoluta = reciente − antiguo
test("Property 3: row deltaAbs through buildComparisonRows equals newest minus oldest", () => {
  fc.assert(
    fc.property(arbByMonthScenario, ({ months, sorted, byMonth }) => {
      // Project the single-entity scenario into a `perMonth` input where the
      // entity only appears in the months that have data (others zero-fill).
      const key = "acc-a";
      const perMonth: Record<MonthKey, EntityCost[]> = {};
      for (const m of sorted) {
        perMonth[m] = [];
        if (byMonth[m] !== undefined) {
          perMonth[m].push({ key, label: "Account A", cost: byMonth[m] });
        }
      }

      const rows = buildComparisonRows(perMonth, months);

      // If the entity had data in no month at all, there is no row to check.
      const hasAnyData = sorted.some((m) => byMonth[m] !== undefined);
      if (!hasAnyData) {
        assert.equal(rows.length, 0, "expected no rows when entity has no data");
        return;
      }

      const row = rows.find((r) => r.key === key);
      assert.ok(row, "expected a row for the single entity");

      // deltaAbs is computed from the row's (rounded, zero-filled) byMonth.
      const expected = row.byMonth[sorted[sorted.length - 1]] - row.byMonth[sorted[0]];
      assert.equal(
        row.deltaAbs,
        expected,
        `row.deltaAbs ${row.deltaAbs} != ${expected}`,
      );

      // Zero-filled endpoints: a month without data is exactly 0 in the row.
      assert.equal(row.byMonth[sorted[0]], roundIfPresent(byMonth, sorted[0]));
      assert.equal(
        row.byMonth[sorted[sorted.length - 1]],
        roundIfPresent(byMonth, sorted[sorted.length - 1]),
      );

      const expectedTrend =
        row.deltaAbs > 0 ? "up" : row.deltaAbs < 0 ? "down" : "flat";
      assert.equal(row.trend, expectedTrend);
    }),
    { numRuns: 100 },
  );
});

/** Mirrors the row builder's accumulation + 2-decimal rounding; absent month
 *  => exact 0. The leading `0 +` matches the builder (which accumulates from 0),
 *  normalising any `-0` input to `+0` exactly as the production code does. */
function roundIfPresent(byMonth: Record<MonthKey, number>, month: MonthKey): number {
  const v = byMonth[month];
  if (v === undefined) return 0;
  return Math.round((0 + v) * 100) / 100;
}

/* ================================================================== */
/*  Property 4 — appended by task 2.5                                  */
/* ================================================================== */

/**
 * A `byMonth` scenario tailored to exercise the percentage-variation rule,
 * with a deliberate, controlled distribution of the BASE month (oldest):
 *
 *  - `zero`    → base month present with an explicit 0.
 *  - `absent`  → base month has no data at all (must also count as 0).
 *  - `nonzero` → base month present with a guaranteed non-zero amount.
 *
 * The first two cases (≈2/3 of draws) force `base === 0`, so deltaPct MUST be
 * `null`; they pair with a frequently non-zero newest month to model the
 * "addition" case (a brand-new entity whose oldest month is 0). The `nonzero`
 * case exercises the real percentage path with exact arithmetic.
 */

/** A guaranteed non-zero cost (credits included), for the non-zero base case. */
const arbNonZeroCost: fc.Arbitrary<number> = arbCost.filter(
  (c) => c !== 0 && Number.isFinite(c),
);

const arbBaseZeroScenario: fc.Arbitrary<{
  months: MonthKey[];
  sorted: MonthKey[];
  byMonth: Record<MonthKey, number>;
}> = arbMonths.chain((months) => {
  const sorted = sortMonths(months);
  // Base (oldest) month: bias 2:1 toward base===0 (zero or absent).
  const arbBase = fc.oneof(
    { weight: 1, arbitrary: fc.constant<{ kind: "zero" }>({ kind: "zero" }) },
    { weight: 1, arbitrary: fc.constant<{ kind: "absent" }>({ kind: "absent" }) },
    {
      weight: 1,
      arbitrary: arbNonZeroCost.map((v) => ({ kind: "nonzero" as const, value: v })),
    },
  );
  // Middle months: absent, zero, or any cost.
  const arbMiddle = fc.oneof(
    fc.constant(0),
    arbCost,
    fc.option(arbCost, { nil: undefined }),
  );
  // Newest month: frequently non-zero (so base-0 rows are genuine additions),
  // but occasionally absent/zero too.
  const arbLatest = fc.oneof(
    { weight: 3, arbitrary: arbNonZeroCost },
    { weight: 1, arbitrary: fc.constant(0) },
    { weight: 1, arbitrary: fc.option(arbCost, { nil: undefined }) },
  );

  const middleCount = Math.max(0, sorted.length - 2);

  return fc
    .tuple(arbBase, fc.tuple(...Array.from({ length: middleCount }, () => arbMiddle)), arbLatest)
    .map(([baseChoice, middles, latest]) => {
      const byMonth: Record<MonthKey, number> = {};

      // Base (oldest) month.
      if (baseChoice.kind === "zero") byMonth[sorted[0]] = 0;
      else if (baseChoice.kind === "nonzero") byMonth[sorted[0]] = baseChoice.value;
      // "absent" → leave it out of the map entirely.

      // Middle months (only exist when there are ≥3 months).
      for (let i = 0; i < middleCount; i++) {
        const v = middles[i];
        if (v !== undefined) byMonth[sorted[i + 1]] = v;
      }

      // Newest month.
      if (sorted.length >= 2 && latest !== undefined) {
        byMonth[sorted[sorted.length - 1]] = latest;
      }

      return { months, sorted, byMonth };
    });
});

// Feature: finops-cost-comparison-explorer, Property 4: Variación porcentual no aplicable con base cero
test("Property 4: deltaPct is null iff base is 0, else exactly (deltaAbs / base) * 100", () => {
  fc.assert(
    fc.property(arbBaseZeroScenario, ({ months, sorted, byMonth }) => {
      const { deltaAbs, deltaPct } = computeDelta(byMonth, months);

      // Base = oldest month, missing counts as 0 (matches the implementation).
      const base = byMonth[sorted[0]] ?? 0;
      const latest = byMonth[sorted[sorted.length - 1]] ?? 0;

      if (base === 0) {
        // Base-zero: percentage is NOT applicable. Never a number, never
        // Infinity/NaN. Covers both first-month-absent and first-month-zero.
        assert.equal(
          deltaPct,
          null,
          `deltaPct should be null when base is 0, got ${deltaPct}`,
        );
      } else {
        // Non-zero base: exact percentage. The implementation computes
        // `(deltaAbs / base) * 100`; we replicate the exact same expression
        // (deltaAbs = latest - base) so floating-point results are identical.
        const expectedDeltaAbs = latest - base;
        const expectedPct = (expectedDeltaAbs / base) * 100;

        assert.notEqual(deltaPct, null, "deltaPct should not be null for non-zero base");
        // Exact equality: the spec defines deltaPct as exactly
        // `(deltaAbs / base) * 100` for a non-zero base. We replicate the same
        // expression so the floating-point result is bit-identical (including
        // the degenerate overflow when base is a tiny denormal — the spec only
        // forbids Infinity/NaN for the base === 0 case, not here).
        assert.equal(
          deltaPct,
          expectedPct,
          `deltaPct ${deltaPct} != (${expectedDeltaAbs} / ${base}) * 100 = ${expectedPct}`,
        );
        // deltaPct must never be NaN — even a tiny non-zero base yields a
        // well-defined (possibly infinite) ratio, never NaN.
        assert.ok(
          !Number.isNaN(deltaPct as number),
          `deltaPct should never be NaN for non-zero base, got ${deltaPct}`,
        );
        // Sanity: deltaAbs used by the percentage matches newest - oldest.
        assert.equal(deltaAbs, expectedDeltaAbs);
      }
    }),
    { numRuns: 100 },
  );
});

// Feature: finops-cost-comparison-explorer, Property 4: Variación porcentual no aplicable con base cero
test("Property 4: row deltaPct through buildComparisonRows is null iff the (rounded) base month is 0", () => {
  fc.assert(
    fc.property(arbBaseZeroScenario, ({ months, sorted, byMonth }) => {
      // Project the single-entity scenario into a `perMonth` input.
      const key = "acc-a";
      const perMonth: Record<MonthKey, EntityCost[]> = {};
      for (const m of sorted) {
        perMonth[m] = [];
        if (byMonth[m] !== undefined) {
          perMonth[m].push({ key, label: "Account A", cost: byMonth[m] });
        }
      }

      const rows = buildComparisonRows(perMonth, months);

      const hasAnyData = sorted.some((m) => byMonth[m] !== undefined);
      if (!hasAnyData) {
        assert.equal(rows.length, 0, "expected no rows when entity has no data");
        return;
      }

      const row = rows.find((r) => r.key === key);
      assert.ok(row, "expected a row for the single entity");

      // The row's base is the zero-filled, 2-decimal-rounded oldest month.
      const rowBase = row.byMonth[sorted[0]];
      const rowLatest = row.byMonth[sorted[sorted.length - 1]];

      if (rowBase === 0) {
        assert.equal(
          row.deltaPct,
          null,
          `row.deltaPct should be null when base is 0, got ${row.deltaPct}`,
        );
      } else {
        const expectedPct = ((rowLatest - rowBase) / rowBase) * 100;
        assert.equal(
          row.deltaPct,
          expectedPct,
          `row.deltaPct ${row.deltaPct} != ${expectedPct}`,
        );
        assert.ok(
          Number.isFinite(row.deltaPct as number),
          `row.deltaPct should be finite, got ${row.deltaPct}`,
        );
      }
    }),
    { numRuns: 100 },
  );
});

/* ================================================================== */
/*  Property 5 — appended by task 2.6                                  */
/* ================================================================== */

/**
 * A non-empty list of months in ARBITRARY (often unsorted, possibly
 * duplicated) order, so the chronological ordering of `sortMonths` is
 * exercised independently of how a user might have picked them. The companion
 * `arbPerMonth` scenario is reused as-is to build real comparison rows.
 */
const arbUnorderedMonths: fc.Arbitrary<MonthKey[]> = fc.uniqueArray(arbMonthKey, {
  minLength: 1,
  maxLength: 6,
});

// Feature: finops-cost-comparison-explorer, Property 5: Progresión cronológica ordenada
test("Property 5: sortMonths returns an ascending-ordered permutation of its input", () => {
  fc.assert(
    fc.property(arbUnorderedMonths, (months) => {
      const sorted = sortMonths(months);

      // (1) Non-mutating: same length, and the input array is untouched.
      assert.equal(
        sorted.length,
        months.length,
        `sortMonths changed the length: ${sorted.length} != ${months.length}`,
      );

      // (2) Permutation: it is exactly the same multiset of months, just
      //     reordered (compare the two arrays each sorted the same way).
      assert.deepEqual(
        [...sorted].sort(),
        [...months].sort(),
        "sortMonths result is not a permutation of its input",
      );

      // (3) Ascending chronological order: every adjacent pair is non-decreasing.
      //     "YYYY-MM" keys are fixed-width and zero-padded, so chronological
      //     order coincides with lexicographic (string) order.
      for (let i = 1; i < sorted.length; i++) {
        assert.ok(
          sorted[i - 1] <= sorted[i],
          `sortMonths not ascending at index ${i}: ${sorted[i - 1]} > ${sorted[i]}`,
        );
      }
    }),
    { numRuns: 100 },
  );
});

// Feature: finops-cost-comparison-explorer, Property 5: Progresión cronológica ordenada
test("Property 5: buildProgression traverses byMonth in chronological order, one value per month", () => {
  fc.assert(
    fc.property(arbPerMonth, ({ months, perMonth, facts }) => {
      const sortedMonths = sortMonths(months);
      const rows = buildComparisonRows(perMonth, months);

      // Even when a scenario produced no facts (hence no rows), the progression
      // of a synthetic empty row must still have exactly one (zero) value per
      // month, in chronological order.
      if (rows.length === 0) {
        assert.equal(distinctKeys(facts).length, 0, "no rows implies no entities");
      }

      for (const row of rows) {
        const progression = buildProgression(row, months);

        // (1) Length equals the number of DISTINCT compared months.
        assert.equal(
          progression.length,
          sortedMonths.length,
          `progression length ${progression.length} != months ${sortedMonths.length}`,
        );

        // (2) The i-th element is exactly the row's value for the i-th month in
        //     chronological order — i.e. it traverses `byMonth` sorted, NOT in
        //     the user's selection order.
        sortedMonths.forEach((month, i) => {
          assert.equal(
            progression[i],
            row.byMonth[month] ?? 0,
            `progression[${i}] ${progression[i]} != byMonth[${month}] ${row.byMonth[month]}`,
          );
        });
      }
    }),
    { numRuns: 100 },
  );
});

// Feature: finops-cost-comparison-explorer, Property 5: Progresión cronológica ordenada
test("Property 5: progression is independent of the month selection order", () => {
  fc.assert(
    fc.property(arbPerMonth, ({ months, perMonth }) => {
      // Build rows + progression with the months reversed: the chronological
      // traversal must yield the SAME sequence regardless of input order.
      const reversed = [...months].reverse();

      const rows = buildComparisonRows(perMonth, months);
      const rowsReversed = buildComparisonRows(perMonth, reversed);

      const byKey = new Map(rows.map((r) => [r.key, r]));

      for (const rowReversed of rowsReversed) {
        const row = byKey.get(rowReversed.key);
        assert.ok(row, `missing row for entity ${rowReversed.key}`);

        assert.deepEqual(
          buildProgression(rowReversed, reversed),
          buildProgression(row, months),
          `progression for ${rowReversed.key} depends on month order`,
        );
      }
    }),
    { numRuns: 100 },
  );
});

/* ================================================================== */
/*  Property 6 — appended by task 2.7                                  */
/* ================================================================== */

/**
 * Hierarchical-aggregation scenario. We generate a raw dataset of
 * `(account, service, resource, cost)` facts and assemble a *consistent*
 * `CurFullSnapshot` from them — exactly the invariant the real Athena CUR
 * queries satisfy: a service's cost is the sum of its resources, and an
 * account's cost is the sum of its services.
 *
 * Sizes are kept small (≤5 accounts, ≤4 services, ≤4 resources ⇒ ≤80
 * resources) so the snapshot never trips the real top-200 `topResources`
 * cap — every generated resource is present in `topResources`.
 */

/** Money rounded to 2 decimals, mirroring the production `roundMoney`. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Costs as 2-decimal amounts (cents), including credits (negatives) and 0. */
const arbResourceCost: fc.Arbitrary<number> = fc
  .integer({ min: -100_000, max: 1_000_000 })
  .map((cents) => cents / 100);

/**
 * Raw hierarchy: a list of accounts, each with a list of services, each with a
 * list of resources carrying a cost. The shape only carries counts + costs;
 * stable, unique ids (`acc-i`, `svc-i-j`, `res-i-j-k`) are derived from the
 * indices when the snapshot is assembled, guaranteeing uniqueness at every
 * level without leaning on `fc.uniqueArray`.
 */
const arbHierarchy = fc.array(
  fc.record({
    services: fc.array(
      fc.record({
        resources: fc.array(fc.record({ cost: arbResourceCost }), {
          minLength: 1,
          maxLength: 4,
        }),
      }),
      { minLength: 1, maxLength: 4 },
    ),
  }),
  { minLength: 1, maxLength: 5 },
);

/** Builds a fully-populated, account-consistent `CurFullSnapshot`. */
function buildHierarchicalSnapshot(
  hierarchy: { services: { resources: { cost: number }[] }[] }[],
): CurFullSnapshot {
  const topResources: CurTopResource[] = [];
  const byAccount: CurCostByAccount[] = [];

  hierarchy.forEach((account, i) => {
    const accountId = `acc-${i}`;
    const services: { service: string; cost: number }[] = [];

    account.services.forEach((service, j) => {
      const serviceCode = `svc-${i}-${j}`;
      let serviceSum = 0;

      service.resources.forEach((resource, k) => {
        const resourceId = `res-${i}-${j}-${k}`;
        serviceSum += resource.cost;
        topResources.push({
          accountId,
          service: serviceCode,
          resourceId,
          cost: resource.cost,
          instanceType: "",
        });
      });

      // Service cost = sum of its resources (rounded to 2 decimals).
      services.push({ service: serviceCode, cost: round2(serviceSum) });
    });

    // Account cost = sum of its services (rounded to 2 decimals).
    const accountSum = services.reduce((acc, s) => acc + s.cost, 0);
    byAccount.push({
      accountId,
      accountName: `Account ${i}`,
      cost: round2(accountSum),
      services,
    });
  });

  return {
    window: { startDate: "2026-01-01", endDate: "2026-01-31" },
    totalCost: 0,
    netCost: 0,
    netInfraCost: 0,
    marketplace: { cost: 0, items: [] },
    discounts: {
      sppDiscount: 0,
      bundledDiscount: 0,
      credits: 0,
      refunds: 0,
      savingsPlanNegation: 0,
      tax: 0,
    },
    byAccount,
    byService: [],
    dailyCosts: [],
    topResources,
    pricingModel: [],
    savingsPlans: {
      coveredCost: 0,
      onDemandEquivalent: 0,
      savingsAmount: 0,
      savingsPct: 0,
    },
    onDemandExposure: { cost: 0, pct: 0 },
    byDomain: [],
    byEnvironment: [],
    tagCoverage: { taggedCost: 0, untaggedCost: 0, coveragePct: 0 },
    spDetails: [],
    hiddenCosts: {
      gp2Volumes: { monthlyCost: 0, estimatedSavings: 0, resourceCount: 0 },
      gp2Detail: [],
      extendedSupport: [],
      extendedSupportDetail: [],
      cloudwatchLogs: { totalCost: 0, topGroups: [] },
      natGateways: {
        totalCost: 0,
        dataProcessedCost: 0,
        hoursCost: 0,
        topConsumers: [],
      },
      bedrock: { totalCost: 0, byModel: [], monthlyTrend: [] },
      snapshotCost: 0,
      interZoneTransfer: 0,
    },
    ec2Fleet: [],
    tagCompliance: [],
    anomalyAttribution: [],
    aiCostDaily: {
      days: [],
      anomalyDays: [],
      totals: { kiro: 0, bedrock: 0, total: 0 },
    },
  };
}

/** Tolerance for the rounding allowance stated by the property (2 decimals). */
const AGGREGATION_EPSILON = 0.01;

// Feature: finops-cost-comparison-explorer, Property 6: Consistencia de agregación jerárquica
test("Property 6: sum of resources equals the service cost, sum of services equals the account cost", () => {
  fc.assert(
    fc.property(arbHierarchy, (hierarchy) => {
      const snapshot = buildHierarchicalSnapshot(hierarchy);

      // Sanity: every generated resource lands in topResources (no top-200 cap hit).
      const expectedResourceCount = hierarchy.reduce(
        (acc, a) => acc + a.services.reduce((s, svc) => s + svc.resources.length, 0),
        0,
      );
      assert.equal(
        snapshot.topResources.length,
        expectedResourceCount,
        `topResources should hold all ${expectedResourceCount} resources, got ${snapshot.topResources.length}`,
      );

      // Account-level costs as read back through the pure extractor.
      const accountEntities = extractEntities(snapshot, "account", {});
      const accountCostByKey = new Map(accountEntities.map((e) => [e.key, e.cost]));

      for (const account of snapshot.byAccount) {
        const accountId = account.accountId;

        // ── Services of this account sum to the account cost ──────────────
        const serviceEntities = extractEntities(snapshot, "service", { accountId });
        const sumOfServices = serviceEntities.reduce((s, e) => s + e.cost, 0);
        const accountCost = accountCostByKey.get(accountId);
        assert.ok(
          accountCost !== undefined,
          `account ${accountId} missing from account-level entities`,
        );
        assert.ok(
          Math.abs(sumOfServices - (accountCost as number)) < AGGREGATION_EPSILON,
          `account ${accountId}: Σservices ${sumOfServices} != account cost ${accountCost}`,
        );

        // ── Resources of each (account, service) sum to that service cost ──
        const serviceCostByKey = new Map(serviceEntities.map((e) => [e.key, e.cost]));
        for (const svc of serviceEntities) {
          const resourceEntities = extractEntities(snapshot, "resource", {
            accountId,
            service: svc.key,
          });
          const sumOfResources = resourceEntities.reduce((s, e) => s + e.cost, 0);
          const serviceCost = serviceCostByKey.get(svc.key) as number;
          assert.ok(
            Math.abs(sumOfResources - serviceCost) < AGGREGATION_EPSILON,
            `${accountId}/${svc.key}: Σresources ${sumOfResources} != service cost ${serviceCost}`,
          );
        }
      }
    }),
    { numRuns: 100 },
  );
});

// Feature: finops-cost-comparison-explorer, Property 6: Consistencia de agregación jerárquica
test("Property 6: buildComparison preserves hierarchical aggregation for a single month", () => {
  fc.assert(
    fc.property(arbHierarchy, (hierarchy) => {
      const snapshot = buildHierarchicalSnapshot(hierarchy);
      const month: MonthKey = "2026-01";
      const snapshotsByMonth: Record<MonthKey, CurFullSnapshot> = { [month]: snapshot };

      // Account-level rows through the full orchestrator.
      const accountResult = buildComparison(snapshotsByMonth, "account", {});
      const accountRowByKey = new Map(
        accountResult.rows.map((r) => [r.key, r.byMonth[month]]),
      );

      for (const account of snapshot.byAccount) {
        const accountId = account.accountId;

        // Drill into services for this account through buildComparison.
        const serviceResult = buildComparison(snapshotsByMonth, "service", { accountId });
        const sumOfServiceRows = serviceResult.rows.reduce(
          (s, r) => s + r.byMonth[month],
          0,
        );
        const accountRowValue = accountRowByKey.get(accountId);
        assert.ok(
          accountRowValue !== undefined,
          `account ${accountId} missing from account-level comparison rows`,
        );

        // Both sides are 2-decimal-rounded by the row builder; allow the
        // stated rounding tolerance (×number of services, bounded by sizes).
        const serviceTolerance = AGGREGATION_EPSILON * (serviceResult.rows.length + 1);
        assert.ok(
          Math.abs(sumOfServiceRows - (accountRowValue as number)) < serviceTolerance,
          `account ${accountId}: Σservice rows ${sumOfServiceRows} != account row ${accountRowValue}`,
        );

        // And each service's resources sum back to that service row value.
        for (const svcRow of serviceResult.rows) {
          const resourceResult = buildComparison(snapshotsByMonth, "resource", {
            accountId,
            service: svcRow.key,
          });
          const sumOfResourceRows = resourceResult.rows.reduce(
            (s, r) => s + r.byMonth[month],
            0,
          );
          const resourceTolerance =
            AGGREGATION_EPSILON * (resourceResult.rows.length + 1);
          assert.ok(
            Math.abs(sumOfResourceRows - svcRow.byMonth[month]) < resourceTolerance,
            `${accountId}/${svcRow.key}: Σresource rows ${sumOfResourceRows} != service row ${svcRow.byMonth[month]}`,
          );
        }
      }
    }),
    { numRuns: 100 },
  );
});

/* ================================================================== */
/*  Property 7 — appended by task 2.8                                  */
/* ================================================================== */

/**
 * "Active month set" scenario. Pairs an arbitrary set of compared months
 * (≥2, arbitrary order) with a consistent hierarchical snapshot (reusing
 * `arbHierarchy` + `buildHierarchicalSnapshot` from Property 6). The same
 * snapshot is assigned to every month — Property 7 is about the SHAPE of the
 * result (which months/entities are present), not the per-month amounts, so a
 * shared snapshot keeps the scenario simple and fully deterministic.
 *
 * Because `arbHierarchy` always yields ≥1 account with ≥1 service and ≥1
 * resource, the ids `acc-0` / `svc-0-0` are guaranteed to exist, giving a
 * valid drill-down path for the invariance assertions.
 */
const arbActiveMonthScenario = arbMonths.chain((months) =>
  arbHierarchy.map((hierarchy) => ({ months, hierarchy })),
);

/** Builds a `snapshotsByMonth` map assigning the same snapshot to each month. */
function snapshotsForMonths(
  months: MonthKey[],
  snapshot: CurFullSnapshot,
): Record<MonthKey, CurFullSnapshot> {
  const map: Record<MonthKey, CurFullSnapshot> = {};
  for (const m of months) map[m] = snapshot;
  return map;
}

// Feature: finops-cost-comparison-explorer, Property 7: El dataset refleja el conjunto activo de meses
test("Property 7: months equals the active month set and every row's byMonth has exactly those months", () => {
  fc.assert(
    fc.property(arbActiveMonthScenario, ({ months, hierarchy }) => {
      const snapshot = buildHierarchicalSnapshot(hierarchy);
      const snapshotsByMonth = snapshotsForMonths(months, snapshot);
      const sorted = sortMonths(months);

      const result = buildComparison(snapshotsByMonth, "account", {});

      // (1a) result.months IS the chronologically-sorted active month set.
      assert.deepEqual(
        result.months,
        sorted,
        `result.months ${JSON.stringify(result.months)} != active set ${JSON.stringify(sorted)}`,
      );

      // (1b) Every row's byMonth keys are EXACTLY the active month set
      //      (set equality: no extra months, no missing months).
      for (const row of result.rows) {
        assert.deepEqual(
          sortMonths(Object.keys(row.byMonth)),
          sorted,
          `row ${row.key} byMonth keys ${JSON.stringify(Object.keys(row.byMonth))} != active set ${JSON.stringify(sorted)}`,
        );
      }
    }),
    { numRuns: 100 },
  );
});

// Feature: finops-cost-comparison-explorer, Property 7: El dataset refleja el conjunto activo de meses
test("Property 7: adding or removing a month changes result.months by exactly that month", () => {
  fc.assert(
    fc.property(arbActiveMonthScenario, ({ months, hierarchy }) => {
      const snapshot = buildHierarchicalSnapshot(hierarchy);
      const snapshotsByMonth = snapshotsForMonths(months, snapshot);
      const sorted = sortMonths(months);

      // ── Removal: drop one month (the set has ≥2, so ≥1 remains) ─────────
      const removed = sorted[sorted.length - 1];
      const reduced = { ...snapshotsByMonth };
      delete reduced[removed];

      const reducedResult = buildComparison(reduced, "account", {});
      const expectedAfterRemoval = sorted.filter((m) => m !== removed);
      assert.deepEqual(
        reducedResult.months,
        expectedAfterRemoval,
        `after removing ${removed}, months ${JSON.stringify(reducedResult.months)} != ${JSON.stringify(expectedAfterRemoval)}`,
      );
      // The two month sets differ by exactly the removed month.
      assert.deepEqual(
        sorted.filter((m) => !reducedResult.months.includes(m)),
        [removed],
        `removal should change the set by exactly {${removed}}`,
      );

      // ── Addition: add a guaranteed-fresh month ─────────────────────────
      // arbMonthKey only ranges 2023–2027, so "2099-12" is never generated
      // and is therefore guaranteed absent from the active set.
      const fresh: MonthKey = "2099-12";
      assert.ok(!sorted.includes(fresh), "fresh month must not already be present");

      const expanded = { ...snapshotsByMonth, [fresh]: snapshot };
      const expandedResult = buildComparison(expanded, "account", {});
      const expectedAfterAddition = sortMonths([...sorted, fresh]);
      assert.deepEqual(
        expandedResult.months,
        expectedAfterAddition,
        `after adding ${fresh}, months ${JSON.stringify(expandedResult.months)} != ${JSON.stringify(expectedAfterAddition)}`,
      );
      // The two month sets differ by exactly the added month.
      assert.deepEqual(
        expandedResult.months.filter((m) => !sorted.includes(m)),
        [fresh],
        `addition should change the set by exactly {${fresh}}`,
      );
    }),
    { numRuns: 100 },
  );
});

// Feature: finops-cost-comparison-explorer, Property 7: El dataset refleja el conjunto activo de meses
test("Property 7: drill-down does not alter months nor the accounts in scope (only level/drill change)", () => {
  fc.assert(
    fc.property(arbActiveMonthScenario, ({ months, hierarchy }) => {
      const snapshot = buildHierarchicalSnapshot(hierarchy);
      const snapshotsByMonth = snapshotsForMonths(months, snapshot);
      const sorted = sortMonths(months);

      // Guaranteed-existing drill path (arbHierarchy always yields acc-0/svc-0-0).
      const accountId = "acc-0";
      const service = "svc-0-0";

      const accountResult = buildComparison(snapshotsByMonth, "account", {});
      const serviceResult = buildComparison(snapshotsByMonth, "service", { accountId });
      const resourceResult = buildComparison(snapshotsByMonth, "resource", {
        accountId,
        service,
      });

      // (3a) months is invariant across every drill level — identical to the
      //      active month set regardless of level/drill.
      assert.deepEqual(accountResult.months, sorted, "account-level months drifted");
      assert.deepEqual(
        serviceResult.months,
        accountResult.months,
        "service-level drill changed months",
      );
      assert.deepEqual(
        resourceResult.months,
        accountResult.months,
        "resource-level drill changed months",
      );

      // (3b) Only `level` and `drill` change between navigations.
      assert.equal(accountResult.level, "account");
      assert.equal(serviceResult.level, "service");
      assert.equal(resourceResult.level, "resource");
      assert.deepEqual(accountResult.drill, {});
      assert.deepEqual(serviceResult.drill, { accountId });
      assert.deepEqual(resourceResult.drill, { accountId, service });

      // (3c) The accounts in scope (the set offered at the account level) are
      //      fixed by the snapshots and unaffected by drilling: re-deriving the
      //      account level after a drill yields the identical account set.
      const accountsInScope = sortMonths(accountResult.rows.map((r) => r.key));
      const reAccountResult = buildComparison(snapshotsByMonth, "account", {});
      assert.deepEqual(
        sortMonths(reAccountResult.rows.map((r) => r.key)),
        accountsInScope,
        "the set of accounts in scope changed across navigation",
      );

      // (3d) Every row at every level still carries exactly the active months.
      for (const result of [accountResult, serviceResult, resourceResult]) {
        for (const row of result.rows) {
          assert.deepEqual(
            sortMonths(Object.keys(row.byMonth)),
            sorted,
            `row ${row.key} at level ${result.level} lost the active month set`,
          );
        }
      }
    }),
    { numRuns: 100 },
  );
});

/* ================================================================== */
/*  Property 8 — appended by task 2.9                                  */
/* ================================================================== */

/**
 * Explorer-scope scenario. Reuses the consistent hierarchical snapshot from
 * Property 6 (`arbHierarchy` + `buildHierarchicalSnapshot`, whose accounts span
 * the universe U = {acc-0 .. acc-(n-1)}) and pairs it with an explicit
 * `selectedAccountIds` set S. The selection covers the three regimes the
 * explorer must survive:
 *
 *  - `partial`  → a `fc.subarray` of the real account ids (any subset of U,
 *                 including the empty selection and the full selection),
 *                 optionally augmented with ids OUTSIDE U (acc-90x) to model a
 *                 user/global filter that references accounts not in this
 *                 month's data — these must simply contribute nothing.
 *  - `disjoint` → S = ["acc-999"], guaranteed disjoint from U (arbHierarchy
 *                 never yields ≥1000 accounts) so the scoped snapshot must end
 *                 up empty at every level.
 *
 * The invariant under test: after `scopeSnapshotToAccounts(snapshot, S)`, the
 * comparison produced by `buildComparison` at the account / service / resource
 * level contains NO entity attributable to an account outside S.
 */
const arbScopeSelection = arbHierarchy.chain((hierarchy) => {
  const allIds = hierarchy.map((_, i) => `acc-${i}`);
  // Extra ids that are NOT part of this snapshot's universe U.
  const arbExtras = fc.uniqueArray(fc.constantFrom("acc-900", "acc-901", "acc-902"), {
    maxLength: 2,
  });
  return fc
    .record({
      subset: fc.subarray(allIds),
      extras: arbExtras,
      disjoint: fc.boolean(),
    })
    .map(({ subset, extras, disjoint }) => {
      // Disjoint regime forces a selection with no overlap with U at all.
      const selected = disjoint ? ["acc-999"] : [...subset, ...extras];
      return { hierarchy, allIds, selected };
    });
});

// Feature: finops-cost-comparison-explorer, Property 8: Invariante de alcance del explorador
test("Property 8: no entity at any level belongs to an account outside the selected set", () => {
  fc.assert(
    fc.property(arbScopeSelection, ({ hierarchy, allIds, selected }) => {
      const snapshot = buildHierarchicalSnapshot(hierarchy);
      const scoped = scopeSnapshotToAccounts(snapshot, selected);
      const S = new Set(selected);

      const month: MonthKey = "2026-01";
      const snapshotsByMonth: Record<MonthKey, CurFullSnapshot> = { [month]: scoped };

      // ── Account level: every comparison row key is in S ─────────────────
      const accountResult = buildComparison(snapshotsByMonth, "account", {});
      for (const row of accountResult.rows) {
        assert.ok(
          S.has(row.key),
          `account row ${row.key} belongs to an account outside the selected set`,
        );
      }

      // The accounts actually present are exactly U ∩ S (no more, no less):
      // scoping never invents accounts and never retains out-of-scope ones.
      const expectedAccounts = [...allIds.filter((id) => S.has(id))].sort();
      assert.deepEqual(
        [...accountResult.rows.map((r) => r.key)].sort(),
        expectedAccounts,
        `account-level entities ${JSON.stringify(accountResult.rows.map((r) => r.key))} != U ∩ S ${JSON.stringify(expectedAccounts)}`,
      );

      // ── Service & resource levels across the WHOLE universe U ───────────
      // For every account in U — whether selected or not — drilling must keep
      // in-scope accounts intact and yield NOTHING for out-of-scope accounts.
      hierarchy.forEach((account, i) => {
        const accountId = `acc-${i}`;
        const inScope = S.has(accountId);

        const services = extractEntities(scoped, "service", { accountId });
        if (!inScope) {
          assert.equal(
            services.length,
            0,
            `out-of-scope account ${accountId} leaked ${services.length} service(s)`,
          );
        }

        account.services.forEach((_, j) => {
          const serviceCode = `svc-${i}-${j}`;
          const resources = extractEntities(scoped, "resource", {
            accountId,
            service: serviceCode,
          });
          if (!inScope) {
            assert.equal(
              resources.length,
              0,
              `out-of-scope account ${accountId} leaked ${resources.length} resource(s) for ${serviceCode}`,
            );
          }
        });
      });

      // ── Net invariant: every account-bearing row in the scoped snapshot
      //    (the substrate the explorer reads) belongs to S ─────────────────
      for (const a of scoped.byAccount) {
        assert.ok(
          S.has(a.accountId),
          `scoped byAccount retained out-of-scope account ${a.accountId}`,
        );
      }
      for (const r of scoped.topResources) {
        assert.ok(
          S.has(r.accountId),
          `scoped topResources retained resource for out-of-scope account ${r.accountId}`,
        );
      }

      // ── Disjoint regime: a selection with no overlap with U scopes to ∅ ──
      const overlaps = allIds.some((id) => S.has(id));
      if (!overlaps) {
        assert.equal(
          accountResult.rows.length,
          0,
          "a disjoint selection must produce zero account rows",
        );
        assert.equal(scoped.byAccount.length, 0, "disjoint scope must empty byAccount");
        assert.equal(
          scoped.topResources.length,
          0,
          "disjoint scope must empty topResources",
        );
      }
    }),
    { numRuns: 100 },
  );
});
