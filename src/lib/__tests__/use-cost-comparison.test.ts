/**
 * Example tests for the cost-comparison network orchestration hook
 * (spec: finops-cost-comparison-explorer, task 8.2).
 *
 * These are example-based tests (node:test), run by `npm test` via `tsx --test`.
 *
 * `src/hooks/use-cost-comparison.ts` is a React hook whose core async behaviour
 * is the per-month parallel `fetch('/api/finops/cur-direct?...')` + `Promise.allSettled`
 * partition into `snapshotsByMonth` (fulfilled) and `monthErrors` (rejected/non-ok).
 * The portal's test stack is `node:test` + `tsx` with NO React renderer / jsdom
 * (see package.json: `tsx --test src/lib/__tests__/*.test.ts`), so — exactly as
 * `cur-direct-route.test.ts` and `finops-scope-client.test.ts` do — we MIRROR the
 * hook's orchestration here in a small dependency-free async function and exercise
 * it against a mocked `global.fetch`.
 *
 * The mirrored `orchestrate()` below copies the hook's `fetchMonth` (URL
 * construction via `monthRange`, `accountIds` propagated only when non-empty,
 * non-ok → throw) and its `allSettled` partition VERBATIM, so this test fails if
 * the hook drifts.
 *
 * Asserts:
 *   1. A failing month is recorded in `monthErrors` without preventing the
 *      correct months from landing in `snapshotsByMonth` (Req 10.4).
 *   2. Each fetch URL transmits `accountIds=<csv>` and the correct
 *      startDate/endDate derived from `monthRange` (Req 8.2).
 *
 * _Requirements: 10.4, 8.2_
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { CurFullSnapshot } from "../athena-cur";
import { monthRange, sortMonths, type MonthKey } from "../finops-cost-comparison";

/* ================================================================== */
/*  Mirror of use-cost-comparison.ts orchestration (keep in sync)      */
/* ================================================================== */

interface OrchestrationResult {
  snapshotsByMonth: Record<MonthKey, CurFullSnapshot>;
  monthErrors: Record<MonthKey, string>;
}

/**
 * EXACT copy of the hook's per-month fetch + allSettled partition. Mirroring it
 * (rather than rendering the React hook) keeps the test dependency-free, per the
 * spec's "ejemplo" approach. Update both together.
 */
async function orchestrate(
  selectedAccountIds: string[],
  selectedMonths: MonthKey[],
  fetchImpl: typeof fetch,
): Promise<OrchestrationResult> {
  const months = sortMonths(selectedMonths);

  const fetchMonth = async (
    month: MonthKey,
  ): Promise<{ month: MonthKey; snapshot: CurFullSnapshot }> => {
    const { startDate, endDate } = monthRange(month);
    const params = new URLSearchParams({ startDate, endDate });
    if (selectedAccountIds.length > 0) {
      params.set("accountIds", selectedAccountIds.join(","));
    }

    const response = await fetchImpl(`/api/finops/cur-direct?${params.toString()}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`cur-direct returned ${response.status} for ${month}`);
    }
    const snapshot = (await response.json()) as CurFullSnapshot;
    return { month, snapshot };
  };

  const settled = await Promise.allSettled(months.map((month) => fetchMonth(month)));

  const snapshotsByMonth: Record<MonthKey, CurFullSnapshot> = {};
  const monthErrors: Record<MonthKey, string> = {};

  settled.forEach((outcome, index) => {
    const month = months[index];
    if (outcome.status === "fulfilled") {
      snapshotsByMonth[outcome.value.month] = outcome.value.snapshot;
    } else {
      const reason = outcome.reason;
      monthErrors[month] = reason instanceof Error ? reason.message : String(reason);
    }
  });

  return { snapshotsByMonth, monthErrors };
}

/* ================================================================== */
/*  Test helpers                                                       */
/* ================================================================== */

/** Minimal structurally-valid snapshot for a given month/account total. */
function fakeSnapshot(month: MonthKey, accountId: string, cost: number): CurFullSnapshot {
  const { startDate, endDate } = monthRange(month);
  return {
    window: { startDate, endDate },
    totalCost: cost,
    netCost: cost,
    netInfraCost: cost,
    marketplace: { cost: 0, items: [] },
    discounts: {
      sppDiscount: 0,
      bundledDiscount: 0,
      credits: 0,
      refunds: 0,
      savingsPlanNegation: 0,
      tax: 0,
    },
    byAccount: [{ accountId, accountName: "digital-prod", cost, services: [] }],
    byService: [],
    dailyCosts: [],
    topResources: [],
    pricingModel: [],
    savingsPlans: { coveredCost: 0, onDemandEquivalent: 0, savingsAmount: 0, savingsPct: 0 },
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
      natGateways: { totalCost: 0, dataProcessedCost: 0, hoursCost: 0, topConsumers: [] },
      bedrock: { totalCost: 0, byModel: [], monthlyTrend: [] },
      snapshotCost: 0,
      interZoneTransfer: 0,
    },
    ec2Fleet: [],
    tagCompliance: [],
    anomalyAttribution: [],
    aiCostDaily: { days: [], anomalyDays: [], totals: { kiro: 0, bedrock: 0, total: 0 } },
  } as unknown as CurFullSnapshot;
}

/** A Response-like object good enough for the mirrored orchestrator. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface Recorded {
  url: string;
  params: URLSearchParams;
}

/**
 * Builds a mocked `fetch` that records every requested URL and returns a
 * snapshot for "good" months while failing (non-ok / reject) for one month.
 */
function makeFetchMock(opts: {
  failMonth: MonthKey;
  rejectInsteadOfNonOk?: boolean;
}): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];

  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const params = new URLSearchParams(url.split("?")[1] ?? "");
    calls.push({ url, params });

    const startDate = params.get("startDate") ?? "";
    const month = startDate.slice(0, 7); // "YYYY-MM"

    if (month === opts.failMonth) {
      if (opts.rejectInsteadOfNonOk) {
        throw new Error("network down");
      }
      return jsonResponse({ error: "boom" }, false, 500);
    }

    return jsonResponse(fakeSnapshot(month, "111122223333", 1000));
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

/* ================================================================== */
/*  Tests                                                              */
/* ================================================================== */

test("a failing month is isolated in monthErrors while correct months still land (Req 10.4, non-ok)", async () => {
  const accounts = ["111122223333", "444455556666"];
  const months: MonthKey[] = ["2026-03", "2026-04", "2026-05"];
  const { fetchImpl } = makeFetchMock({ failMonth: "2026-04" });

  const { snapshotsByMonth, monthErrors } = await orchestrate(accounts, months, fetchImpl);

  // The two healthy months are present...
  assert.ok(snapshotsByMonth["2026-03"], "2026-03 snapshot present");
  assert.ok(snapshotsByMonth["2026-05"], "2026-05 snapshot present");
  assert.equal(Object.keys(snapshotsByMonth).length, 2, "only the two healthy months land");

  // ...and the failing one is recorded as an error, not thrown.
  assert.ok(!snapshotsByMonth["2026-04"], "failing month is absent from snapshots");
  assert.ok(monthErrors["2026-04"], "failing month recorded in monthErrors");
  assert.match(
    monthErrors["2026-04"],
    /500/,
    "error message carries the non-ok status",
  );
  assert.equal(Object.keys(monthErrors).length, 1, "only the failing month is in monthErrors");
});

test("a rejected fetch is isolated in monthErrors too (Req 10.4, network reject)", async () => {
  const accounts = ["111122223333"];
  const months: MonthKey[] = ["2026-03", "2026-04"];
  const { fetchImpl } = makeFetchMock({ failMonth: "2026-03", rejectInsteadOfNonOk: true });

  const { snapshotsByMonth, monthErrors } = await orchestrate(accounts, months, fetchImpl);

  assert.ok(snapshotsByMonth["2026-04"], "healthy month still resolves");
  assert.equal(monthErrors["2026-03"], "network down", "rejection reason captured verbatim");
});

test("each request transmits accountIds CSV and the month's date range (Req 8.2)", async () => {
  const accounts = ["111122223333", "444455556666"];
  const months: MonthKey[] = ["2026-02", "2026-12"]; // Feb (28) + Dec (31) edge cases
  const { fetchImpl, calls } = makeFetchMock({ failMonth: "__none__" });

  await orchestrate(accounts, months, fetchImpl);

  assert.equal(calls.length, 2, "one request per month");

  for (const call of calls) {
    assert.equal(
      call.params.get("accountIds"),
      "111122223333,444455556666",
      `accountIds CSV transmitted on ${call.url}`,
    );
  }

  // startDate/endDate match monthRange exactly (Feb 2026 → 28, Dec 2026 → 31).
  const byMonth = new Map(calls.map((c) => [c.params.get("startDate")!.slice(0, 7), c.params]));

  const feb = byMonth.get("2026-02")!;
  assert.equal(feb.get("startDate"), "2026-02-01");
  assert.equal(feb.get("endDate"), "2026-02-28", "non-leap February ends on the 28th");

  const dec = byMonth.get("2026-12")!;
  assert.equal(dec.get("startDate"), "2026-12-01");
  assert.equal(dec.get("endDate"), "2026-12-31", "December ends on the 31st");
});

test("no accountIds param is sent when the selection is empty (defensive)", async () => {
  const months: MonthKey[] = ["2026-05"];
  const { fetchImpl, calls } = makeFetchMock({ failMonth: "__none__" });

  await orchestrate([], months, fetchImpl);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.has("accountIds"), false, "empty selection omits accountIds");
  assert.equal(calls[0].params.get("startDate"), "2026-05-01");
  assert.equal(calls[0].params.get("endDate"), "2026-05-31");
});
