/**
 * Unit tests — pure helpers for the Ticket Reopen & Comment Fix
 * (spec: ticket-reopen-comment-fix, task 4).
 *
 * Covers the pure, exported, network-free helpers from `src/lib/jira.ts`:
 *  - `matchReopenTransition` — bilingual (EN/ES) reopen transition matching,
 *    status-category fallback, "done" exclusion, empty list handling.
 *  - `mapJiraErrorStatus`    — 4xx propagated unchanged, 5xx collapsed to 502.
 *
 * Conventions: `node:test` + `node:assert/strict`, run with `tsx`.
 *
 * NOTE: task 5 will add `jiraTransitionToOpen` branch tests to THIS same file;
 * test names here are namespaced (`matchReopenTransition — ...` /
 * `mapJiraErrorStatus — ...`) to coexist cleanly with no top-level collisions.
 *
 * Validates: Requirements 2.1, 2.5, 3.3
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  matchReopenTransition,
  mapJiraErrorStatus,
  type JiraTransition,
} from "../jira";

/* ------------------------------------------------------------------ */
/*  matchReopenTransition — bilingual name matching (Req 2.1, 3.3)     */
/* ------------------------------------------------------------------ */

test("matchReopenTransition — matches the SRE Spanish transition 'Volver a abrir incidencia'", () => {
  const transitions: JiraTransition[] = [
    { id: "X", name: "Volver a abrir incidencia", to: { statusCategory: { key: "new" } } },
  ];
  const matched = matchReopenTransition(transitions);
  assert.ok(matched, "expected a reopen transition to be matched");
  assert.equal(matched?.id, "X");
});

test("matchReopenTransition — matches Spanish names 'Reabrir' and 'Reabierto'", () => {
  for (const name of ["Reabrir", "Reabierto"]) {
    const transitions: JiraTransition[] = [
      { id: "R", name, to: { statusCategory: { key: "new" } } },
    ];
    const matched = matchReopenTransition(transitions);
    assert.ok(matched, `expected '${name}' to match`);
    assert.equal(matched?.id, "R", `expected '${name}' to return its own transition`);
  }
});

test("matchReopenTransition — matches English names 'Reopen' and 'To Do'", () => {
  for (const name of ["Reopen", "To Do"]) {
    const transitions: JiraTransition[] = [
      { id: "E", name, to: { statusCategory: { key: "new" } } },
    ];
    const matched = matchReopenTransition(transitions);
    assert.ok(matched, `expected '${name}' to match`);
    assert.equal(matched?.id, "E", `expected '${name}' to return its own transition`);
  }
});

test("matchReopenTransition — name match wins over category fallback", () => {
  // The reopen-by-name transition appears AFTER a non-matching one; name match
  // (regex) must take precedence over any category-based fallback.
  const transitions: JiraTransition[] = [
    { id: "OTHER", name: "Escalate", to: { statusCategory: { key: "indeterminate" } } },
    { id: "NAME", name: "Reopen", to: { statusCategory: { key: "new" } } },
  ];
  const matched = matchReopenTransition(transitions);
  assert.equal(matched?.id, "NAME", "expected the name-matched reopen transition to win");
});

/* ------------------------------------------------------------------ */
/*  matchReopenTransition — status-category fallback (Req 2.1, 3.3)    */
/* ------------------------------------------------------------------ */

test("matchReopenTransition — falls back to category 'new' when no name matches", () => {
  const transitions: JiraTransition[] = [
    { id: "TODO", name: "Mover a pila", to: { statusCategory: { key: "new" } } },
  ];
  const matched = matchReopenTransition(transitions);
  assert.ok(matched, "expected the category fallback to match a 'new' transition");
  assert.equal(matched?.id, "TODO");
});

test("matchReopenTransition — falls back to category 'indeterminate' when no name matches", () => {
  const transitions: JiraTransition[] = [
    { id: "PROG", name: "En curso", to: { statusCategory: { key: "indeterminate" } } },
  ];
  const matched = matchReopenTransition(transitions);
  assert.ok(matched, "expected the category fallback to match an 'indeterminate' transition");
  assert.equal(matched?.id, "PROG");
});

/* ------------------------------------------------------------------ */
/*  matchReopenTransition — never selects "done" (Req 2.1, 3.3)        */
/* ------------------------------------------------------------------ */

test("matchReopenTransition — NEVER selects a transition whose destination category is 'done'", () => {
  const transitions: JiraTransition[] = [
    { id: "DONE", name: "Finalizar", to: { statusCategory: { key: "done" } } },
  ];
  const matched = matchReopenTransition(transitions);
  assert.equal(matched, undefined, "a 'done' transition must never be picked as a reopen");
});

test("matchReopenTransition — skips 'done' and picks the 'new' transition via fallback", () => {
  const transitions: JiraTransition[] = [
    { id: "DONE", name: "Cerrar", to: { statusCategory: { key: "done" } } },
    { id: "TODO", name: "Pila de producto", to: { statusCategory: { key: "new" } } },
  ];
  const matched = matchReopenTransition(transitions);
  assert.equal(matched?.id, "TODO", "expected the non-done 'new' transition to be selected");
});

/* ------------------------------------------------------------------ */
/*  matchReopenTransition — empty / no-match handling                  */
/* ------------------------------------------------------------------ */

test("matchReopenTransition — returns undefined for an empty list", () => {
  assert.equal(matchReopenTransition([]), undefined);
});

test("matchReopenTransition — returns undefined when no name matches and no category qualifies", () => {
  const transitions: JiraTransition[] = [
    { id: "DONE", name: "Resolver", to: { statusCategory: { key: "done" } } },
  ];
  assert.equal(matchReopenTransition(transitions), undefined);
});

/* ------------------------------------------------------------------ */
/*  mapJiraErrorStatus — mapping table (Req 2.5)                       */
/* ------------------------------------------------------------------ */

test("mapJiraErrorStatus — maps 4xx to the same code and 5xx to 502", () => {
  const cases: Array<[number, number]> = [
    [400, 400],
    [403, 403],
    [404, 404],
    [500, 502],
    [503, 502],
  ];
  for (const [input, expected] of cases) {
    assert.equal(
      mapJiraErrorStatus(input),
      expected,
      `expected mapJiraErrorStatus(${input}) === ${expected}`,
    );
  }
});
