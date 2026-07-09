// Feature: ai-portal-explorer — unit tests for the persistence layer (Report_Store).
/**
 * Unit tests for src/lib/explorer/report-store.ts.
 *
 * Feature: ai-portal-explorer (task 12.4)
 *
 * Every Report_Store function accepts an optional `db: Queryable` param that
 * defaults to the real `pool`. These tests inject a MOCK Queryable (an object
 * with an async `query(text, params)` method that records calls and returns
 * canned `{ rows, rowCount }`), so NO real database is touched.
 *
 * Covered behaviours:
 *  - createRun issues an idempotent INSERT ... ON CONFLICT in state 'running'.
 *  - persistVisitResult does NOT throw on a per-row failure: it returns `false`
 *    and the caller can keep going, so a single visit_result failure does not
 *    discard the already-persisted ones (Req 10.5).
 *  - updateRunTerminal sets finished_at/status/summary with the right params.
 *  - persistAnomaly / persistTriageResults upsert with equivalence_key and
 *    is_regression.
 *  - loadPreviousRunTriage returns the prior completed run's triage rows mapped
 *    to TriageResult, or null when there is no comparable prior run (Req 7.7).
 *  - loadRun maps a row to ExplorationRun, or null when missing.
 *
 * **Validates: Requirements 7.7, 10.5**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/report-store.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createRun,
  updateRunTerminal,
  persistVisitResult,
  persistAnomaly,
  persistTriageResults,
  loadPreviousRunTriage,
  loadRun,
} from "../report-store";
import type { Queryable } from "../report-store";
import type {
  Anomaly,
  Route,
  TriageResult,
  VisitResult,
} from "../types";

/* ------------------------------------------------------------------ */
/*  Mock Queryable                                                     */
/* ------------------------------------------------------------------ */

interface RecordedCall {
  text: string;
  params: unknown[] | undefined;
}

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number | null };

type Responder = (
  text: string,
  params: unknown[] | undefined,
  callIndex: number,
) => QueryResult | Promise<QueryResult>;

/**
 * Builds a mock Queryable that records every call (sql + params) so assertions
 * can inspect them. The optional `responder` returns a canned `{ rows, rowCount }`
 * (or rejects, to simulate a per-row failure) per call.
 */
function createMockDb(responder?: Responder): {
  db: Queryable;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const db: Queryable = {
    async query<R extends Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: R[]; rowCount: number | null }> {
      const callIndex = calls.length;
      calls.push({ text, params });
      const result = responder
        ? await responder(text, params, callIndex)
        : { rows: [], rowCount: 0 };
      return result as { rows: R[]; rowCount: number | null };
    },
  };
  return { db, calls };
}

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const route: Route = {
  id: "r1",
  kind: "ui",
  path: "/metrics",
  section: "metrics",
};

function makeVisit(overrides: Partial<VisitResult> = {}): VisitResult {
  return {
    runId: "run-1",
    scenarioId: "scn-1",
    route,
    role: "admin",
    params: { team: "digital" },
    httpStatus: 200,
    latencyMs: 120,
    timedOut: false,
    consoleErrors: [],
    failedRequests: [],
    domErrorStates: [],
    dataSignal: null,
    screenshotRef: null,
    accessObserved: "granted",
    ...overrides,
  };
}

function makeAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    anomalyId: "an-1",
    runId: "run-1",
    route,
    role: "desarrolladores",
    scenarioId: "scn-1",
    category: "console-error",
    detector: "deterministic",
    evidence: {
      summary: "boom",
      httpStatus: 500,
      latencyMs: 80,
      consoleErrors: ["TypeError"],
      failedRequests: [],
      domErrorStates: [],
      dataSignal: null,
      screenshotRef: null,
    },
    ...overrides,
  };
}

function makeTriage(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    id: "an-1",
    route: "/metrics",
    role: "staff",
    severity: "high",
    category: "failed-request",
    probable_cause: "API 500",
    suggested_fix: "retry",
    evidence: {
      summary: "failed",
      httpStatus: 500,
      latencyMs: 90,
      consoleErrors: [],
      failedRequests: [],
      domErrorStates: [],
      dataSignal: null,
      screenshotRef: null,
    },
    status: "triaged",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  1. createRun — idempotent INSERT ... ON CONFLICT, state 'running'  */
/* ------------------------------------------------------------------ */

test("createRun issues an idempotent INSERT in 'running' state with the run_id", async () => {
  const { db, calls } = createMockDb();

  await createRun(
    {
      runId: "run-42",
      baseUrl: "https://portal.today.dev.tooling.dp.iskaypet.com",
      rolesCovered: ["admin", "staff"],
      triggerSource: "on-demand",
    },
    db,
  );

  assert.equal(calls.length, 1, "createRun must issue exactly one query");
  const { text, params } = calls[0];

  assert.match(text, /INSERT INTO exploration_runs/);
  assert.match(text, /ON CONFLICT \(run_id\)/, "must be idempotent on run_id");
  assert.match(text, /'running'/, "must insert in 'running' status");

  assert.ok(params, "params must be present");
  assert.equal(params![0], "run-42", "run_id must be the first param");
  assert.equal(
    params![1],
    "https://portal.today.dev.tooling.dp.iskaypet.com",
    "base_url must be the second param",
  );
  assert.equal(
    params![2],
    JSON.stringify(["admin", "staff"]),
    "roles_covered must be serialized JSON",
  );
  assert.equal(params![3], "on-demand", "trigger_source must be the fourth param");
});

test("createRun defaults trigger_source to 'cron' and roles to []", async () => {
  const { db, calls } = createMockDb();

  await createRun(
    {
      runId: "run-43",
      baseUrl: "https://example.test",
      rolesCovered: [],
    },
    db,
  );

  const { params } = calls[0];
  assert.equal(params![2], JSON.stringify([]));
  assert.equal(params![3], "cron");
});

/* ------------------------------------------------------------------ */
/*  2. persistVisitResult — no-throw, continues run (Req 10.5)         */
/* ------------------------------------------------------------------ */

test("persistVisitResult returns true and issues an upsert when the query resolves", async () => {
  const { db, calls } = createMockDb(() => ({ rows: [], rowCount: 1 }));

  const ok = await persistVisitResult(makeVisit(), db);

  assert.equal(ok, true, "must return true on success");
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /INSERT INTO visit_results/);
  assert.match(
    calls[0].text,
    /ON CONFLICT \(run_id, scenario_id, role\)/,
    "must be idempotent per run+scenario+role",
  );
});

test("persistVisitResult returns false and does NOT throw when the query rejects", async () => {
  const { db } = createMockDb(() => {
    throw new Error("db exploded");
  });

  // Must not propagate: returns false instead of throwing.
  const result = await persistVisitResult(makeVisit(), db);
  assert.equal(result, false);
});

test(
  "Req 10.5: a single visit_result failure does not discard already-persisted ones",
  async () => {
    // Simulate a sequence of 3 visits where the 2nd row's persistence rejects
    // and the others resolve. The caller's loop must be able to continue and
    // the earlier successes must be unaffected.
    const { db, calls } = createMockDb((_text, _params, callIndex) => {
      if (callIndex === 1) {
        throw new Error("transient failure persisting visit #2");
      }
      return { rows: [], rowCount: 1 };
    });

    const visits = [
      makeVisit({ scenarioId: "scn-a" }),
      makeVisit({ scenarioId: "scn-b" }),
      makeVisit({ scenarioId: "scn-c" }),
    ];

    const outcomes: boolean[] = [];
    for (const visit of visits) {
      // The loop continues across the failing row precisely because
      // persistVisitResult never throws.
      outcomes.push(await persistVisitResult(visit, db));
    }

    assert.deepEqual(
      outcomes,
      [true, false, true],
      "the failing row reports false; the surrounding rows persist successfully",
    );
    assert.equal(calls.length, 3, "all three visits were attempted (run continued)");
    // The earlier success (#1) was attempted before and independently of the
    // failure (#2), proving already-persisted results are not discarded.
    assert.equal(calls[0].params![1], "scn-a");
    assert.equal(calls[2].params![1], "scn-c");
  },
);

/* ------------------------------------------------------------------ */
/*  3. updateRunTerminal — finished_at / status / summary             */
/* ------------------------------------------------------------------ */

test("updateRunTerminal sets finished_at, status, summary and counters", async () => {
  const { db, calls } = createMockDb();

  const summary = {
    routesVisited: 12,
    anomaliesBySeverity: { critical: 1, high: 2, medium: 0, low: 0, info: 0 },
    rbacFindings: 1,
  } as unknown as Parameters<typeof updateRunTerminal>[0]["summary"];

  await updateRunTerminal(
    {
      runId: "run-99",
      status: "completed-with-errors",
      abortReason: null,
      routesVisited: 12,
      anomaliesTotal: 3,
      bedrockCalls: 7,
      reportMarkdownRef: "s3://explorer/run-99/report.md",
      summary,
    },
    db,
  );

  assert.equal(calls.length, 1);
  const { text, params } = calls[0];

  assert.match(text, /UPDATE exploration_runs/);
  assert.match(text, /finished_at = NOW\(\)/);
  assert.match(text, /WHERE run_id = \$1/);

  assert.equal(params![0], "run-99");
  assert.equal(params![1], "completed-with-errors");
  assert.equal(params![2], null, "abort_reason");
  assert.equal(params![3], 12, "routes_visited");
  assert.equal(params![4], 3, "anomalies_total");
  assert.equal(params![5], 7, "bedrock_calls");
  assert.equal(params![6], "s3://explorer/run-99/report.md", "report_markdown_ref");
  assert.equal(params![7], JSON.stringify(summary), "summary serialized as JSON");
});

test("updateRunTerminal serializes a null summary as null (not the string 'null')", async () => {
  const { db, calls } = createMockDb();

  await updateRunTerminal(
    {
      runId: "run-100",
      status: "aborted",
      abortReason: "safety guard tripped",
      routesVisited: 0,
      anomaliesTotal: 0,
      bedrockCalls: 0,
      reportMarkdownRef: null,
      summary: null,
    },
    db,
  );

  const { params } = calls[0];
  assert.equal(params![2], "safety guard tripped");
  assert.equal(params![6], null);
  assert.equal(params![7], null, "null summary must stay null, not 'null'");
});

/* ------------------------------------------------------------------ */
/*  4. persistAnomaly / persistTriageResults — upserts with keys       */
/* ------------------------------------------------------------------ */

test("persistAnomaly upserts with the route+role+category equivalence_key", async () => {
  const { db, calls } = createMockDb();

  const anomaly = makeAnomaly();
  await persistAnomaly(anomaly, db);

  assert.equal(calls.length, 1);
  const { text, params } = calls[0];

  assert.match(text, /INSERT INTO anomalies/);
  assert.match(text, /ON CONFLICT \(run_id, anomaly_id\)/);

  assert.equal(params![0], "an-1", "anomaly_id");
  assert.equal(params![1], "run-1", "run_id");
  assert.equal(params![3], "/metrics", "route_path");
  assert.equal(params![4], "desarrolladores", "role");
  assert.equal(params![5], "console-error", "category");
  assert.equal(
    params![7],
    "/metrics|desarrolladores|console-error",
    "equivalence_key = route|role|category",
  );
});

test("persistTriageResults upserts each result with is_regression and equivalence_key", async () => {
  const { db, calls } = createMockDb();

  const triaged = makeTriage({ id: "an-1", category: "failed-request", role: "staff" });
  const regressed = makeTriage({
    id: "an-2",
    route: "/finops",
    role: "admin",
    category: "rbac",
  });

  await persistTriageResults(
    "run-7",
    [triaged, regressed],
    new Set(["an-2"]),
    db,
  );

  assert.equal(calls.length, 2, "one upsert per triage result");

  for (const call of calls) {
    assert.match(call.text, /INSERT INTO triage_results/);
    assert.match(call.text, /ON CONFLICT \(run_id, id\)/);
    assert.equal(call.params![1], "run-7", "run_id is param 2");
  }

  // First result: not a regression.
  const first = calls[0].params!;
  assert.equal(first[0], "an-1");
  assert.equal(first[10], false, "an-1 is NOT in the regression set");
  assert.equal(first[11], "/metrics|staff|failed-request", "equivalence_key");

  // Second result: flagged as regression.
  const second = calls[1].params!;
  assert.equal(second[0], "an-2");
  assert.equal(second[10], true, "an-2 IS in the regression set");
  assert.equal(second[11], "/finops|admin|rbac", "equivalence_key");
});

test("persistTriageResults issues no queries for an empty result set", async () => {
  const { db, calls } = createMockDb();
  await persistTriageResults("run-8", [], new Set(), db);
  assert.equal(calls.length, 0);
});

/* ------------------------------------------------------------------ */
/*  5. loadPreviousRunTriage — prior completed run, or null (Req 7.7)  */
/* ------------------------------------------------------------------ */

test("loadPreviousRunTriage maps the prior completed run's triage rows", async () => {
  const triageRow = {
    id: "an-x",
    route_path: "/synthetics",
    role: "externos",
    severity: "medium",
    category: "empty-state",
    probable_cause: "no data",
    suggested_fix: "seed",
    evidence: { summary: "empty" },
    status: "triaged",
  };

  const { db, calls } = createMockDb((text) => {
    if (/FROM exploration_runs/.test(text)) {
      // History is preserved and queried for the baseline run (Req 7.7).
      return { rows: [{ run_id: "run-prev" }], rowCount: 1 };
    }
    if (/FROM triage_results/.test(text)) {
      return { rows: [triageRow], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const result = await loadPreviousRunTriage("run-current", db);

  assert.notEqual(result, null);
  assert.equal(result!.length, 1);
  assert.deepEqual(result![0], {
    id: "an-x",
    route: "/synthetics",
    role: "externos",
    severity: "medium",
    category: "empty-state",
    probable_cause: "no data",
    suggested_fix: "seed",
    evidence: { summary: "empty" },
    status: "triaged",
  });

  // The baseline lookup excludes the current run and filters to terminal-OK runs.
  assert.match(calls[0].text, /run_id <> \$1/);
  assert.match(calls[0].text, /status IN \('completed', 'completed-with-errors'\)/);
  assert.equal(calls[0].params![0], "run-current");
  // The triage rows are loaded for the discovered baseline run.
  assert.equal(calls[1].params![0], "run-prev");
});

test("loadPreviousRunTriage returns null when there is no comparable prior run", async () => {
  const { db, calls } = createMockDb((text) => {
    if (/FROM exploration_runs/.test(text)) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });

  const result = await loadPreviousRunTriage("run-current", db);

  assert.equal(result, null);
  assert.equal(calls.length, 1, "must not query triage_results when no baseline exists");
});

/* ------------------------------------------------------------------ */
/*  6. loadRun — maps a row to ExplorationRun, or null                 */
/* ------------------------------------------------------------------ */

test("loadRun maps a row to an ExplorationRun", async () => {
  const startedAt = new Date("2026-06-20T10:00:00.000Z");
  const finishedAt = new Date("2026-06-20T10:05:00.000Z");

  const { db } = createMockDb(() => ({
    rows: [
      {
        run_id: "run-55",
        started_at: startedAt,
        finished_at: finishedAt,
        status: "completed",
        abort_reason: null,
        roles_covered: ["admin", "staff"],
        base_url: "https://portal.today.dev.tooling.dp.iskaypet.com",
      },
    ],
    rowCount: 1,
  }));

  const run = await loadRun("run-55", db);

  assert.deepEqual(run, {
    runId: "run-55",
    startedAt: "2026-06-20T10:00:00.000Z",
    finishedAt: "2026-06-20T10:05:00.000Z",
    status: "completed",
    abortReason: null,
    rolesCovered: ["admin", "staff"],
    baseUrl: "https://portal.today.dev.tooling.dp.iskaypet.com",
  });
});

test("loadRun normalizes string timestamps and missing roles", async () => {
  const { db } = createMockDb(() => ({
    rows: [
      {
        run_id: "run-56",
        started_at: "2026-06-20T11:00:00.000Z",
        finished_at: null,
        status: "running",
        abort_reason: null,
        roles_covered: null,
        base_url: "https://example.test",
      },
    ],
    rowCount: 1,
  }));

  const run = await loadRun("run-56", db);

  assert.equal(run!.startedAt, "2026-06-20T11:00:00.000Z");
  assert.equal(run!.finishedAt, null);
  assert.deepEqual(run!.rolesCovered, [], "null roles_covered maps to []");
});

test("loadRun returns null when the run does not exist", async () => {
  const { db } = createMockDb(() => ({ rows: [], rowCount: 0 }));
  const run = await loadRun("nope", db);
  assert.equal(run, null);
});
