/**
 * Unit tests for Iskay's grounding helpers.
 *
 * Feature: iskay-finops-specialist — task 8 (Tests unitarios de helpers de
 * grounding).
 *
 * Covers:
 *  - `prettyServiceName` (R14.1): translation of opaque CUR ids to friendly
 *    labels (`cg…` → "Marketplace (contrato)", inference-profile-style ids →
 *    "Bedrock (GenAI)") and pass-through of normal AWS service names.
 *  - `defaultCurWindow` (R14.2): default-window logic used by `getCurDeep`
 *    when the caller omits dates — month-to-date in UTC, padded.
 *  - `resolveAccountIds` (R14.2): cleans/filters caller-provided ids, and
 *    falls back to the live AWS account catalog when no ids are supplied.
 *
 * No Athena / CUR / Postgres / network calls are made: catalog deps are
 * injected through the public `ResolveAccountIdsDeps` seam exposed by
 * `finops-tools.ts`, matching the pattern used in `finops-report.test.ts`
 * and `deploy-notify.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  prettyServiceName,
  defaultCurWindow,
  resolveAccountIds,
} from "../finops-tools";
import type { AwsAccountCatalogEntry } from "../aws-account-catalog";

/* ------------------------------------------------------------------ */
/*  prettyServiceName (R14.1)                                          */
/* ------------------------------------------------------------------ */

test("prettyServiceName: cg* product codes → 'Marketplace (contrato)'", () => {
  assert.equal(prettyServiceName("cg2zxabcdefghijk"), "Marketplace (contrato)");
  // Case-insensitive on the prefix.
  assert.equal(prettyServiceName("CGABCDEFGHIJ123"), "Marketplace (contrato)");
  // Mixed case is still rewritten.
  assert.equal(prettyServiceName("CgX1y2z3w4v5b6"), "Marketplace (contrato)");
});

test("prettyServiceName: inference-profile-style opaque ids → 'Bedrock (GenAI)'", () => {
  // 22-char alphanumeric, not starting with amazon/aws.
  assert.equal(
    prettyServiceName("abcdef0123456789abcdef"),
    "Bedrock (GenAI)",
  );
  // 30-char alphanumeric, mixed case, not starting with amazon/aws.
  assert.equal(
    prettyServiceName("ABcd0123456789ZYxw0123456789QQ"),
    "Bedrock (GenAI)",
  );
});

test("prettyServiceName: normal AWS service names pass through unchanged", () => {
  assert.equal(
    prettyServiceName("Amazon Elastic Compute Cloud - Compute"),
    "Amazon Elastic Compute Cloud - Compute",
  );
  assert.equal(prettyServiceName("AWS Lambda"), "AWS Lambda");
  assert.equal(prettyServiceName("Amazon CloudWatch"), "Amazon CloudWatch");
  assert.equal(prettyServiceName("Amazon Simple Storage Service"), "Amazon Simple Storage Service");
  // Hyphenated/short codes shouldn't be misclassified as opaque ids.
  assert.equal(prettyServiceName("EC2 - Other"), "EC2 - Other");
  assert.equal(prettyServiceName("AmazonCloudWatch"), "AmazonCloudWatch");
});

test("prettyServiceName: amazon*/aws* prefixes never collapse into 'Bedrock (GenAI)'", () => {
  // Long alphanumeric WITH amazon/aws prefix → must keep the original name,
  // even if the length would otherwise match the opaque-id regex.
  assert.equal(
    prettyServiceName("amazoncloudfrontdistribution001"),
    "amazoncloudfrontdistribution001",
  );
  assert.equal(
    prettyServiceName("AWS00000000000000000000"),
    "AWS00000000000000000000",
  );
});

test("prettyServiceName: empty / whitespace input → 'Otros'", () => {
  assert.equal(prettyServiceName(""), "Otros");
  assert.equal(prettyServiceName("   "), "Otros");
  // null/undefined defended through String() coercion in the helper.
  assert.equal(prettyServiceName(null as unknown as string), "Otros");
  assert.equal(prettyServiceName(undefined as unknown as string), "Otros");
});

test("prettyServiceName: cg* code shorter than 12 chars is NOT treated as marketplace", () => {
  // The regex requires 10+ alphanumeric chars after `cg`, so `cg123` stays as-is.
  assert.equal(prettyServiceName("cg123"), "cg123");
});

/* ------------------------------------------------------------------ */
/*  defaultCurWindow (R14.2 — default month-to-date window)            */
/* ------------------------------------------------------------------ */

test("defaultCurWindow: returns first day of UTC month and the given UTC date", () => {
  const now = new Date("2026-05-15T13:00:00Z");
  assert.deepEqual(defaultCurWindow(now), {
    startDate: "2026-05-01",
    endDate: "2026-05-15",
  });
});

test("defaultCurWindow: pads single-digit month and day to two characters", () => {
  const now = new Date("2026-01-05T00:00:00Z");
  assert.deepEqual(defaultCurWindow(now), {
    startDate: "2026-01-01",
    endDate: "2026-01-05",
  });
});

test("defaultCurWindow: works on the first of the month (start === end)", () => {
  const now = new Date("2026-07-01T08:30:00Z");
  assert.deepEqual(defaultCurWindow(now), {
    startDate: "2026-07-01",
    endDate: "2026-07-01",
  });
});

test("defaultCurWindow: handles end-of-year boundary cleanly", () => {
  const now = new Date("2026-12-31T23:59:59Z");
  assert.deepEqual(defaultCurWindow(now), {
    startDate: "2026-12-01",
    endDate: "2026-12-31",
  });
});

test("defaultCurWindow: uses UTC, not local TZ (DST guard)", () => {
  // 2026-03-29 02:30 Madrid is the spring-forward DST moment in Europe;
  // the helper must use UTC fields and stay on 2026-03-29.
  const now = new Date("2026-03-29T00:30:00Z");
  assert.deepEqual(defaultCurWindow(now), {
    startDate: "2026-03-01",
    endDate: "2026-03-29",
  });
});

/* ------------------------------------------------------------------ */
/*  resolveAccountIds (R14.2 — accountIds resolution)                  */
/* ------------------------------------------------------------------ */

/** Builds a deterministic catalog so the tests don't reach the live Lambda. */
function fakeCatalog(): AwsAccountCatalogEntry[] {
  return [
    { id: "111111111111", name: "digital-prod", status: "ACTIVE", source: "organizations" },
    { id: "222222222222", name: "retail-prod", status: "ACTIVE", source: "organizations" },
    // Static fallback entry — counted as live.
    { id: "333333333333", name: "tooling", status: "STATIC", source: "static" },
    // Suspended account — must be filtered OUT.
    { id: "444444444444", name: "old-suspended", status: "SUSPENDED", source: "organizations" },
    // Pending closure — also non-live.
    { id: "555555555555", name: "pending-closure", status: "PENDING_CLOSURE", source: "organizations" },
  ];
}

test("resolveAccountIds: caller-provided ids are trimmed and returned in order", async () => {
  const ids = await resolveAccountIds(
    [" 111111111111 ", "222222222222"],
    // Catalog must NOT be consulted when explicit ids are passed; throw if it is.
    {
      fetchAwsAccountCatalog: async () => {
        throw new Error("catalog must not be called when ids are provided");
      },
    },
  );
  assert.deepEqual(ids, ["111111111111", "222222222222"]);
});

test("resolveAccountIds: drops non-numeric and short ids from caller input", async () => {
  const ids = await resolveAccountIds(["abc", "12345", "999999999999", "  "], {
    fetchAwsAccountCatalog: async () => {
      throw new Error("catalog must not be called when ids are provided");
    },
  });
  // Only the 12-digit id survives; the 5-digit one is dropped (regex requires 6+).
  assert.deepEqual(ids, ["999999999999"]);
});

test("resolveAccountIds: undefined input → live catalog accounts (active + static)", async () => {
  const calls: number[] = [];
  const ids = await resolveAccountIds(undefined, {
    fetchAwsAccountCatalog: async () => {
      calls.push(Date.now());
      return fakeCatalog();
    },
    // Use the real `filterLiveAwsAccounts` semantics via a faithful copy so the
    // test stays fully deterministic without importing a private helper.
    filterLiveAwsAccounts: (accounts) =>
      accounts.filter((a) => {
        const s = String(a.status || "").toUpperCase();
        return s === "ACTIVE" || s === "STATIC" || s === "";
      }),
  });

  assert.equal(calls.length, 1, "catalog must be fetched exactly once");
  assert.deepEqual(ids.sort(), ["111111111111", "222222222222", "333333333333"]);
});

test("resolveAccountIds: null input → catalog path used", async () => {
  const ids = await resolveAccountIds(null, {
    fetchAwsAccountCatalog: async () => fakeCatalog(),
    filterLiveAwsAccounts: (accounts) =>
      accounts.filter((a) => {
        const s = String(a.status || "").toUpperCase();
        return s === "ACTIVE" || s === "STATIC" || s === "";
      }),
  });
  assert.deepEqual(ids.sort(), ["111111111111", "222222222222", "333333333333"]);
});

test("resolveAccountIds: empty array → catalog path used (treated as missing)", async () => {
  const ids = await resolveAccountIds([], {
    fetchAwsAccountCatalog: async () => fakeCatalog(),
    filterLiveAwsAccounts: (accounts) =>
      accounts.filter((a) => {
        const s = String(a.status || "").toUpperCase();
        return s === "ACTIVE" || s === "STATIC" || s === "";
      }),
  });
  assert.deepEqual(ids.sort(), ["111111111111", "222222222222", "333333333333"]);
});

test("resolveAccountIds: catalog path filters out SUSPENDED / PENDING_CLOSURE accounts", async () => {
  const ids = await resolveAccountIds(undefined, {
    fetchAwsAccountCatalog: async () => fakeCatalog(),
    filterLiveAwsAccounts: (accounts) =>
      accounts.filter((a) => {
        const s = String(a.status || "").toUpperCase();
        return s === "ACTIVE" || s === "STATIC" || s === "";
      }),
  });
  assert.ok(!ids.includes("444444444444"), "suspended account leaked into resolved set");
  assert.ok(!ids.includes("555555555555"), "pending-closure account leaked into resolved set");
});
