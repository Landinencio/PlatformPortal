/**
 * Bug Condition Exploration Test — Ticket Reopen & Comment Fix (spec: ticket-reopen-comment-fix).
 *
 * Property 1: Bug Condition — bilingual reopen matching + real Jira comment status.
 *
 * CRITICAL: This test is EXPECTED TO FAIL on the UNFIXED code. The failure CONFIRMS the bug.
 * It encodes the EXPECTED (post-fix) behavior, so the SAME test will validate the fix once it
 * passes after implementation (task 3.6). DO NOT fix the code or the test when it fails here —
 * the failure is the goal: it surfaces the counterexamples that demonstrate the root cause.
 *
 * Root cause being surfaced (from bugfix.md / design.md):
 *  - Reopen matcher is English-only (`REOPEN_TRANSITION_NAMES = ["reopen","re-open","to do",
 *    "open","backlog"]`) and never matches the SRE workflow transition "Volver a abrir incidencia".
 *    The pure, exported, testable `matchReopenTransition` / `REOPEN_TRANSITION_REGEX` do NOT exist yet.
 *  - The comment endpoint always returns a fixed `500 {"error":"Failed to add comment"}` instead of
 *    the real Jira status (403 -> 403, 500 -> 502). The pure `mapJiraErrorStatus` does NOT exist yet.
 *
 * Validates: Requirements 2.1, 2.4, 2.5
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

// Import the TARGET (post-fix) symbols. On unfixed code these are `undefined`, so the assertions
// below fail — surfacing the documented counterexamples.
import * as jira from "../jira";

type JiraTransition = {
  id: string;
  name: string;
  to?: { statusCategory?: { key?: string } };
};

const matchReopenTransition = (jira as unknown as {
  matchReopenTransition?: (transitions: JiraTransition[]) => JiraTransition | undefined;
}).matchReopenTransition;

const mapJiraErrorStatus = (jira as unknown as {
  mapJiraErrorStatus?: (jiraStatus: number) => number;
}).mapJiraErrorStatus;

/* ------------------------------------------------------------------ */
/*  Property 1 (a): bilingual reopen matching                          */
/*  EXPECTED on unfixed code: FAILS — matchReopenTransition undefined  */
/*  and the English-only matcher does not match "Volver a abrir ..."   */
/* ------------------------------------------------------------------ */

test("Property 1a — matchReopenTransition matches the SRE Spanish reopen transition", () => {
  assert.equal(
    typeof matchReopenTransition,
    "function",
    "COUNTEREXAMPLE: matchReopenTransition is not exported from src/lib/jira.ts " +
      "(English-only REOPEN_TRANSITION_NAMES cannot match 'Volver a abrir incidencia')",
  );

  // The concrete failing case from the real SRE workflow: state "Finalizado" only offers
  // the transition "Volver a abrir incidencia" -> "Reabierto" (statusCategory "new").
  const transitions: JiraTransition[] = [
    { id: "X", name: "Volver a abrir incidencia", to: { statusCategory: { key: "new" } } },
  ];

  const matched = matchReopenTransition!(transitions);
  assert.ok(
    matched,
    "COUNTEREXAMPLE: no reopen transition matched for 'Volver a abrir incidencia'",
  );
  assert.equal(matched!.id, "X", "expected the system to return the Spanish reopen transition");
});

test("Property 1a (PBT) — bilingual reopen transitions are matched across the input space", () => {
  // Scoped generator: concrete reopen transition names from the real SRE/Jira workflow
  // (Spanish + English) that the bilingual matcher MUST recognise.
  const reopenName = fc.constantFrom(
    "Volver a abrir incidencia",
    "Reabrir",
    "Reabierto",
    "Reopen",
    "To Do",
  );
  const reopenCategory = fc.constantFrom("new", "indeterminate");

  fc.assert(
    fc.property(reopenName, reopenCategory, (name, key) => {
      assert.equal(
        typeof matchReopenTransition,
        "function",
        "COUNTEREXAMPLE: matchReopenTransition is not exported from src/lib/jira.ts",
      );
      const transitions: JiraTransition[] = [
        { id: "R", name, to: { statusCategory: { key } } },
      ];
      const matched = matchReopenTransition!(transitions);
      assert.ok(matched, `COUNTEREXAMPLE: reopen transition '${name}' was not matched`);
      assert.equal(matched!.id, "R");
    }),
    { numRuns: 50 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 1 (c): real Jira comment status propagation               */
/*  EXPECTED on unfixed code: FAILS — mapJiraErrorStatus undefined and */
/*  the endpoint returns a fixed 500 instead of 403 / 502.             */
/* ------------------------------------------------------------------ */

test("Property 1c — mapJiraErrorStatus propagates the real Jira comment status (403->403, 500->502)", () => {
  assert.equal(
    typeof mapJiraErrorStatus,
    "function",
    "COUNTEREXAMPLE: mapJiraErrorStatus is not exported from src/lib/jira.ts " +
      "(the comment endpoint always returns a fixed 500 {\"error\":\"Failed to add comment\"})",
  );

  assert.equal(mapJiraErrorStatus!(403), 403, "COUNTEREXAMPLE: a Jira 403 must surface as 403, not a fixed 500");
  assert.equal(mapJiraErrorStatus!(500), 502, "COUNTEREXAMPLE: a Jira 500 must surface as 502 (upstream)");
});

test("Property 1c (PBT) — 4xx propagates unchanged, 5xx collapses to 502", () => {
  fc.assert(
    fc.property(fc.integer({ min: 400, max: 599 }), (status) => {
      assert.equal(
        typeof mapJiraErrorStatus,
        "function",
        "COUNTEREXAMPLE: mapJiraErrorStatus is not exported from src/lib/jira.ts",
      );
      const mapped = mapJiraErrorStatus!(status);
      const expected = status >= 500 ? 502 : status;
      assert.equal(
        mapped,
        expected,
        `COUNTEREXAMPLE: Jira status ${status} should map to ${expected} but the opaque 500 path returns a fixed 500`,
      );
    }),
    { numRuns: 100 },
  );
});
