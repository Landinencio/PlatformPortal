/**
 * Tests for the on-demand Explorer endpoint `POST /api/explorer/run`
 * (spec: ai-portal-explorer, task 16.2).
 *
 * These are example-based integration tests (node:test). Following the same
 * pragmatic rationale documented in `rds-execute-route.test.ts`, the route
 * handler is tightly coupled to live dependencies: it imports `next/server`
 * (`NextResponse`), `requireInternalAuth` (which reads `INTERNAL_API_SECRET`)
 * and `runExploration` — and it kicks off the orchestrator fire-and-forget with
 * REAL default deps (it accepts no dependency injection). So we cover the three
 * required behaviours at the level where each can be exercised deterministically
 * and WITHOUT touching a real DB, browser or Bedrock:
 *
 *   1. "401 sin x-internal-secret" (Req 9.2):
 *      Driven through the REAL route handler. Without (or with an incorrect)
 *      `x-internal-secret`, `requireInternalAuth` short-circuits BEFORE
 *      `runExploration` is ever reached, so `POST` returns a 401 with no I/O.
 *      Also asserted at the building-block level (`requireInternalAuth`).
 *
 *   2. "arranque con secreto válido" (Req 9.1):
 *      Driven through the REAL route handler. With a valid secret the handler
 *      returns 202 and starts the run in the background. To keep this fully
 *      DB/browser/Bedrock-free we (a) stub the shared pg pool's `query` so no
 *      real connection is attempted by the fire-and-forget run, and (b) point
 *      the run at a NON-dev `baseUrl` (`EXPLORER_BASE_URL`), so the orchestrator
 *      aborts immediately at the environment guard (Req 1.2) BEFORE creating any
 *      Crawler or invoking Bedrock. The 202 "accepted" response is the contract
 *      the endpoint promises. The valid-secret gate is also asserted directly on
 *      `requireInternalAuth`.
 *
 *   3. "rechazo cuando ya hay un run en curso" (Req 9.5):
 *      The route does NOT acquire the single-run lock itself — it relies on the
 *      orchestrator's internal `claimRunLock` (atomic UPDATE over
 *      `explorer_run_lock`) to reject a duplicate start while a run is in
 *      progress (see the route's own docstring, and Property 24 /
 *      `orchestrator.prop24.property.test.ts`). We exercise that lock here with
 *      an in-memory mock pool: the first claim acquires, a second claim with the
 *      lock still held is rejected, and the lock stays owned by the first run.
 *
 * Polyfills (Node 16 test runtime, see the two helper modules): importing the
 * route transitively loads the AWS Bedrock SDK (Web Streams globals) and
 * `next/server` (Fetch API globals); both helpers install the missing globals
 * and are no-ops on Node 18+.
 *
 * _Requirements: 9.1, 9.2, 9.5_
 */

// These two imports MUST come first: they install globals required to import
// the route (Bedrock SDK → Web Streams; next/server → Fetch API) on Node 16.
import "../explorer/__tests__/web-streams-polyfill";
import "../explorer/__tests__/fetch-globals-polyfill";

import test from "node:test";
import assert from "node:assert/strict";

import { claimRunLock } from "../explorer/orchestrator";
import type { OrchestratorDeps } from "../explorer/orchestrator";
import dbPool from "../db";

/* ------------------------------------------------------------------ */
/*  Test secret + global guards                                        */
/* ------------------------------------------------------------------ */

/**
 * `requireInternalAuth` snapshots `INTERNAL_API_SECRET` at module load, so it
 * MUST be set BEFORE `@/lib/api-auth` (and the route) are first imported. This
 * file only dynamic-imports those modules (inside the tests / `loadRoute`),
 * which run after this module-scope assignment.
 */
const INTERNAL_SECRET = "test-internal-secret-16.2";
process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;

/**
 * Neutralise the shared pg pool for the WHOLE file: the route's fire-and-forget
 * `runExploration` uses the default pool (no DI), so we replace `query` with an
 * in-memory no-op to guarantee NO real DB connection is ever attempted by a
 * background run. The single-run-lock test below injects its OWN mock pool, so
 * it is unaffected by this stub. Each test file runs in its own process, so this
 * patch does not leak to other suites.
 */
(dbPool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query =
  async () => ({ rows: [], rowCount: 0 });

/* ------------------------------------------------------------------ */
/*  Lazy, cached import of the route under test                        */
/* ------------------------------------------------------------------ */

type RouteModule = typeof import("@/app/api/explorer/run/route");
let routeModPromise: Promise<RouteModule> | null = null;

/** Imports the route once (after the env secret is set) and caches it. */
function loadRoute(): Promise<RouteModule> {
  if (!routeModPromise) {
    routeModPromise = import("@/app/api/explorer/run/route");
  }
  return routeModPromise;
}

const RUN_URL = "https://portal.today.dev.tooling.dp.iskaypet.com/api/explorer/run";

/* ================================================================== */
/*  Req 9.2 — 401 without a valid x-internal-secret (REAL route)       */
/* ================================================================== */

test("POST /api/explorer/run returns 401 without x-internal-secret (Req 9.2)", async () => {
  const { POST } = await loadRoute();

  const res = await POST(new Request(RUN_URL, { method: "POST" }));

  assert.equal(res.status, 401, "missing secret must be rejected with 401");
  const body = (await res.json()) as { error?: string };
  assert.equal(body.error, "Unauthorized");
});

test("POST /api/explorer/run returns 401 with an incorrect x-internal-secret (Req 9.2)", async () => {
  const { POST } = await loadRoute();

  const res = await POST(
    new Request(RUN_URL, {
      method: "POST",
      headers: { "x-internal-secret": "definitely-wrong" },
    }),
  );

  assert.equal(res.status, 401, "an invalid secret must be rejected with 401");
});

/* ================================================================== */
/*  Req 9.1 — start with a valid secret → 202 (REAL route)             */
/* ================================================================== */

test("POST /api/explorer/run returns 202 and starts the run in the background with a valid secret (Req 9.1)", async () => {
  // Force the background runExploration to abort immediately at the dev-env
  // guard (Req 1.2): a non-dev baseUrl means no Crawler/Bedrock work, and the
  // file-level pool stub means no DB I/O. The handler returns 202 regardless.
  const prevBaseUrl = process.env.EXPLORER_BASE_URL;
  process.env.EXPLORER_BASE_URL = "https://example.invalid";

  try {
    const { POST } = await loadRoute();

    const res = await POST(
      new Request(RUN_URL, {
        method: "POST",
        headers: { "x-internal-secret": INTERNAL_SECRET },
      }),
    );

    assert.equal(res.status, 202, "a valid secret must start the run and return 202 Accepted");
    const body = (await res.json()) as { success?: boolean; status?: string };
    assert.equal(body.success, true);
    assert.equal(body.status, "accepted");

    // Let the fire-and-forget background run settle against the stubbed pool.
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    if (prevBaseUrl === undefined) delete process.env.EXPLORER_BASE_URL;
    else process.env.EXPLORER_BASE_URL = prevBaseUrl;
  }
});

/* ================================================================== */
/*  Req 9.1 / 9.2 — the auth gate itself (building block)              */
/* ================================================================== */

test("requireInternalAuth allows a request carrying the valid secret (Req 9.1)", async () => {
  const { requireInternalAuth } = await import("@/lib/api-auth");

  const result = requireInternalAuth(
    new Request(RUN_URL, { headers: { "x-internal-secret": INTERNAL_SECRET } }),
  );

  assert.equal(result.error, null, "a valid secret must pass the gate (no error)");
});

test("requireInternalAuth rejects missing/invalid secret with a 401 (Req 9.2)", async () => {
  const { requireInternalAuth } = await import("@/lib/api-auth");

  const missing = requireInternalAuth(new Request(RUN_URL));
  assert.ok(missing.error, "missing secret must produce an error response");
  assert.equal(missing.error!.status, 401);

  const wrong = requireInternalAuth(
    new Request(RUN_URL, { headers: { "x-internal-secret": "nope" } }),
  );
  assert.ok(wrong.error, "invalid secret must produce an error response");
  assert.equal(wrong.error!.status, 401);
});

/* ================================================================== */
/*  Req 9.5 — reject a duplicate start while a run is in progress       */
/* ================================================================== */

/**
 * In-memory model of the singleton `explorer_run_lock` row. The atomic claim
 * (`UPDATE ... WHERE id=1 AND active_run_id IS NULL`) grants the lock (rowCount
 * 1) only while it is free; once held it returns rowCount 0. Mirrors the mock in
 * `orchestrator.prop24.property.test.ts` — no real I/O.
 */
function makeMockPool(initialActiveRunId: string | null = null) {
  const state = { activeRunId: initialActiveRunId };

  const pool = {
    async query(text: string, params?: unknown[]) {
      if (text.includes("INSERT INTO explorer_run_lock")) {
        return { rows: [] as Record<string, unknown>[], rowCount: 1 };
      }
      if (
        text.includes("UPDATE explorer_run_lock") &&
        text.includes("active_run_id IS NULL")
      ) {
        if (state.activeRunId === null) {
          state.activeRunId = String((params ?? [])[0]);
          return { rows: [] as Record<string, unknown>[], rowCount: 1 };
        }
        return { rows: [] as Record<string, unknown>[], rowCount: 0 };
      }
      return { rows: [] as Record<string, unknown>[], rowCount: 0 };
    },
  };

  return { pool, state };
}

test("the single-run lock rejects a duplicate start while a run is in progress (Req 9.5)", async () => {
  const { pool, state } = makeMockPool(null);
  let counter = 0;
  const deps: OrchestratorDeps = {
    pool,
    generateRunId: () => `run-${counter++}`,
  };

  // First start acquires the lock.
  const first = await claimRunLock(deps);
  assert.equal(first.acquired, true, "the first start must acquire the lock");

  // A second start WITHOUT releasing the lock (a run already in progress) is
  // rejected — this is exactly what the route relies on to avoid concurrent crawls.
  const second = await claimRunLock(deps);
  assert.equal(second.acquired, false, "a duplicate start must be rejected");

  // The lock stays owned by the first run; the duplicate gets its own runId for
  // recording the rejection (it never steals the lock).
  assert.equal(state.activeRunId, first.runId, "the lock must remain held by the first run");
  assert.notEqual(second.runId, first.runId, "the rejected start gets a distinct runId");
});
