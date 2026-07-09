/**
 * Integration tests for the `cur-direct` endpoint's account-scoping behaviour
 * (spec: finops-cost-comparison-explorer, task 4.4).
 *
 * These are example-based integration tests (node:test). The real route handler
 * (`src/app/api/finops/cur-direct/route.ts`) opens with
 * `getServerSession(authOptions)`. In next-auth v4, `getServerSession` is a
 * **non-configurable, getter-only** named export, and in App-Router mode it reads
 * cookies through `next/headers`, which requires a live request scope that does
 * not exist inside `node:test`. On this repo's Node runtime `mock.module` is also
 * unavailable, so the auth wrapper cannot be faked to drive the HTTP handler
 * directly. (The repo's other route tests — e.g. `rds-execute-route.test.ts` —
 * make the same call and test the route's building blocks instead.)
 *
 * So we exercise the route's REAL data pipeline end to end, mocking only the
 * external boundaries:
 *
 *   - AWS SDK boundary (`STSClient.send` / `AthenaClient.send`) → canned CUR rows,
 *     so the REAL `fetchCurFullSnapshot` parses a real `CurFullSnapshot`. We make
 *     the EC2/byAccount/topResources queries return rows for accounts that were
 *     NOT requested (a "leaky" query) to prove the endpoint scrubs them.
 *   - `global.fetch` → the account-catalog Lambda payload, so the REAL
 *     `fetchAwsAccountCatalog` / `filterLiveAwsAccounts` / `buildAwsAccountNameMap`
 *     drive account resolution.
 *
 * `resolveCurDirect()` below is a faithful, comment-cross-referenced copy of the
 * GET handler's body (everything after the 400 guard): same `isExplicitScope`
 * predicate, same explicit-vs-live resolution, same `cached(...)` wrapper, same
 * `scopeSnapshotToAccounts(snapshot, accountIds)` call — built exclusively from
 * the SAME functions the route imports. It is the unit under test.
 *
 * Assertions (Task 4.4):
 *   1. With an explicit `accountIds` CSV, the response contains ONLY the requested
 *      accounts, even when a sub-query leaked rows from another account. (R2.2/1.4)
 *   2. With `accountIds` absent or `"all"`, resolution explicitly falls back to the
 *      live-account set (suspended accounts excluded), the Athena WHERE filter
 *      carries that live set, and the response contains only live accounts. (R1.4)
 *
 * Conventions: `node:test` + `node:assert/strict`, run with `tsx` (no network).
 *
 * _Requirements: 2.2, 1.4_
 */

import test, { before, afterEach } from "node:test";
import assert from "node:assert/strict";

import { AthenaClient } from "@aws-sdk/client-athena";
import { STSClient } from "@aws-sdk/client-sts";

import { fetchCurFullSnapshot, type CurFullSnapshot } from "../athena-cur";
import {
  buildAwsAccountNameMap,
  fetchAwsAccountCatalog,
  filterLiveAwsAccounts,
} from "../aws-account-catalog";
import { cached, cacheKey } from "../cache";
import { scopeSnapshotToAccounts } from "../finops-scope";

/* ------------------------------------------------------------------ */
/*  Fixture account set                                               */
/* ------------------------------------------------------------------ */

const ACC_A = "111111111111"; // live (ACTIVE), requested in test 1
const ACC_B = "222222222222"; // live (ACTIVE), NOT requested in test 1 (leaked)
const ACC_C = "333333333333"; // SUSPENDED → excluded from the org-wide live set

const ACCOUNT_NAMES: Record<string, string> = {
  [ACC_A]: "digital-prod",
  [ACC_B]: "retail-prod",
  [ACC_C]: "sandbox-old",
};

/* ------------------------------------------------------------------ */
/*  AWS SDK boundary mock — a deliberately "leaky" CUR                 */
/* ------------------------------------------------------------------ */

const realAthenaSend = AthenaClient.prototype.send;
const realStsSend = STSClient.prototype.send;

type Cells = string[];

/** The three account-bearing queries we drive with multi-account rows. */
const isByAccountSql = (sql: string) => /line_item_product_code AS service/.test(sql);
const isTopResourcesSql = (sql: string) => /MAX\(product_instance_type\) AS instance_type/.test(sql);
const isEc2FleetSql = (sql: string) =>
  /line_item_product_code = 'AmazonEC2'/.test(sql) &&
  /GROUP BY product_instance_type, line_item_usage_account_id/.test(sql);

/** Wrap canned rows in the Athena GetQueryResults shape (header + data rows). */
function resultSet(dataRows: Cells[]) {
  const header = { Data: [{ VarCharValue: "header" }] };
  const rows = [header, ...dataRows.map((cells) => ({ Data: cells.map((c) => ({ VarCharValue: c })) }))];
  return { ResultSet: { Rows: rows } };
}

interface MockState {
  submittedSqls: string[];
}

/**
 * Installs the SDK mocks. Regardless of the WHERE filter, the byAccount,
 * topResources and ec2Fleet queries return rows for ALL THREE accounts (A, B, C)
 * — i.e. a query that "forgot" or under-filtered its
 * `line_item_usage_account_id IN (...)`. Every other query returns no data rows,
 * so `fetchCurFullSnapshot` completes while the test stays focused on scoping.
 */
function installLeakyMocks(): MockState {
  const submittedSqls: string[] = [];
  const execToRows = new Map<string, Cells[]>();
  let counter = 0;

  STSClient.prototype.send = (async () => ({
    Credentials: {
      AccessKeyId: "AKIAEXAMPLE",
      SecretAccessKey: "secret",
      SessionToken: "token",
      Expiration: new Date(Date.now() + 3_600_000),
    },
  })) as typeof STSClient.prototype.send;

  AthenaClient.prototype.send = (async (command: any) => {
    const name = command?.constructor?.name;

    if (name === "StartQueryExecutionCommand") {
      const sql: string = command.input.QueryString;
      submittedSqls.push(sql);
      counter += 1;
      const execId = `exec-${counter}`;

      let rows: Cells[] = [];
      if (isByAccountSql(sql)) {
        // columns: [account_id, service, cost]
        rows = [
          [ACC_A, "AmazonEC2", "500"],
          [ACC_B, "AmazonRDS", "300"],
          [ACC_C, "AmazonS3", "100"],
        ];
      } else if (isTopResourcesSql(sql)) {
        // columns: [account_id, service, resource_id, cost, instance_type]
        rows = [
          [ACC_A, "AmazonEC2", "i-aaa", "250", "m5.large"],
          [ACC_B, "AmazonRDS", "db-bbb", "180", ""],
          [ACC_C, "AmazonS3", "bucket-ccc", "90", ""],
        ];
      } else if (isEc2FleetSql(sql)) {
        // columns: [instance_type, account_id, resources, cost]
        rows = [
          ["m5.large", ACC_A, "3", "250"],
          ["c5.xlarge", ACC_B, "2", "180"],
          ["t3.micro", ACC_C, "1", "20"],
        ];
      }

      execToRows.set(execId, rows);
      return { QueryExecutionId: execId };
    }

    if (name === "GetQueryExecutionCommand") {
      return { QueryExecution: { Status: { State: "SUCCEEDED" } } };
    }

    if (name === "GetQueryResultsCommand") {
      const execId: string = command.input.QueryExecutionId;
      return resultSet(execToRows.get(execId) ?? []);
    }

    throw new Error(`Unexpected Athena command in test: ${name}`);
  }) as typeof AthenaClient.prototype.send;

  return { submittedSqls };
}

/* ------------------------------------------------------------------ */
/*  Account-catalog Lambda mock (drives fetchAwsAccountCatalog)        */
/* ------------------------------------------------------------------ */

/** A→ACTIVE, B→ACTIVE, C→SUSPENDED. `filterLiveAwsAccounts` keeps A,B; drops C. */
function installCatalogFetch(): void {
  // Node 16 has no global fetch; define it unconditionally so the REAL
  // `fetchAwsAccountCatalog` resolves through this canned Lambda payload.
  (global as any).fetch = async () =>
    ({
      ok: true,
      status: 200,
      async json() {
        return {
          accounts: [
            { id: ACC_A, name: ACCOUNT_NAMES[ACC_A], status: "ACTIVE" },
            { id: ACC_B, name: ACCOUNT_NAMES[ACC_B], status: "ACTIVE" },
            { id: ACC_C, name: ACCOUNT_NAMES[ACC_C], status: "SUSPENDED" },
          ],
        };
      },
    }) as unknown as Response;
}

// Install at import time so the catalog fetch is available before any hook/test.
installCatalogFetch();

/* ------------------------------------------------------------------ */
/*  Faithful mirror of the GET handler body (after the 400 guard).     */
/*  Same predicate, same resolution, same cached() + scope() calls,    */
/*  built only from the functions the route imports.                   */
/* ------------------------------------------------------------------ */

const CACHE_TTL_MS = 10 * 60 * 1000;

async function resolveCurDirect(
  accountIdsParam: string | null,
  startDate: string,
  endDate: string,
): Promise<CurFullSnapshot> {
  // route: isExplicitScope = Boolean(accountIdsParam && accountIdsParam !== "all")
  const isExplicitScope = Boolean(accountIdsParam && accountIdsParam !== "all");

  // route: cacheKey("cur-direct", { startDate, endDate, accountIds: accountIdsParam || "all" })
  const key = cacheKey("cur-direct", {
    startDate,
    endDate,
    accountIds: accountIdsParam || "all",
  });

  return cached(
    key,
    async () => {
      const catalog = await fetchAwsAccountCatalog();
      const nameMap = buildAwsAccountNameMap(catalog);
      const liveAccounts = filterLiveAwsAccounts(catalog);

      const accountIds = isExplicitScope
        ? accountIdsParam!.split(",").map((id) => id.trim()).filter(Boolean)
        : liveAccounts.map((a) => a.id);

      const snapshot = await fetchCurFullSnapshot(accountIds, startDate, endDate, nameMap);

      // Defence-in-depth: even if a sub-query leaked out-of-scope rows, the
      // endpoint scrubs them before returning. Applied in BOTH paths.
      return scopeSnapshotToAccounts(snapshot, accountIds);
    },
    CACHE_TTL_MS,
  );
}

/** Collect every account id that appears anywhere account-bearing in a snapshot. */
function accountsPresent(snapshot: CurFullSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const r of snapshot.byAccount) ids.add(r.accountId);
  for (const r of snapshot.topResources) ids.add(r.accountId);
  for (const r of snapshot.ec2Fleet) ids.add(r.accountId);
  return ids;
}

/* ------------------------------------------------------------------ */
/*  Setup / teardown                                                  */
/* ------------------------------------------------------------------ */

before(async () => {
  // Seed the (module-cached) account catalog deterministically with OUR payload,
  // independent of anything other test files may have cached in the same process.
  installCatalogFetch();
  await fetchAwsAccountCatalog(true);
});

afterEach(() => {
  AthenaClient.prototype.send = realAthenaSend;
  STSClient.prototype.send = realStsSend;
});

/* ================================================================== */
/*  Test 1 — explicit accountIds: response contains ONLY those         */
/*  accounts even when a query leaked another one (R2.2, R1.4)         */
/* ================================================================== */

test("explicit accountIds scopes the response to exactly the requested account, dropping leaked accounts (R2.2, R1.4)", async () => {
  const { submittedSqls } = installLeakyMocks();

  // Caller asks for ONLY account A. The mocked CUR leaks rows for A, B and C.
  const snapshot = await resolveCurDirect(ACC_A, "2026-01-01", "2026-01-31");

  // The endpoint must return ONLY account A — B and C are scrubbed.
  const present = accountsPresent(snapshot);
  assert.deepEqual([...present].sort(), [ACC_A], "only the requested account may appear");

  assert.deepEqual(
    snapshot.byAccount.map((r) => r.accountId),
    [ACC_A],
    "byAccount must contain only the requested account",
  );
  assert.deepEqual(
    snapshot.topResources.map((r) => r.accountId),
    [ACC_A],
    "topResources must contain only the requested account",
  );
  assert.deepEqual(
    snapshot.ec2Fleet.map((r) => r.accountId),
    [ACC_A],
    "ec2Fleet must contain only the requested account",
  );

  // The leaked accounts are demonstrably gone.
  assert.ok(!present.has(ACC_B), "leaked account B must not appear");
  assert.ok(!present.has(ACC_C), "leaked account C must not appear");

  // Sanity: the Athena WHERE filter was scoped to the explicit account only.
  const byAccountSql = submittedSqls.find(isByAccountSql)!;
  assert.match(byAccountSql, /line_item_usage_account_id IN \(/);
  assert.ok(byAccountSql.includes(`'${ACC_A}'`), "explicit account must be in the IN(...) filter");
  assert.ok(!byAccountSql.includes(`'${ACC_B}'`), "non-requested account must not be in the filter");
});

/* ================================================================== */
/*  Test 2 — accountIds "all"/absent: explicit fallback to the live    */
/*  account set; suspended accounts excluded (R1.4)                    */
/* ================================================================== */

async function assertOrgWideFallback(accountIdsParam: string | null) {
  const { submittedSqls } = installLeakyMocks();

  // Distinct dates per param so each call gets its own cache key (no reuse).
  const start = accountIdsParam === null ? "2026-02-01" : "2026-03-01";
  const end = accountIdsParam === null ? "2026-02-28" : "2026-03-31";

  const snapshot = await resolveCurDirect(accountIdsParam, start, end);

  // Resolution falls back to the live account set: A and B are ACTIVE; C is
  // SUSPENDED and must be excluded from both the query filter and the response.
  const byAccountSql = submittedSqls.find(isByAccountSql)!;
  assert.match(byAccountSql, /line_item_usage_account_id IN \(/);
  assert.ok(byAccountSql.includes(`'${ACC_A}'`), "live account A must be in the IN(...) filter");
  assert.ok(byAccountSql.includes(`'${ACC_B}'`), "live account B must be in the IN(...) filter");
  assert.ok(!byAccountSql.includes(`'${ACC_C}'`), "suspended account C must NOT be in the filter");

  // The response contains the live accounts and never the suspended/leaked one.
  const present = accountsPresent(snapshot);
  assert.ok(present.has(ACC_A), "live account A must appear in the org-wide response");
  assert.ok(present.has(ACC_B), "live account B must appear in the org-wide response");
  assert.ok(!present.has(ACC_C), "suspended account C must not appear (even though the query leaked it)");
}

test('accountIds="all" resolves to the live account set and excludes suspended accounts (R1.4)', async () => {
  await assertOrgWideFallback("all");
});

test("absent accountIds resolves to the live account set (explicit org-wide fallback) (R1.4)", async () => {
  await assertOrgWideFallback(null);
});
