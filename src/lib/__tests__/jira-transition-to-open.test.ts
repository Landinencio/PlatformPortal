/**
 * Unit tests — `jiraTransitionToOpen` branches (spec: ticket-reopen-comment-fix, task 5).
 *
 * Sibling of `jira-reopen.test.ts` (task 4, which covers the pure helpers
 * `matchReopenTransition` + `mapJiraErrorStatus`). This file exercises the
 * 4 branches of the `TransitionResult` returned by `jiraTransitionToOpen`,
 * driving them by mocking the global `fetch` that the module-private
 * `jiraFetch` relies on:
 *
 *  1. `GET .../transitions` not-OK            → { ok:false, matched:false, transitioned:false, status, message }
 *  2. `GET` OK but no reopen transition match → { ok:false, matched:false, transitioned:false, message:<available names> }
 *  3. `GET` OK + match, `POST` execution not-OK → { ok:false, matched:true, transitioned:false, status }
 *  4. `GET` OK + match + `POST` OK (200 / 204)  → { ok:true, matched:true, transitioned:true }
 *
 * Conventions: `node:test` + `node:assert/strict`, run with `tsx`.
 * The global `fetch` is saved/restored around every test (no real network).
 *
 * Validates: Requirements 2.1, 2.2, 2.3
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { jiraTransitionToOpen } from "../jira";

/* ------------------------------------------------------------------ */
/*  Minimal fetch-Response stubs (no network)                          */
/* ------------------------------------------------------------------ */

type FetchStub = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

function jsonResponse(status: number, body: unknown): FetchStub {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(status: number, body: string): FetchStub {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => {
      throw new Error("not json");
    },
  };
}

const realFetch = globalThis.fetch;

/**
 * Install a `globalThis.fetch` that returns the provided responses in order
 * (one per call). Records the calls so assertions can verify GET/POST count.
 */
function installFetchSequence(responses: FetchStub[]): Array<{ url: string; method: string }> {
  const calls: Array<{ url: string; method: string }> = [];
  let i = 0;
  globalThis.fetch = (async (url: unknown, options?: { method?: string }) => {
    calls.push({ url: String(url), method: options?.method ?? "GET" });
    const res = responses[i++];
    if (!res) throw new Error(`Unexpected fetch call #${i} (no stubbed response)`);
    return res as unknown as Response;
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* ------------------------------------------------------------------ */
/*  Branch 1 — GET transitions not-OK (Req 2.1)                        */
/* ------------------------------------------------------------------ */

test("jiraTransitionToOpen — branch 1: GET transitions not-OK returns ok/matched/transitioned false with status+message", async () => {
  const calls = installFetchSequence([textResponse(500, "upstream boom")]);

  const result = await jiraTransitionToOpen("SRE-1");

  assert.deepEqual(result, {
    ok: false,
    matched: false,
    transitioned: false,
    status: 500,
    message: "upstream boom",
  });
  // Only the GET should have fired — no POST after a failed transitions fetch.
  assert.equal(calls.length, 1, "expected a single GET call");
  assert.equal(calls[0].method, "GET");
});

/* ------------------------------------------------------------------ */
/*  Branch 2 — GET OK but no reopen transition matches (Req 2.1)       */
/* ------------------------------------------------------------------ */

test("jiraTransitionToOpen — branch 2: no reopen match returns matched:false with available names in message", async () => {
  const calls = installFetchSequence([
    jsonResponse(200, {
      transitions: [
        { id: "31", name: "Finalizar", to: { statusCategory: { key: "done" } } },
        { id: "41", name: "Resolver", to: { statusCategory: { key: "done" } } },
      ],
    }),
  ]);

  const result = await jiraTransitionToOpen("SRE-2");

  assert.equal(result.ok, false);
  assert.equal(result.matched, false);
  assert.equal(result.transitioned, false);
  assert.equal(result.status, undefined, "no upstream status when nothing matched");
  assert.ok(result.message, "expected a diagnostic message");
  assert.match(result.message!, /No reopen transition/);
  assert.match(result.message!, /Finalizar/, "available transition names must be listed");
  assert.match(result.message!, /Resolver/);
  // Only the GET should have fired — no POST when there is no match.
  assert.equal(calls.length, 1, "expected a single GET call");
});

/* ------------------------------------------------------------------ */
/*  Branch 3 — GET OK + match, POST execution not-OK (Req 2.2, 2.3)    */
/* ------------------------------------------------------------------ */

test("jiraTransitionToOpen — branch 3: POST execution not-OK returns matched:true, transitioned:false with real status", async () => {
  const calls = installFetchSequence([
    jsonResponse(200, {
      transitions: [
        { id: "11", name: "Volver a abrir incidencia", to: { statusCategory: { key: "new" } } },
      ],
    }),
    textResponse(409, "transition not allowed"),
  ]);

  const result = await jiraTransitionToOpen("SRE-3");

  assert.deepEqual(result, {
    ok: false,
    matched: true,
    transitioned: false,
    status: 409,
    message: "transition not allowed",
  });
  // GET transitions + POST transition.
  assert.equal(calls.length, 2, "expected GET then POST");
  assert.equal(calls[1].method, "POST");
});

/* ------------------------------------------------------------------ */
/*  Branch 4 — GET OK + match + POST OK (200 / 204) (Req 2.2)          */
/* ------------------------------------------------------------------ */

test("jiraTransitionToOpen — branch 4a: POST 200 returns ok/matched/transitioned all true", async () => {
  const calls = installFetchSequence([
    jsonResponse(200, {
      transitions: [
        { id: "11", name: "Reopen", to: { statusCategory: { key: "new" } } },
      ],
    }),
    jsonResponse(200, { done: true }),
  ]);

  const result = await jiraTransitionToOpen("SRE-4");

  assert.deepEqual(result, {
    ok: true,
    matched: true,
    transitioned: true,
    status: 200,
  });
  assert.equal(calls.length, 2, "expected GET then POST");
  assert.equal(calls[1].method, "POST");
});

test("jiraTransitionToOpen — branch 4b: POST 204 (No Content) returns ok/matched/transitioned all true", async () => {
  installFetchSequence([
    jsonResponse(200, {
      transitions: [
        { id: "21", name: "Volver a abrir incidencia", to: { statusCategory: { key: "new" } } },
      ],
    }),
    // 204: a real Response has ok=true for 2xx; the helper also treats 204 as success.
    textResponse(204, ""),
  ]);

  const result = await jiraTransitionToOpen("SRE-5");

  assert.deepEqual(result, {
    ok: true,
    matched: true,
    transitioned: true,
    status: 204,
  });
});
