/**
 * Integration tests for DORA author scoping (spec: dora-author-scoping, task 4.4).
 *
 * These are example-based integration tests (node:test, run via `tsx --test`).
 * The database is MOCKED — no live PostgreSQL is required. `_getDoraCoreDashboardImpl`
 * issues many queries; on this repo's Node runtime `mock.module` is unavailable
 * (see `cur-direct-route.test.ts`), so we stub the singleton `pool.query`
 * (default export of `@/lib/db`) by reassigning it for the duration of each test
 * and restoring it afterwards.
 *
 * Mocking approach (as allowed by the task): a single SQL router stubs
 * `pool.query`. It returns canned `production_deployments ⋈ deployment_changes`
 * rows for the author-scope query (the only one that projects `dc.author_email`),
 * and EMPTY rows (`{ rows: [] }`) for every other query the impl issues. This
 * exercises the REAL `getDeploymentChangeRows` (its SQL, join and scoping) and
 * the REAL author-scope summary logic in `_getDoraCoreDashboardImpl`, while the
 * unrelated queries degrade gracefully to empty.
 *
 * Verified here (task 4.4):
 *   (a) `getDeploymentChangeRows` scopes by (date ∩ team ∩ project), uses
 *       `DATE(pd.deploy_completed_at)` and the `pd LEFT JOIN deployment_changes`
 *       join, and carries team/project params.
 *   (b) Under `authors=<alice>` the result changes: Deployment Frequency reflects
 *       the attributed count (deploy counted once), Lead Time is the median of the
 *       author's `first_commit` lead times, and an empty-author scenario yields
 *       `{ available: false }` for Lead Time and `0` for Deployment Frequency.
 *   (c) `summary.audit.checks` includes `author_attribution_coverage` when active.
 *
 * NOTE: task 4.5 appends a zero-regression test to THIS file; shared fixtures and
 * the `installPoolMock` helper below are structured for that append.
 *
 * _Requirements: 1.1, 1.3, 2.5, 6.2, 7.4_
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import pool from "../db";
import { invalidateCache } from "../cache";
import { getDoraCoreDashboard, type DashboardFilters } from "../metrics-dashboard";
import {
  resolveChangeAuthorKeys,
  type DeploymentChangeRow,
} from "../dora-author-scope";

/* ------------------------------------------------------------------ */
/*  Seeded production_deployments ⋈ deployment_changes fixture         */
/* ------------------------------------------------------------------ */

const ALICE = "alice@iskaypet.com";
const BOB = "bob@iskaypet.com";
const CAROL = "carol@iskaypet.com";

/**
 * Camel-case rows (the shape `getDeploymentChangeRows` returns after mapping).
 * `first_commit` lead time (hours) = (deployCompletedAt - mrFirstCommitAt) / 3600000.
 *
 * Deployment 1 (2026-05-10): Alice ×2 (10h, 20h) + Bob (5h, NOT in filter)
 * Deployment 2 (2026-05-11): Alice ×1 (30h)
 * Deployment 3 (2026-05-12): Carol ×1 (6h, NOT in filter)
 *
 * ⇒ Alice attributed deployments = 2; Alice lead times = [10, 20, 30] ⇒ median 20.
 */
const SEED_ROWS: DeploymentChangeRow[] = [
  {
    deploymentId: 1,
    deployDate: "2026-05-10",
    commitSha: "a1",
    commitCreatedAt: "2026-05-10T02:00:00.000Z",
    mrFirstCommitAt: "2026-05-10T02:00:00.000Z",
    deployCompletedAt: "2026-05-10T12:00:00.000Z", // 10h
    authorEmail: ALICE,
    authorUsername: null,
  },
  {
    deploymentId: 1,
    deployDate: "2026-05-10",
    commitSha: "a2",
    commitCreatedAt: "2026-05-09T16:00:00.000Z",
    mrFirstCommitAt: "2026-05-09T16:00:00.000Z",
    deployCompletedAt: "2026-05-10T12:00:00.000Z", // 20h
    authorEmail: ALICE,
    authorUsername: null,
  },
  {
    deploymentId: 1,
    deployDate: "2026-05-10",
    commitSha: "b1",
    commitCreatedAt: "2026-05-10T07:00:00.000Z",
    mrFirstCommitAt: "2026-05-10T07:00:00.000Z",
    deployCompletedAt: "2026-05-10T12:00:00.000Z", // 5h (Bob)
    authorEmail: BOB,
    authorUsername: null,
  },
  {
    deploymentId: 2,
    deployDate: "2026-05-11",
    commitSha: "a3",
    commitCreatedAt: "2026-05-10T06:00:00.000Z",
    mrFirstCommitAt: "2026-05-10T06:00:00.000Z",
    deployCompletedAt: "2026-05-11T12:00:00.000Z", // 30h
    authorEmail: ALICE,
    authorUsername: null,
  },
  {
    deploymentId: 3,
    deployDate: "2026-05-12",
    commitSha: "c1",
    commitCreatedAt: "2026-05-12T06:00:00.000Z",
    mrFirstCommitAt: "2026-05-12T06:00:00.000Z",
    deployCompletedAt: "2026-05-12T12:00:00.000Z", // 6h (Carol)
    authorEmail: CAROL,
    authorUsername: null,
  },
];

/** The DB-row shape `getDeploymentChangeRows` SELECTs (snake_case). */
function toDbRow(r: DeploymentChangeRow) {
  return {
    deployment_id: r.deploymentId,
    deploy_date: r.deployDate,
    commit_sha: r.commitSha,
    commit_created_at: r.commitCreatedAt,
    mr_first_commit_at: r.mrFirstCommitAt,
    deploy_completed_at: r.deployCompletedAt,
    author_email: r.authorEmail,
  };
}

/** Resolve a seeded author's canonical key the SAME way the impl does. */
function canonicalKeyFor(email: string): string {
  const keyByRow = resolveChangeAuthorKeys(SEED_ROWS);
  for (const [row, key] of keyByRow) {
    if (row.authorEmail === email && key) return key;
  }
  throw new Error(`No canonical key resolved for ${email}`);
}

const ALICE_KEY = canonicalKeyFor(ALICE);

/* ------------------------------------------------------------------ */
/*  pool.query mock — SQL router                                       */
/* ------------------------------------------------------------------ */

type Captured = { text: string; params: unknown[] };

/** Is this the author-scope query? It is the only one projecting dc.author_email. */
function isAuthorScopeQuery(text: string): boolean {
  return (
    text.includes("dc.author_email AS author_email") &&
    text.includes("LEFT JOIN deployment_changes dc")
  );
}

/**
 * Install a stub on the singleton `pool.query`. Returns the captured-calls array
 * and a restore function. By default every query yields `{ rows: [] }`; the
 * author-scope query yields the seeded rows.
 */
function installPoolMock(rows = SEED_ROWS) {
  const calls: Captured[] = [];
  const realQuery = pool.query;
  const dbRows = rows.map(toDbRow);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).query = async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    if (isAuthorScopeQuery(text)) {
      return { rows: dbRows };
    }
    return { rows: [] };
  };

  const restore = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = realQuery;
  };

  return { calls, restore };
}

function makeFilters(overrides: Partial<DashboardFilters> = {}): DashboardFilters {
  return {
    teams: [],
    projectIds: [],
    developers: [],
    days: 30,
    authors: [],
    sonarProjectKeys: [],
    sonarScope: "none",
    ...overrides,
  };
}

afterEach(() => {
  invalidateCache(); // never serve a cached scope across tests
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

test("getDeploymentChangeRows scopes by (date ∩ team ∩ project) with DATE() and the deployment_changes join", async () => {
  const { calls, restore } = installPoolMock();
  try {
    await getDoraCoreDashboard(
      makeFilters({ teams: ["oms"], projectIds: [123], authors: [ALICE_KEY] }),
      { includeClusterSignals: false }
    );
  } finally {
    restore();
  }

  const authorQuery = calls.find((c) => isAuthorScopeQuery(c.text));
  assert.ok(authorQuery, "the author-scope query must be issued under an author filter");

  // Join + correct deploy date column.
  assert.match(authorQuery.text, /FROM production_deployments pd/);
  assert.match(authorQuery.text, /LEFT JOIN deployment_changes dc\s+ON dc\.deployment_id = pd\.id/);
  assert.match(authorQuery.text, /DATE\(pd\.deploy_completed_at\)/);

  // Same scope conditions as the canonical DORA rows.
  assert.match(authorQuery.text, /pd\.source = 'gitlab'/);
  assert.match(authorQuery.text, /pd\.status = 'success'/);
  assert.match(authorQuery.text, /pd\.deploy_completed_at >= \$1::date/);

  // Date ∩ team ∩ project carried as params.
  const flat = authorQuery.params.flat();
  assert.ok(flat.includes("oms"), "team filter must be in the params");
  assert.ok(flat.includes(123), "projectIds filter must be in the params");
});

test("under an author filter, Deployment Frequency is the attributed count (deploy counted once) and Lead Time is the median", async () => {
  const { restore } = installPoolMock();
  let result: Awaited<ReturnType<typeof getDoraCoreDashboard>>;
  try {
    result = await getDoraCoreDashboard(
      makeFilters({ teams: ["oms"], projectIds: [123], authors: [ALICE_KEY] }),
      { includeClusterSignals: false }
    );
  } finally {
    restore();
  }

  const { summary } = result;

  // Author scope is active and reflects the applied filter.
  assert.equal(summary.authorScope.active, true);
  assert.ok(
    summary.authorScope.authors.some((a: { key: string }) => a.key === ALICE_KEY),
    "the applied author must appear in summary.authorScope.authors"
  );

  // Deployment Frequency: Alice has changes in deployments 1 and 2 ⇒ 2 (counted once).
  assert.equal(summary.deploymentFrequency.current, 2);

  // Lead Time: median of Alice's first_commit lead times [10, 20, 30] ⇒ 20.
  assert.ok(!("available" in summary.leadTimeForChanges), "Lead Time must be available");
  assert.ok(
    Math.abs((summary.leadTimeForChanges as { current: number }).current - 20) <= 0.01,
    `Lead Time median should be ~20h, got ${(summary.leadTimeForChanges as { current: number }).current}`
  );

  // CFR and Pipeline Recovery Time are flagged deployment-level under an author filter.
  assert.equal(summary.deploymentLevel.changeFailureRate, true);
  assert.equal(summary.deploymentLevel.pipelineRecoveryTime, true);
});

test("summary.audit includes the author_attribution_coverage check under an author filter", async () => {
  const { restore } = installPoolMock();
  let result: Awaited<ReturnType<typeof getDoraCoreDashboard>>;
  try {
    result = await getDoraCoreDashboard(
      makeFilters({ authors: [ALICE_KEY] }),
      { includeClusterSignals: false }
    );
  } finally {
    restore();
  }

  const check = result.summary.audit.checks.find(
    (c: { key: string }) => c.key === "author_attribution_coverage"
  );
  assert.ok(check, "author_attribution_coverage check must be present");
  // All 3 seeded deployments resolve to an identity ⇒ 100% coverage ⇒ pass.
  assert.equal(check.status, "pass");
  assert.equal(check.value, "100.0%");

  // Coverage surfaced on the author scope too.
  assert.equal(result.summary.authorScope.attributionCoverage, 100);
  assert.equal(result.summary.authorScope.attributionCoverageThreshold, 80.0);
});

test("empty-author scenario: no attributable activity ⇒ DF is exactly 0 and Lead Time is { available: false }", async () => {
  const { restore } = installPoolMock();
  let result: Awaited<ReturnType<typeof getDoraCoreDashboard>>;
  try {
    // A canonical key that matches none of the seeded authors.
    result = await getDoraCoreDashboard(
      makeFilters({ teams: ["oms"], authors: ["ghost@nowhere.local"] }),
      { includeClusterSignals: false }
    );
  } finally {
    restore();
  }

  const { summary } = result;

  assert.equal(summary.authorScope.active, true);

  // Deployment Frequency: exactly zero (not inherited from the no-author scope).
  assert.equal(summary.deploymentFrequency.current, 0);

  // Lead Time: explicit "not available", distinct from numeric zero.
  assert.deepEqual(summary.leadTimeForChanges, { available: false });
});

/* ------------------------------------------------------------------ */
/*  Task 4.5 — Zero-regression tests (authors=[] ⇒ identical)          */
/*                                                                     */
/*  Requirements 9.1, 9.2, 9.3, 9.5: with an empty Author_Filter the   */
/*  DORA result must be IDENTICAL to behavior without the author       */
/*  dimension — no scoping is activated, every metric is the plain     */
/*  TrendMetric (never overridden to { available: false }), and the    */
/*  cache key is stable (an empty filter is a constant sub-key, so a    */
/*  second identical call is served from cache without re-querying).   */
/* ------------------------------------------------------------------ */

import { cacheKey } from "../cache";
import { authorsCacheKeyPart, normalizeAuthorFilter } from "../dora-author-scope";

/** The four DORA metrics whose zero-regression we assert. */
function doraMetrics(summary: {
  deploymentFrequency: unknown;
  leadTimeForChanges: unknown;
  changeFailureRate: unknown;
  mttr: unknown;
}) {
  return {
    deploymentFrequency: summary.deploymentFrequency,
    leadTimeForChanges: summary.leadTimeForChanges,
    changeFailureRate: summary.changeFailureRate,
    mttr: summary.mttr,
  };
}

/** A value is a plain TrendMetric (NOT a `{ available: false }` override). */
function isPlainTrendMetric(v: unknown): v is { current: number; previous: number; change: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    !("available" in v) &&
    typeof (v as { current?: unknown }).current === "number"
  );
}

test("zero regression: authors=[] does NOT activate author scoping and leaves every metric as a plain TrendMetric", async () => {
  const { restore } = installPoolMock();
  let result: Awaited<ReturnType<typeof getDoraCoreDashboard>>;
  try {
    result = await getDoraCoreDashboard(
      makeFilters({ teams: ["oms"], projectIds: [123], authors: [] }),
      { includeClusterSignals: false }
    );
  } finally {
    restore();
  }

  const { summary } = result;

  // (a) Author scope inactive; deployment-level flags both false; no coverage check.
  assert.equal(summary.authorScope.active, false);
  assert.deepEqual(summary.authorScope.authors, []);
  assert.equal(summary.authorScope.attributionCoverage, null);
  assert.equal(summary.deploymentLevel.changeFailureRate, false);
  assert.equal(summary.deploymentLevel.pipelineRecoveryTime, false);
  assert.equal(
    summary.audit.checks.some((c: { key: string }) => c.key === "author_attribution_coverage"),
    false,
    "author_attribution_coverage must be ABSENT when there is no author filter"
  );

  // (b) The author scoping overrode nothing: DF / Lead Time / CFR / Recovery are
  //     plain TrendMetrics (never the author-scope `{ available: false }`).
  assert.ok(isPlainTrendMetric(summary.deploymentFrequency), "DF must be a plain TrendMetric");
  assert.ok(isPlainTrendMetric(summary.leadTimeForChanges), "Lead Time must be a plain TrendMetric");
  assert.ok(isPlainTrendMetric(summary.changeFailureRate), "CFR must be a plain TrendMetric");
  assert.ok(isPlainTrendMetric(summary.mttr), "Recovery Time must be a plain TrendMetric");

  // DF is an exact integer count.
  assert.ok(
    Number.isInteger((summary.deploymentFrequency as { current: number }).current),
    "DF current must be an integer count"
  );
});

test("zero regression: an empty filter and a whitespace-only filter produce IDENTICAL metrics and share the same cache entry", async () => {
  // Both filters normalize to the empty Author_Filter, so they must (1) yield the
  // same integer DF and the same Lead Time / CFR / Recovery (|Δ| ≤ 0.01, empty
  // stays empty) and (2) resolve to the SAME cache key — the second call is a
  // cache hit and issues NO new queries.
  const { calls, restore } = installPoolMock();
  try {
    const reference = await getDoraCoreDashboard(
      makeFilters({ teams: ["oms"], projectIds: [123], authors: [] }),
      { includeClusterSignals: false }
    );
    const callsAfterFirst = calls.length;
    assert.ok(callsAfterFirst > 0, "the first call must issue queries");

    // Whitespace-only authors normalize to the empty filter ⇒ same key ⇒ cache hit.
    const compared = await getDoraCoreDashboard(
      makeFilters({ teams: ["oms"], projectIds: [123], authors: ["", "   "] }),
      { includeClusterSignals: false }
    );

    assert.equal(
      calls.length,
      callsAfterFirst,
      "an equivalent empty-author call must be served from cache (no new queries) ⇒ stable cache key"
    );

    // Same integer DF; identical Lead Time / CFR / Recovery (empty stays empty).
    assert.deepEqual(doraMetrics(compared.summary), doraMetrics(reference.summary));
    assert.equal(
      (compared.summary.deploymentFrequency as { current: number }).current,
      (reference.summary.deploymentFrequency as { current: number }).current
    );
  } finally {
    restore();
  }
});

test("zero regression: a non-empty author filter produces a DIFFERENT cache key (re-issues queries)", async () => {
  const { calls, restore } = installPoolMock();
  try {
    await getDoraCoreDashboard(
      makeFilters({ teams: ["oms"], projectIds: [123], authors: [] }),
      { includeClusterSignals: false }
    );
    const callsAfterEmpty = calls.length;

    // Different author set ⇒ different key ⇒ cache miss ⇒ new queries are issued.
    await getDoraCoreDashboard(
      makeFilters({ teams: ["oms"], projectIds: [123], authors: [ALICE_KEY] }),
      { includeClusterSignals: false }
    );

    assert.ok(
      calls.length > callsAfterEmpty,
      "a non-empty author filter must NOT collide with the empty-filter cache entry"
    );
  } finally {
    restore();
  }
});

test("zero regression (cache key, pure): empty author filter is a constant sub-key distinct from a non-empty one", () => {
  // The empty filter collapses to a constant, order/representation-insensitive part.
  assert.deepEqual(authorsCacheKeyPart([]), []);
  assert.deepEqual(authorsCacheKeyPart(["", "  "]), []);
  assert.equal(normalizeAuthorFilter([]).size, 0);

  const base = {
    days: 30,
    from: null,
    to: null,
    teams: ["oms"],
    projectIds: [123],
    includeClusterSignals: false,
  };

  // Two empty-author representations ⇒ identical key (same as "no author dimension").
  const keyEmpty = cacheKey("dora-core", { ...base, authors: authorsCacheKeyPart([]) });
  const keyWhitespace = cacheKey("dora-core", { ...base, authors: authorsCacheKeyPart(["", "  "]) });
  assert.equal(keyEmpty, keyWhitespace);

  // A non-empty author filter ⇒ a distinct key.
  const keyAuthor = cacheKey("dora-core", { ...base, authors: authorsCacheKeyPart([ALICE_KEY]) });
  assert.notEqual(keyEmpty, keyAuthor);
});
