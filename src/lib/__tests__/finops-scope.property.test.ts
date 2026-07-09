/**
 * Property tests for the account-scoping helpers of CurFullSnapshot.
 *
 * Feature: finops-cost-comparison-explorer (PARTE A — account scoping)
 * Module under test: src/lib/finops-scope.ts
 *
 * Covers:
 *  - Property 1: Invariante de alcance del snapshot.
 *    After scopeSnapshotToAccounts(snapshot, S), no account-carrying section
 *    retains rows whose account is outside S, and any section with no
 *    intersection with S ends up empty (cardinality 0). assertSnapshotScoped
 *    over the scoped snapshot never throws.
 *    **Validates: Requirements 1.1, 1.2, 1.4, 2.3, 2.4**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  scopeSnapshotToAccounts,
  assertSnapshotScoped,
} from "../finops-scope";
import type { CurFullSnapshot } from "../athena-cur";

/* ------------------------------------------------------------------ */
/*  Account universe + selection arbitraries                          */
/* ------------------------------------------------------------------ */

/** Known universe of account ids the generated snapshots draw from. */
const UNIVERSE = [
  "111111111111",
  "222222222222",
  "333333333333",
  "444444444444",
  "555555555555",
  "666666666666",
] as const;

/** Account ids that are guaranteed NOT in the universe (for disjoint sets). */
const OUTSIDE = ["999999999999", "888888888888", "777777777777"] as const;

const arbAccountId = fc.constantFrom(...UNIVERSE);

/** Labels include non-ASCII to exercise unicode-safe handling. */
const arbLabel = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constantFrom("café-prod", "αβγ-data", "日本-retail", "naïve-ops", "Niño💸", "über"),
);

const arbCost = fc.double({ min: -500, max: 5000, noNaN: true });
const arbResourceId = fc.string({ minLength: 1, maxLength: 24 });

/** Selection of accounts: in-universe subsets, fully-disjoint, and empty. */
const arbSelected: fc.Arbitrary<string[]> = fc.oneof(
  fc.subarray([...UNIVERSE]), // includes empty and full subsets
  fc.subarray([...OUTSIDE], { minLength: 1 }), // non-empty disjoint set
  fc.constant<string[]>([]), // explicitly empty
  fc.constant([...UNIVERSE]), // total
  // mixed: some in-universe + some outside ids (repeats possible)
  fc.tuple(fc.subarray([...UNIVERSE]), fc.subarray([...OUTSIDE])).map(([a, b]) => [...a, ...b, ...a]),
);

/* ------------------------------------------------------------------ */
/*  Account-carrying row arbitraries                                   */
/* ------------------------------------------------------------------ */

const arbByAccount = fc.record({
  accountId: arbAccountId,
  accountName: arbLabel,
  cost: arbCost,
  services: fc.array(fc.record({ service: arbLabel, cost: arbCost }), { maxLength: 4 }),
});

const arbTopResource = fc.record({
  accountId: arbAccountId,
  service: arbLabel,
  resourceId: arbResourceId,
  cost: arbCost,
  instanceType: fc.oneof(fc.constant(""), arbLabel),
});

const arbEc2Fleet = fc.record({
  instanceType: arbLabel,
  accountId: arbAccountId,
  accountName: arbLabel,
  resourceCount: fc.nat({ max: 50 }),
  cost: arbCost,
});

const arbGp2Detail = fc.record({
  resourceId: arbResourceId,
  account: arbAccountId,
  gbMonth: fc.nat({ max: 5000 }),
  cost: arbCost,
});

const arbExtSupportDetail = fc.record({
  resourceId: arbResourceId,
  account: arbAccountId,
  engine: arbLabel,
  cost: arbCost,
});

const arbCwlGroup = fc.record({ logGroup: arbLabel, cost: arbCost, account: arbAccountId });
const arbNatConsumer = fc.record({ resourceId: arbResourceId, account: arbAccountId, cost: arbCost });
const arbBedrockModel = fc.record({
  model: arbLabel,
  account: arbAccountId,
  accountName: fc.option(arbLabel, { nil: undefined }),
  cost: arbCost,
});

const arbAnomalyDay = fc.record({
  day: fc.constantFrom("2026-06-01", "2026-06-15", "2026-05-30"),
  cost: arbCost,
  deviation: fc.double({ min: 0, max: 10, noNaN: true }),
  topServices: fc.array(fc.record({ service: arbLabel, cost: arbCost }), { maxLength: 3 }),
  topResources: fc.array(
    fc.record({ resourceId: arbResourceId, service: arbLabel, cost: arbCost, account: arbAccountId }),
    { maxLength: 5 },
  ),
});

const arbAiDay = fc.record({
  date: fc.constantFrom("2026-06-01", "2026-06-02", "2026-06-03"),
  kiroCost: arbCost,
  bedrockCost: arbCost,
  totalAiCost: arbCost,
  byAccount: fc.array(
    fc.record({
      accountId: arbAccountId,
      accountName: arbLabel,
      kiroCost: arbCost,
      bedrockCost: arbCost,
      totalCost: arbCost,
    }),
    { maxLength: 5 },
  ),
});

/* ------------------------------------------------------------------ */
/*  Full snapshot arbitrary (structurally-valid CurFullSnapshot)       */
/* ------------------------------------------------------------------ */

const arbCurFullSnapshot: fc.Arbitrary<CurFullSnapshot> = fc
  .record({
    byAccount: fc.array(arbByAccount, { maxLength: 8 }),
    topResources: fc.array(arbTopResource, { maxLength: 12 }),
    ec2Fleet: fc.array(arbEc2Fleet, { maxLength: 10 }),
    gp2Detail: fc.array(arbGp2Detail, { maxLength: 6 }),
    extendedSupportDetail: fc.array(arbExtSupportDetail, { maxLength: 6 }),
    cwlGroups: fc.array(arbCwlGroup, { maxLength: 6 }),
    natConsumers: fc.array(arbNatConsumer, { maxLength: 6 }),
    bedrockModels: fc.array(arbBedrockModel, { maxLength: 6 }),
    anomalyAttribution: fc.array(arbAnomalyDay, { maxLength: 4 }),
    aiDays: fc.array(arbAiDay, { maxLength: 4 }),
  })
  .map((g) => ({
    window: { startDate: "2026-06-01", endDate: "2026-06-30" },
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
    byAccount: g.byAccount,
    // byService / dailyCosts / byDomain / byEnvironment are NOT account-identifiable.
    byService: [],
    dailyCosts: [],
    topResources: g.topResources,
    pricingModel: [],
    savingsPlans: { coveredCost: 0, onDemandEquivalent: 0, savingsAmount: 0, savingsPct: 0 },
    onDemandExposure: { cost: 0, pct: 0 },
    byDomain: [],
    byEnvironment: [],
    tagCoverage: { taggedCost: 0, untaggedCost: 0, coveragePct: 0 },
    spDetails: [],
    hiddenCosts: {
      gp2Volumes: { monthlyCost: 0, estimatedSavings: 0, resourceCount: 0 },
      gp2Detail: g.gp2Detail,
      extendedSupport: [],
      extendedSupportDetail: g.extendedSupportDetail,
      cloudwatchLogs: { totalCost: 0, topGroups: g.cwlGroups },
      natGateways: { totalCost: 0, dataProcessedCost: 0, hoursCost: 0, topConsumers: g.natConsumers },
      bedrock: { totalCost: 0, byModel: g.bedrockModels, monthlyTrend: [] },
      snapshotCost: 0,
      interZoneTransfer: 0,
    },
    ec2Fleet: g.ec2Fleet,
    tagCompliance: [],
    anomalyAttribution: g.anomalyAttribution,
    aiCostDaily: { days: g.aiDays, anomalyDays: [], totals: { kiro: 0, bedrock: 0, total: 0 } },
  }));

/* ------------------------------------------------------------------ */
/*  Helpers to inspect account-carrying sections                       */
/* ------------------------------------------------------------------ */

/** Returns [sectionName, accountId[]] pairs for every account-carrying section. */
function sectionAccounts(s: CurFullSnapshot): Array<[string, string[]]> {
  return [
    ["byAccount", s.byAccount.map((r) => r.accountId)],
    ["topResources", s.topResources.map((r) => r.accountId)],
    ["ec2Fleet", s.ec2Fleet.map((r) => r.accountId)],
    ["hiddenCosts.gp2Detail", s.hiddenCosts.gp2Detail.map((r) => r.account)],
    ["hiddenCosts.extendedSupportDetail", s.hiddenCosts.extendedSupportDetail.map((r) => r.account)],
    ["hiddenCosts.cloudwatchLogs.topGroups", s.hiddenCosts.cloudwatchLogs.topGroups.map((r) => r.account)],
    ["hiddenCosts.natGateways.topConsumers", s.hiddenCosts.natGateways.topConsumers.map((r) => r.account)],
    ["hiddenCosts.bedrock.byModel", s.hiddenCosts.bedrock.byModel.map((r) => r.account)],
    ["anomalyAttribution.topResources", s.anomalyAttribution.flatMap((d) => d.topResources.map((r) => r.account))],
    ["aiCostDaily.byAccount", s.aiCostDaily.days.flatMap((d) => d.byAccount.map((r) => r.accountId))],
  ];
}

/* ------------------------------------------------------------------ */
/*  Property 1: Invariante de alcance del snapshot                     */
/* ------------------------------------------------------------------ */

// Feature: finops-cost-comparison-explorer, Property 1: Invariante de alcance del snapshot
test("Property 1: scoped snapshot keeps only selected accounts; disjoint sections go empty", () => {
  fc.assert(
    fc.property(arbCurFullSnapshot, arbSelected, (snapshot, selected) => {
      const set = new Set(selected);
      const before = sectionAccounts(snapshot);
      const scoped = scopeSnapshotToAccounts(snapshot, selected);
      const after = sectionAccounts(scoped);

      for (const [section, accounts] of after) {
        // (1) No row in any account-identifiable section is outside the selected set.
        for (const id of accounts) {
          assert.ok(
            set.has(id),
            `section ${section} retained out-of-scope account ${id} (selected={${selected.join(",")}})`,
          );
        }
      }

      // (2) If selected is disjoint from a section's accounts, that section is empty.
      const beforeBySection = new Map(before);
      for (const [section, accountsAfter] of after) {
        const originalAccounts = beforeBySection.get(section) ?? [];
        const intersects = originalAccounts.some((id) => set.has(id));
        if (!intersects) {
          assert.equal(
            accountsAfter.length,
            0,
            `section ${section} should be empty (no intersection with {${selected.join(",")}})`,
          );
        }
      }

      // (3) The scoped snapshot passes the strict scope assertion (never throws).
      assert.doesNotThrow(() => assertSnapshotScoped(scoped, selected));
    }),
    { numRuns: 100 },
  );
});
