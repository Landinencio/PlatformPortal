/**
 * Integration tests for the `ec2Fleet` CUR query (Athena mocked).
 *
 * Feature: finops-cost-comparison-explorer — Task 4.2.
 *
 * `fetchCurFullSnapshot` in `src/lib/athena-cur.ts` reaches Athena through a
 * chain of AWS SDK calls: STS AssumeRole → AthenaClient
 * (StartQueryExecution → GetQueryExecution → GetQueryResults). We cannot hit
 * real AWS, so we mock at the SDK boundary by replacing `send` on both the
 * `STSClient` and `AthenaClient` prototypes:
 *
 *   - `STSClient.send`  → returns fake Credentials.
 *   - `AthenaClient.send` branches on the command constructor name:
 *       · StartQueryExecutionCommand → captures the submitted SQL and hands
 *         back a QueryExecutionId (mapped to canned rows for the ec2Fleet
 *         query, empty for the other ~22 queries so the function completes).
 *       · GetQueryExecutionCommand   → SUCCEEDED.
 *       · GetQueryResultsCommand     → header row + canned data rows.
 *
 * Assertions (Task 4.2):
 *   1. The ec2Fleet SQL groups by instance type + account
 *      (`GROUP BY product_instance_type, line_item_usage_account_id`) and
 *      filters by `line_item_usage_account_id IN (...)` with the requested ids.
 *   2. The resulting `snapshot.ec2Fleet` rows carry `accountId`/`accountName`
 *      (name resolved via the `accountNameMap` argument).
 *
 * Conventions: `node:test` + `node:assert/strict`, run with `tsx` (no network).
 *
 * _Requirements: 1.3, 2.2_
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { AthenaClient } from "@aws-sdk/client-athena";
import { STSClient } from "@aws-sdk/client-sts";

import { fetchCurFullSnapshot } from "../athena-cur";

/* ------------------------------------------------------------------ */
/*  AWS SDK boundary mock                                              */
/* ------------------------------------------------------------------ */

const realAthenaSend = AthenaClient.prototype.send;
const realStsSend = STSClient.prototype.send;

/** Canned ec2Fleet rows — column order matches the executeQuery projection
 *  ["instance_type", "account_id", "resources", "cost"]. */
type Cells = string[];

interface MockSetup {
  /** Every SQL submitted via StartQueryExecutionCommand, in submission order. */
  submittedSqls: string[];
}

/**
 * Detects the ec2Fleet query: it is the only one filtering specifically on
 * `line_item_product_code = 'AmazonEC2'` AND grouping by instance type + account.
 */
function isEc2FleetSql(sql: string): boolean {
  return (
    /line_item_product_code = 'AmazonEC2'/.test(sql) &&
    /GROUP BY product_instance_type, line_item_usage_account_id/.test(sql)
  );
}

/** Wraps canned cell rows into the Athena GetQueryResults shape (header + data). */
function resultSet(dataRows: Cells[]) {
  const header = { Data: [{ VarCharValue: "header" }] };
  const rows = [
    header,
    ...dataRows.map((cells) => ({ Data: cells.map((c) => ({ VarCharValue: c })) })),
  ];
  return { ResultSet: { Rows: rows } };
}

/**
 * Installs the SDK mocks. `ec2FleetRows` are returned for the ec2Fleet query;
 * all other queries return zero data rows so `fetchCurFullSnapshot` completes
 * without error while keeping the test focused on ec2Fleet.
 */
function installMocks(ec2FleetRows: Cells[]): MockSetup {
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
      execToRows.set(execId, isEc2FleetSql(sql) ? ec2FleetRows : []);
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

afterEach(() => {
  AthenaClient.prototype.send = realAthenaSend;
  STSClient.prototype.send = realStsSend;
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

const ACCOUNT_IDS = ["111111111111", "222222222222"];
const ACCOUNT_NAME_MAP: Record<string, string> = {
  "111111111111": "digital-prod",
  "222222222222": "retail-prod",
};

test("ec2Fleet SQL groups by instance type + account and filters by selected accounts (Req 1.3, 2.2)", async () => {
  const { submittedSqls } = installMocks([]);

  await fetchCurFullSnapshot(ACCOUNT_IDS, "2026-05-01", "2026-05-31", ACCOUNT_NAME_MAP);

  const ec2Sql = submittedSqls.find(isEc2FleetSql);
  assert.ok(ec2Sql, "the ec2Fleet query must have been submitted to Athena");

  // (1) groups by instance type + account
  assert.match(ec2Sql!, /GROUP BY product_instance_type, line_item_usage_account_id/);
  // ...and the account dimension is part of the projected row (so it is verifiable)
  assert.match(ec2Sql!, /line_item_usage_account_id AS account_id/);

  // (2) filters by the selected account set
  assert.match(ec2Sql!, /line_item_usage_account_id IN \(/);
  assert.ok(ec2Sql!.includes("'111111111111'"), "requested account 1 must be in the IN(...) filter");
  assert.ok(ec2Sql!.includes("'222222222222'"), "requested account 2 must be in the IN(...) filter");
});

test("ec2Fleet rows include accountId and accountName resolved via accountNameMap (Req 1.3, 2.2)", async () => {
  // ec2Fleet column order: [instance_type, account_id, resources, cost]
  installMocks([
    ["m5.large", "111111111111", "3", "120.50"],
    ["c5.xlarge", "222222222222", "2", "80"],
  ]);

  const snapshot = await fetchCurFullSnapshot(
    ACCOUNT_IDS,
    "2026-05-01",
    "2026-05-31",
    ACCOUNT_NAME_MAP,
  );

  assert.equal(snapshot.ec2Fleet.length, 2);

  const m5 = snapshot.ec2Fleet.find((e) => e.instanceType === "m5.large");
  assert.ok(m5, "m5.large entry must be present");
  assert.equal(m5!.accountId, "111111111111");
  assert.equal(m5!.accountName, "digital-prod"); // resolved via accountNameMap
  assert.equal(m5!.resourceCount, 3);
  assert.equal(m5!.cost, 120.5);

  const c5 = snapshot.ec2Fleet.find((e) => e.instanceType === "c5.xlarge");
  assert.ok(c5, "c5.xlarge entry must be present");
  assert.equal(c5!.accountId, "222222222222");
  assert.equal(c5!.accountName, "retail-prod"); // resolved via accountNameMap
  assert.equal(c5!.resourceCount, 2);
  assert.equal(c5!.cost, 80);

  // Every ec2Fleet row is account-attributable to a selected account.
  const selected = new Set(ACCOUNT_IDS);
  for (const entry of snapshot.ec2Fleet) {
    assert.ok(selected.has(entry.accountId), `ec2Fleet row out of scope: ${entry.accountId}`);
  }
});

test("ec2Fleet accountName falls back to the account id when not in accountNameMap (Req 2.2)", async () => {
  installMocks([["t3.micro", "333333333333", "1", "10"]]);

  // Note: 333333333333 is intentionally absent from the name map.
  const snapshot = await fetchCurFullSnapshot(
    ["333333333333"],
    "2026-05-01",
    "2026-05-31",
    {},
  );

  assert.equal(snapshot.ec2Fleet.length, 1);
  assert.equal(snapshot.ec2Fleet[0].accountId, "333333333333");
  assert.equal(snapshot.ec2Fleet[0].accountName, "333333333333");
});
