/**
 * Contract test — reopen handler does NOT update the DB on failure
 * (spec: ticket-reopen-comment-fix, task 6).
 *
 * Verifies the BD↔Jira consistency contract wired in task 3.4
 * (`src/app/api/jira/my-tickets/route.ts`, PATCH `action:"reopen"`):
 *
 *   - Given a `TransitionResult` with `ok:false` (whether `matched:false` or a
 *     genuine upstream failure) → the handler MUST NOT run
 *     `UPDATE portal_tickets SET status='open'` and MUST return an error
 *     response carrying `jiraStatus` / `detail`.
 *   - Given `ok:true` → the handler MUST run the `UPDATE` and return
 *     `{ success:true }`.
 *
 * The reopen decision is tested as a PURE mapping `TransitionResult → effect`
 * (`decideReopenEffect`), faithfully replicating the route's branch logic:
 *
 *     if (!result.ok) {
 *       const httpStatus = !result.matched && result.status === undefined ? 422 : 502;
 *       return error({ error, jiraStatus: result.status, detail: result.message }, httpStatus);
 *     }
 *     // result.ok === true
 *     UPDATE portal_tickets SET status='open', closed_at=NULL, updated_at=NOW();
 *     return { success: true, jiraKey, action };
 *
 * A thin `simulateReopenHandler` then drives that decision with an INJECTED
 * `query` mock (no DB) and an injected `jiraTransitionToOpen` result (no
 * network), so the side effect — "was the row updated to 'open'?" — is
 * observable. The central invariant is asserted both by example and by a
 * fast-check property over arbitrary `TransitionResult` values:
 *
 *     row updated to 'open'  ⟺  result.ok === true
 *
 * Conventions: `node:test` + `node:assert/strict`, run with `tsx`; PBT via
 * `fast-check`. No real network, no real DB.
 *
 * Validates: Requirements 2.2, 2.3, 3.1
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import type { TransitionResult } from "../jira";

/* ------------------------------------------------------------------ */
/*  Pure decision under test — mirrors my-tickets/route.ts (task 3.4)  */
/* ------------------------------------------------------------------ */

type ReopenEffect = {
  /** Whether `UPDATE portal_tickets SET status='open'` must run. */
  shouldUpdate: boolean;
  /** HTTP status the handler returns. */
  httpStatus: number;
  /** JSON body the handler returns. */
  body: Record<string, unknown>;
};

/**
 * Pure mapping from a Jira `TransitionResult` to the handler's effect+response.
 * This is a faithful, network/DB-free replica of the reopen branch in
 * `PATCH /api/jira/my-tickets`.
 */
function decideReopenEffect(
  result: TransitionResult,
  jiraKey: string,
  action: "reopen"
): ReopenEffect {
  if (!result.ok) {
    // No reopen transition available (matched === false with no upstream status)
    // → 422; Jira upstream failure (has an HTTP status) → 502. Never update the row.
    const httpStatus = !result.matched && result.status === undefined ? 422 : 502;
    return {
      shouldUpdate: false,
      httpStatus,
      body: {
        error: result.matched
          ? "Failed to reopen ticket in Jira"
          : "No reopen transition available for this ticket in Jira",
        jiraStatus: result.status,
        detail: result.message,
      },
    };
  }

  return {
    shouldUpdate: true,
    httpStatus: 200,
    body: { success: true, jiraKey, action },
  };
}

/* ------------------------------------------------------------------ */
/*  Thin handler simulation with INJECTED deps (no DB / no network)    */
/* ------------------------------------------------------------------ */

type QueryCall = { sql: string; params: unknown[] };

/**
 * Simulates the reopen path of the PATCH handler: it consumes the (injected)
 * `jiraTransitionToOpen` result, decides the effect, and only runs the
 * injected `query` when the contract allows it. Records every query so tests
 * can assert whether the `status='open'` UPDATE actually fired.
 */
async function simulateReopenHandler(
  result: TransitionResult,
  jiraKey: string,
  deps: { query: (sql: string, params: unknown[]) => Promise<void> }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const effect = decideReopenEffect(result, jiraKey, "reopen");

  if (effect.shouldUpdate) {
    await deps.query(
      `UPDATE portal_tickets SET status = 'open', closed_at = NULL, updated_at = NOW() WHERE jira_key = $1`,
      [jiraKey]
    );
  }

  return { status: effect.httpStatus, body: effect.body };
}

/** Build an injectable query mock that records calls. */
function makeQueryMock() {
  const calls: QueryCall[] = [];
  const query = async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
  };
  const updatedToOpen = () =>
    calls.some((c) => /UPDATE portal_tickets SET status = 'open'/.test(c.sql));
  return { query, calls, updatedToOpen };
}

/* ------------------------------------------------------------------ */
/*  Example-based contract assertions                                  */
/* ------------------------------------------------------------------ */

test("contract — ok:true reopens: runs UPDATE status='open' and returns { success:true }", async () => {
  const db = makeQueryMock();
  const result: TransitionResult = { ok: true, matched: true, transitioned: true, status: 200 };

  const res = await simulateReopenHandler(result, "SRE-2152", db);

  assert.equal(db.updatedToOpen(), true, "the row must be updated to 'open' when Jira transitioned");
  assert.equal(db.calls.length, 1, "exactly one UPDATE should run");
  assert.deepEqual(db.calls[0].params, ["SRE-2152"]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true, jiraKey: "SRE-2152", action: "reopen" });
});

test("contract — ok:false matched (upstream POST failed): NO UPDATE, 502 with jiraStatus+detail", async () => {
  const db = makeQueryMock();
  // e.g. POST .../transitions returned 409 → matched but not transitioned.
  const result: TransitionResult = {
    ok: false,
    matched: true,
    transitioned: false,
    status: 409,
    message: "transition not allowed",
  };

  const res = await simulateReopenHandler(result, "SRE-2152", db);

  assert.equal(db.updatedToOpen(), false, "row must NOT be marked open when Jira did not transition");
  assert.equal(db.calls.length, 0, "no DB write may happen on failure");
  assert.equal(res.status, 502, "matched upstream failure → 502 Bad Gateway");
  assert.equal(res.body.error, "Failed to reopen ticket in Jira");
  assert.equal(res.body.jiraStatus, 409, "real Jira status must be surfaced");
  assert.equal(res.body.detail, "transition not allowed", "real Jira message must be surfaced");
});

test("contract — ok:false no match, no status: NO UPDATE, 422 with available-transitions detail", async () => {
  const db = makeQueryMock();
  // No reopen transition matched; no upstream HTTP status recorded.
  const result: TransitionResult = {
    ok: false,
    matched: false,
    transitioned: false,
    message: "No reopen transition. Available: Finalizar, Resolver",
  };

  const res = await simulateReopenHandler(result, "SRE-2152", db);

  assert.equal(db.updatedToOpen(), false, "row must NOT be marked open when nothing matched");
  assert.equal(db.calls.length, 0);
  assert.equal(res.status, 422, "no reopen transition available → 422");
  assert.equal(res.body.error, "No reopen transition available for this ticket in Jira");
  assert.equal(res.body.jiraStatus, undefined, "no upstream status when nothing matched");
  assert.match(String(res.body.detail), /Available: Finalizar, Resolver/);
});

test("contract — ok:false GET transitions failed (matched:false WITH status): NO UPDATE, 502", async () => {
  const db = makeQueryMock();
  // GET .../transitions itself failed (e.g. 500) → matched:false but a status exists.
  const result: TransitionResult = {
    ok: false,
    matched: false,
    transitioned: false,
    status: 500,
    message: "upstream boom",
  };

  const res = await simulateReopenHandler(result, "SRE-2152", db);

  assert.equal(db.updatedToOpen(), false);
  assert.equal(res.status, 502, "upstream failure WITH a status → 502, not 422");
  assert.equal(res.body.jiraStatus, 500);
  assert.equal(res.body.detail, "upstream boom");
});

/* ------------------------------------------------------------------ */
/*  Property: row updated to 'open'  ⟺  result.ok === true             */
/* ------------------------------------------------------------------ */

// Smart generator: realistic `TransitionResult` shapes covering every branch
// of `jiraTransitionToOpen` plus arbitrary combinations, so the invariant is
// exercised across the whole result space (not just the happy path).
const okResult: fc.Arbitrary<TransitionResult> = fc
  .constantFrom(200, 204)
  .map((status) => ({ ok: true, matched: true, transitioned: true, status }));

const failNoMatchNoStatus: fc.Arbitrary<TransitionResult> = fc
  .string()
  .map((message) => ({ ok: false, matched: false, transitioned: false, message }));

const failGetTransitions: fc.Arbitrary<TransitionResult> = fc
  .tuple(fc.integer({ min: 400, max: 599 }), fc.string())
  .map(([status, message]) => ({ ok: false, matched: false, transitioned: false, status, message }));

const failPostExecution: fc.Arbitrary<TransitionResult> = fc
  .tuple(fc.integer({ min: 400, max: 599 }), fc.string())
  .map(([status, message]) => ({ ok: false, matched: true, transitioned: false, status, message }));

const anyTransitionResult: fc.Arbitrary<TransitionResult> = fc.oneof(
  okResult,
  failNoMatchNoStatus,
  failGetTransitions,
  failPostExecution
);

test("Property — the portal row is updated to 'open' iff result.ok === true (Req 2.2, 2.3, 3.1)", async () => {
  await fc.assert(
    fc.asyncProperty(anyTransitionResult, async (result) => {
      const db = makeQueryMock();

      // The pure decision and the simulated effect must agree on the invariant.
      const effect = decideReopenEffect(result, "SRE-1", "reopen");
      assert.equal(
        effect.shouldUpdate,
        result.ok,
        `COUNTEREXAMPLE: shouldUpdate (${effect.shouldUpdate}) must equal result.ok (${result.ok})`
      );

      const res = await simulateReopenHandler(result, "SRE-1", db);

      // Central invariant: the UPDATE to 'open' runs iff Jira actually transitioned.
      assert.equal(
        db.updatedToOpen(),
        result.ok,
        `COUNTEREXAMPLE: row updated=${db.updatedToOpen()} but result.ok=${result.ok}`
      );

      if (result.ok) {
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { success: true, jiraKey: "SRE-1", action: "reopen" });
      } else {
        // On failure: never an UPDATE, always a diagnostic body, valid 4xx/5xx status.
        assert.equal(db.calls.length, 0, "no DB write may happen on failure");
        assert.ok(res.status >= 400 && res.status < 600, "failure must map to a 4xx/5xx status");
        // 422 only when nothing matched AND no upstream status; otherwise 502.
        const expected = !result.matched && result.status === undefined ? 422 : 502;
        assert.equal(res.status, expected);
        assert.ok("jiraStatus" in res.body, "error body must carry jiraStatus");
        assert.ok("detail" in res.body, "error body must carry detail");
        assert.equal(res.body.jiraStatus, result.status);
        assert.equal(res.body.detail, result.message);
      }
    }),
    { numRuns: 300 }
  );
});

test("Property (boundary) — 422 vs 502 split is exactly (!matched && status===undefined)", () => {
  fc.assert(
    fc.property(
      fc.boolean(),
      fc.option(fc.integer({ min: 400, max: 599 }), { nil: undefined }),
      (matched, status) => {
        const result: TransitionResult = {
          ok: false,
          matched,
          transitioned: false,
          status,
          message: "x",
        };
        const effect = decideReopenEffect(result, "SRE-1", "reopen");
        assert.equal(effect.shouldUpdate, false, "ok:false must never update");
        const expected = !matched && status === undefined ? 422 : 502;
        assert.equal(effect.httpStatus, expected);
      }
    ),
    { numRuns: 200 }
  );
});
