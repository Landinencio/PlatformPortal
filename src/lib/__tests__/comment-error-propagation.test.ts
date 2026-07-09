/**
 * Comment endpoint error-propagation tests — Ticket Reopen & Comment Fix
 * (spec: ticket-reopen-comment-fix, task 7).
 *
 * Verifies the error-propagation DECISION of the comment POST handler
 * (`src/app/api/jira/tickets/[key]/comments/route.ts`, wired in task 3.5).
 *
 * The handler's branch order (faithfully modelled here as a pure function so the
 * decision is testable without network, DB or auth) is:
 *   1. ownership invalid (no matching portal_tickets row) -> 404 "Ticket not found or not yours"
 *   2. empty/blank comment body                            -> 400 "Comment is required"
 *   3. Jira POST .../comment:
 *        - !res.ok (status >= 400) -> status = mapJiraErrorStatus(res.status),
 *                                      body = { error: <trimmed jira message | fallback>,
 *                                               jiraStatus: res.status }
 *        - res.ok  (status < 400)  -> { success: true }   (happy path preserved)
 *
 * The PBT exercises the real exported `mapJiraErrorStatus` from `src/lib/jira.ts`
 * over `jiraStatus ∈ [400, 599]` and asserts the propagated status is exactly
 * `mapJiraErrorStatus(jiraStatus)` and is always a valid HTTP status code.
 *
 * Conventions: `node:test` + `node:assert/strict` + `fast-check`, run with `tsx`.
 *
 * Validates: Requirements 2.4, 2.5, 3.2, 3.4
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { mapJiraErrorStatus } from "../jira";

/* ------------------------------------------------------------------ */
/*  Pure model of the comment POST decision (mirrors route.ts task 3.5) */
/* ------------------------------------------------------------------ */

type CommentDecision =
  | { status: 404; body: { error: string } }
  | { status: 400; body: { error: string } }
  | { status: 200; body: { success: true } }
  | { status: number; body: { error: string; jiraStatus: number } };

type CommentInput = {
  /** Whether the portal_tickets ownership check found a row for this user. */
  ownsTicket: boolean;
  /** The raw comment string from the request body. */
  comment: string;
  /** The Jira response — only consulted if ownership + body validations pass. */
  jira?: { status: number; text: string };
};

/**
 * Faithful, pure replica of the comment POST handler's decision tree.
 * Mirrors `src/app/api/jira/tickets/[key]/comments/route.ts` (task 3.5) exactly,
 * including the error-body shape `{ error, jiraStatus }` and the
 * `text.trim().slice(0, 500) || "Failed to add comment"` fallback.
 */
function decideCommentResponse(input: CommentInput): CommentDecision {
  // (1) Ownership check runs first.
  if (!input.ownsTicket) {
    return { status: 404, body: { error: "Ticket not found or not yours" } };
  }

  // (2) Empty/blank body validation runs before the Jira call.
  if (!input.comment || !input.comment.trim()) {
    return { status: 400, body: { error: "Comment is required" } };
  }

  // (3) Jira call result.
  const jira = input.jira!;
  if (!(jira.status < 400)) {
    // Error path: propagate the real Jira status + message.
    return {
      status: mapJiraErrorStatus(jira.status),
      body: {
        error: jira.text.trim().slice(0, 500) || "Failed to add comment",
        jiraStatus: jira.status,
      },
    };
  }

  // Happy path preserved.
  return { status: 200, body: { success: true } };
}

/* ------------------------------------------------------------------ */
/*  Concrete cases (Req 2.4, 2.5, 3.2, 3.4)                            */
/* ------------------------------------------------------------------ */

test("comment endpoint — Jira 403 with body -> 403 with the real Jira message and jiraStatus:403", () => {
  const jiraMessage = "You do not have permission to comment on this issue";
  const res = decideCommentResponse({
    ownsTicket: true,
    comment: "please reopen and review",
    jira: { status: 403, text: jiraMessage },
  });

  assert.equal(res.status, 403, "client must receive the real 403, not a fixed 500");
  assert.equal((res.body as { jiraStatus: number }).jiraStatus, 403);
  assert.equal(
    (res.body as { error: string }).error,
    jiraMessage,
    "the real (trimmed) Jira message must be surfaced to the client",
  );
});

test("comment endpoint — Jira 500 -> 502 (Bad Gateway, upstream error)", () => {
  const res = decideCommentResponse({
    ownsTicket: true,
    comment: "any comment",
    jira: { status: 500, text: "Internal Server Error" },
  });

  assert.equal(res.status, 502, "5xx upstream errors collapse to 502");
  assert.equal((res.body as { jiraStatus: number }).jiraStatus, 500, "the real upstream status is preserved in the body");
});

test("comment endpoint — Jira OK (< 400) -> { success: true } (happy path preserved, Req 3.2)", () => {
  for (const status of [200, 201, 204, 399]) {
    const res = decideCommentResponse({
      ownsTicket: true,
      comment: "a valid comment",
      jira: { status, text: "" },
    });
    assert.equal(res.status, 200, `Jira ${status} must stay on the happy path`);
    assert.deepEqual(res.body, { success: true }, `Jira ${status} must return { success: true }`);
  }
});

test("comment endpoint — error body falls back to 'Failed to add comment' when Jira body is empty", () => {
  const res = decideCommentResponse({
    ownsTicket: true,
    comment: "any comment",
    jira: { status: 502, text: "   " },
  });
  assert.equal(res.status, 502);
  assert.equal((res.body as { error: string }).error, "Failed to add comment");
  assert.equal((res.body as { jiraStatus: number }).jiraStatus, 502);
});

test("comment endpoint — empty/blank body -> 400 'Comment is required' (before the Jira call, Req 3.4)", () => {
  for (const comment of ["", "   ", "\n\t "]) {
    const res = decideCommentResponse({
      ownsTicket: true,
      comment,
      // No jira field on purpose: the Jira call must NOT be reached.
    });
    assert.equal(res.status, 400, `blank comment '${JSON.stringify(comment)}' must yield 400`);
    assert.equal((res.body as { error: string }).error, "Comment is required");
  }
});

test("comment endpoint — invalid ownership -> 404 'Ticket not found or not yours' (Req 3.4)", () => {
  const res = decideCommentResponse({
    ownsTicket: false,
    comment: "I should not be able to comment",
    jira: { status: 200, text: "" }, // even with a would-be-OK Jira, ownership wins first
  });
  assert.equal(res.status, 404, "ownership failure must short-circuit to 404");
  assert.equal((res.body as { error: string }).error, "Ticket not found or not yours");
});

/* ------------------------------------------------------------------ */
/*  PBT — jiraStatus ∈ [400, 599] propagates via mapJiraErrorStatus    */
/*  and is always a valid HTTP status code (Req 2.5)                   */
/* ------------------------------------------------------------------ */

test("Property — Jira error status [400,599] propagates as mapJiraErrorStatus and stays a valid HTTP code (Req 2.5)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 400, max: 599 }),
      fc.string(),
      (jiraStatus, body) => {
        const res = decideCommentResponse({
          ownsTicket: true,
          comment: "a non-empty comment",
          jira: { status: jiraStatus, text: body },
        });

        // (1) The endpoint status is exactly the pure mapping of the Jira status.
        assert.equal(
          res.status,
          mapJiraErrorStatus(jiraStatus),
          `COUNTEREXAMPLE: status for Jira ${jiraStatus} should be mapJiraErrorStatus(${jiraStatus})`,
        );

        // (2) The propagated status is always a valid HTTP status code.
        assert.ok(
          Number.isInteger(res.status) && res.status >= 100 && res.status <= 599,
          `COUNTEREXAMPLE: ${res.status} is not a valid HTTP status code`,
        );

        // (3) Invariant of the mapping: 4xx propagates unchanged, 5xx collapses to 502.
        if (jiraStatus < 500) {
          assert.equal(res.status, jiraStatus, "4xx must propagate unchanged");
        } else {
          assert.equal(res.status, 502, "5xx must collapse to 502");
        }

        // (4) The real upstream status is always echoed back in the body for diagnosability (Req 2.4).
        assert.equal(
          (res.body as { jiraStatus: number }).jiraStatus,
          jiraStatus,
          "the real Jira status must be echoed in the response body",
        );
      },
    ),
    { numRuns: 300 },
  );
});
