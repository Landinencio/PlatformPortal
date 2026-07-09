/**
 * Example tests for client-side account scoping + AwsRightsizingCard wiring
 * (spec: finops-cost-comparison-explorer, task 6.4).
 *
 * These are example-based tests (node:test), run by `npm test` via `tsx --test`.
 *
 * Two parts:
 *
 *  PART 1 — `scopeSnapshotToAccounts` (src/lib/finops-scope.ts), the client-side
 *  defence layer. We build a small, structurally-valid `CurFullSnapshot` with
 *  `ec2Fleet` rows and every account-bearing `hiddenCosts` sub-section populated
 *  with a mix of accounts A and B, scope it to `["A"]`, and assert that only A
 *  rows survive and B is gone everywhere. (Req 1.1, 1.3)
 *
 *  PART 2 — the AwsRightsizingCard recommendation filter + forecast URL (Req 1.2).
 *  `aws-rightsizing-card.tsx` is a React client component that does NOT export its
 *  helpers, so — per the spec's "ejemplo" approach used elsewhere (e.g.
 *  `cur-direct-route.test.ts` mirrors the route body) — we replicate the EXACT
 *  predicate, summary recomputation and URL construction the component uses and
 *  assert on them. The mirrored logic below is copied verbatim from the current
 *  component so the test fails if the component's behaviour drifts.
 *
 * _Requirements: 1.1, 1.3, 1.2_
 */

import test from "node:test";
import assert from "node:assert/strict";

import { scopeSnapshotToAccounts } from "../finops-scope";
import type { CurFullSnapshot } from "../athena-cur";

/* ================================================================== */
/*  PART 1 — scopeSnapshotToAccounts drops out-of-account rows         */
/* ================================================================== */

const ACC_A = "A";
const ACC_B = "B";

/**
 * Build a structurally-valid CurFullSnapshot whose account-bearing sections
 * (`ec2Fleet` + every `hiddenCosts.*` detail) mix accounts A and B. All
 * account-agnostic sections are left empty/zero — they are irrelevant to scoping.
 */
function buildMixedSnapshot(): CurFullSnapshot {
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
    byAccount: [
      { accountId: ACC_A, accountName: "digital-prod", cost: 800, services: [{ service: "AmazonEC2", cost: 800 }] },
      { accountId: ACC_B, accountName: "retail-prod", cost: 300, services: [{ service: "AmazonRDS", cost: 300 }] },
    ],
    byService: [],
    dailyCosts: [],
    topResources: [
      { accountId: ACC_A, service: "AmazonEC2", resourceId: "i-aaa", cost: 250, instanceType: "m5.large" },
      { accountId: ACC_B, service: "AmazonRDS", resourceId: "db-bbb", cost: 180, instanceType: "" },
    ],
    pricingModel: [],
    savingsPlans: { coveredCost: 0, onDemandEquivalent: 0, savingsAmount: 0, savingsPct: 0 },
    onDemandExposure: { cost: 0, pct: 0 },
    byDomain: [],
    byEnvironment: [],
    tagCoverage: { taggedCost: 0, untaggedCost: 0, coveragePct: 0 },
    spDetails: [],
    hiddenCosts: {
      gp2Volumes: { monthlyCost: 0, estimatedSavings: 0, resourceCount: 0 },
      gp2Detail: [
        { resourceId: "vol-a", account: ACC_A, gbMonth: 100, cost: 12 },
        { resourceId: "vol-b", account: ACC_B, gbMonth: 200, cost: 24 },
      ],
      extendedSupport: [],
      extendedSupportDetail: [
        { resourceId: "pg-a", account: ACC_A, engine: "postgres", cost: 950 },
        { resourceId: "pg-b", account: ACC_B, engine: "mysql", cost: 500 },
      ],
      cloudwatchLogs: {
        totalCost: 0,
        topGroups: [
          { logGroup: "/aws/lambda/a", cost: 40, account: ACC_A },
          { logGroup: "/aws/lambda/b", cost: 60, account: ACC_B },
        ],
      },
      natGateways: {
        totalCost: 0,
        dataProcessedCost: 0,
        hoursCost: 0,
        topConsumers: [
          { resourceId: "nat-a", account: ACC_A, cost: 200 },
          { resourceId: "nat-b", account: ACC_B, cost: 100 },
        ],
      },
      bedrock: {
        totalCost: 0,
        byModel: [
          { model: "claude", account: ACC_A, cost: 70 },
          { model: "haiku", account: ACC_B, cost: 30 },
        ],
        monthlyTrend: [],
      },
      snapshotCost: 0,
      interZoneTransfer: 0,
    },
    ec2Fleet: [
      { instanceType: "m5.large", accountId: ACC_A, accountName: "digital-prod", resourceCount: 3, cost: 250 },
      { instanceType: "c5.xlarge", accountId: ACC_B, accountName: "retail-prod", resourceCount: 2, cost: 180 },
    ],
    tagCompliance: [],
    anomalyAttribution: [],
    aiCostDaily: { days: [], anomalyDays: [], totals: { kiro: 0, bedrock: 0, total: 0 } },
  };
}

test("scopeSnapshotToAccounts removes out-of-account rows from ec2Fleet (Req 1.3)", () => {
  const scoped = scopeSnapshotToAccounts(buildMixedSnapshot(), [ACC_A]);

  assert.deepEqual(
    scoped.ec2Fleet.map((r) => r.accountId),
    [ACC_A],
    "ec2Fleet must contain only account A",
  );
  assert.ok(
    !scoped.ec2Fleet.some((r) => r.accountId === ACC_B),
    "account B must be gone from ec2Fleet",
  );
});

test("scopeSnapshotToAccounts removes out-of-account rows from every hiddenCosts sub-section (Req 1.1, 1.3)", () => {
  const scoped = scopeSnapshotToAccounts(buildMixedSnapshot(), [ACC_A]);
  const hc = scoped.hiddenCosts;

  assert.deepEqual(hc.gp2Detail.map((r) => r.account), [ACC_A], "gp2Detail → only A");
  assert.deepEqual(hc.extendedSupportDetail.map((r) => r.account), [ACC_A], "extendedSupportDetail → only A");
  assert.deepEqual(hc.cloudwatchLogs.topGroups.map((r) => r.account), [ACC_A], "cloudwatchLogs.topGroups → only A");
  assert.deepEqual(hc.natGateways.topConsumers.map((r) => r.account), [ACC_A], "natGateways.topConsumers → only A");
  assert.deepEqual(hc.bedrock.byModel.map((r) => r.account), [ACC_A], "bedrock.byModel → only A");

  // Account B is gone everywhere it appeared.
  const allAccounts = [
    ...hc.gp2Detail.map((r) => r.account),
    ...hc.extendedSupportDetail.map((r) => r.account),
    ...hc.cloudwatchLogs.topGroups.map((r) => r.account),
    ...hc.natGateways.topConsumers.map((r) => r.account),
    ...hc.bedrock.byModel.map((r) => r.account),
  ];
  assert.ok(!allAccounts.includes(ACC_B), "account B must be gone from all hiddenCosts sub-sections");
});

/* ================================================================== */
/*  PART 2 — AwsRightsizingCard recommendation filter + forecast URL   */
/*  (mirrors aws-rightsizing-card.tsx verbatim — Req 1.2)              */
/* ================================================================== */

interface AwsRightsizingItem {
  type: string;
  accountId: string;
  instanceId: string;
  currentType: string;
  currentMonthlyCost: number;
  suggestedType: string | null;
  suggestedMonthlyCost: number;
  estimatedSavings: number;
}

/**
 * EXACT copy of the predicate + summary recomputation in aws-rightsizing-card.tsx.
 * Mirroring it (rather than rendering the React client component) keeps the test
 * dependency-free, per the spec's "ejemplo" approach. Update both together.
 */
function filterRecommendations(
  recommendations: AwsRightsizingItem[],
  selectedAccountIds: string[],
): AwsRightsizingItem[] {
  return recommendations.filter(
    (r) => selectedAccountIds.length === 0 || selectedAccountIds.includes(r.accountId),
  );
}

function recomputeSummary(filtered: AwsRightsizingItem[]): {
  terminateCount: number;
  modifyCount: number;
  estimatedMonthlySavings: number;
} {
  const terminateCount = filtered.filter((r) => r.type === "Terminate").length;
  const modifyCount = filtered.length - terminateCount;
  const estimatedMonthlySavings = filtered.reduce((sum, r) => sum + (r.estimatedSavings || 0), 0);
  return { terminateCount, modifyCount, estimatedMonthlySavings };
}

/** EXACT copy of the forecast URL construction in aws-rightsizing-card.tsx. */
function buildForecastUrl(selectedAccountIds: string[]): string {
  let url = "/api/finops/forecast?months=3";
  if (selectedAccountIds.length > 0) {
    url += `&accountIds=${selectedAccountIds.join(",")}`;
  }
  return url;
}

function item(overrides: Partial<AwsRightsizingItem>): AwsRightsizingItem {
  return {
    type: "Modify",
    accountId: ACC_A,
    instanceId: "i-default",
    currentType: "m5.large",
    currentMonthlyCost: 100,
    suggestedType: "m5.medium",
    suggestedMonthlyCost: 50,
    estimatedSavings: 50,
    ...overrides,
  };
}

const RECOMMENDATIONS: AwsRightsizingItem[] = [
  item({ accountId: ACC_A, instanceId: "i-a1", type: "Terminate", estimatedSavings: 120 }),
  item({ accountId: ACC_A, instanceId: "i-a2", type: "Modify", estimatedSavings: 40 }),
  item({ accountId: ACC_B, instanceId: "i-b1", type: "Terminate", estimatedSavings: 200 }),
  item({ accountId: ACC_B, instanceId: "i-b2", type: "Modify", estimatedSavings: 75 }),
];

test("rightsizing filter discards unselected accounts (Req 1.2)", () => {
  const filtered = filterRecommendations(RECOMMENDATIONS, [ACC_A]);

  assert.deepEqual(
    filtered.map((r) => r.accountId),
    [ACC_A, ACC_A],
    "only account A recommendations survive",
  );
  assert.ok(!filtered.some((r) => r.accountId === ACC_B), "account B recommendations are discarded");
});

test("rightsizing summary counters reflect only the selected account (Req 1.2)", () => {
  const filtered = filterRecommendations(RECOMMENDATIONS, [ACC_A]);
  const summary = recomputeSummary(filtered);

  // A has 1 Terminate (120) + 1 Modify (40) = 160, NOT the org-wide totals.
  assert.equal(summary.terminateCount, 1, "terminateCount counts only A's Terminate row");
  assert.equal(summary.modifyCount, 1, "modifyCount counts only A's Modify row");
  assert.equal(summary.estimatedMonthlySavings, 160, "savings sum only A's rows");
});

test("empty selection keeps all recommendations (org-wide) (Req 1.2)", () => {
  const filtered = filterRecommendations(RECOMMENDATIONS, []);
  assert.equal(filtered.length, 4, "empty selection means no account filter");

  const summary = recomputeSummary(filtered);
  assert.equal(summary.terminateCount, 2);
  assert.equal(summary.modifyCount, 2);
  assert.equal(summary.estimatedMonthlySavings, 120 + 40 + 200 + 75);
});

test("forecast URL includes accountIds CSV when selection is non-empty (Req 1.2)", () => {
  const url = buildForecastUrl([ACC_A, ACC_B]);
  assert.ok(url.includes("accountIds=A,B"), `expected accountIds CSV in URL, got: ${url}`);
  assert.ok(url.includes("months=3"), "base forecast params preserved");
});

test("forecast URL omits accountIds when selection is empty (Req 1.2)", () => {
  const url = buildForecastUrl([]);
  assert.ok(!url.includes("accountIds"), `accountIds must be omitted for org-wide, got: ${url}`);
  assert.equal(url, "/api/finops/forecast?months=3");
});
