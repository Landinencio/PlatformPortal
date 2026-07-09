/**
 * Unit tests for the Kiro Analytics API role gate (spec: managers-role, task 3.4).
 *
 * These are example-based tests (node:test, run via `tsx --test`). They verify the
 * `guard()` decision matrix for `/api/kiro-analytics/*`:
 *   - no session            → 401
 *   - staff / desarrolladores / externos → 403
 *   - managers / directores / admin      → ok
 * plus an explicit assertion that the shared minimum-role constant is `"managers"`
 * (the Requirement 4.2 change, directores → managers).
 *
 * Why a faithful mirror of `guard()` instead of driving it directly:
 * `guard()` opens with `getServerSession(authOptions)`. In next-auth v4,
 * `getServerSession` is a **non-configurable, getter-only** named export, and in
 * App-Router mode it reads cookies through `next/headers`, which requires a live
 * request scope that does not exist inside `node:test`. On this repo's Node runtime
 * `mock.module` is also unavailable (see `src/lib/__tests__/cur-direct-route.test.ts`),
 * so the session boundary cannot be faked to drive the real handler.
 *
 * Therefore `guardWith(session)` below is a faithful, line-by-line mirror of the
 * `guard()` body *after* the `getServerSession` call, built EXCLUSIVELY from the
 * SAME building blocks the real guard imports:
 *   - the REAL `KIRO_ANALYTICS_MIN_ROLE` constant (imported from `_shared.ts`),
 *   - the REAL `getSessionRole` + `hasMinimumRole` (from `@/lib/session-role`),
 *   - the REAL `NextResponse` (from `next/server`).
 * The only thing not exercised is the untestable `getServerSession` wiring itself;
 * the session is injected instead. This is the same technique the repo's other
 * route tests use.
 *
 * `next/server` (pulled transitively via `../_shared`) expects `Request`/`Response`/
 * `Headers` as globals. Node 18+ exposes them natively (CI uses `node:20-bookworm-slim`);
 * on Node 16 they are absent, so — exactly like the repo's eks-cost route tests — we
 * guard the `next/server`-dependent imports behind `WEB_API_AVAILABLE`, lazy-`require`
 * them, and skip the cases on Node 16 rather than exploding at parse time. This keeps
 * the file safe inside the `npm test` glob on any Node version.
 *
 * _Requirements: 4.5, 4.7_
 */

// `next/server` needs the Web `Request` global (Node 18+). Compute availability
// BEFORE any static import so a hoisted `import` of a next/server-dependent module
// cannot blow up on Node 16.
const WEB_API_AVAILABLE = typeof (globalThis as { Request?: unknown }).Request !== "undefined";

import test from "node:test";
import assert from "node:assert/strict";
import type { Session } from "next-auth";

import { getSessionRole, hasMinimumRole } from "@/lib/session-role";
import type { AppRole } from "@/lib/rbac";

/* ------------------------------------------------------------------ */
/*  Lazy imports of the next/server-dependent bits (Node 18+ only)      */
/* ------------------------------------------------------------------ */

interface NextResponseStatic {
  json(body: unknown, init?: { status?: number }): { status: number; json(): Promise<unknown> };
}

let NextResponse: NextResponseStatic | null = null;
// The REAL constant under test, imported from `_shared.ts` (which imports next/server).
let KIRO_ANALYTICS_MIN_ROLE: AppRole | null = null;

if (WEB_API_AVAILABLE) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  NextResponse = (require("next/server") as { NextResponse: NextResponseStatic }).NextResponse;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  KIRO_ANALYTICS_MIN_ROLE = (require("../_shared") as { KIRO_ANALYTICS_MIN_ROLE: AppRole }).KIRO_ANALYTICS_MIN_ROLE;
}

const skipOpts = { skip: WEB_API_AVAILABLE ? false : "requires Web API globals (Node 18+)" };

/* ------------------------------------------------------------------ */
/*  Faithful mirror of guard()'s body (after the getServerSession call) */
/* ------------------------------------------------------------------ */

type GuardResponse = ReturnType<NextResponseStatic["json"]>;
type GuardResult = { ok: true } | { ok: false; response: GuardResponse };

/**
 * Mirror of `guard()` in `_shared.ts` with the session injected. Uses the SAME
 * constant/functions/response type the real guard uses, so the 401/403/ok decision
 * and status codes are identical.
 */
function guardWith(session: Session | null): GuardResult {
  if (!session?.user) {
    return {
      ok: false,
      response: NextResponse!.json({ error: "Authentication required" }, { status: 401 }),
    };
  }
  const role = getSessionRole(session);
  if (!hasMinimumRole(role, KIRO_ANALYTICS_MIN_ROLE!)) {
    return {
      ok: false,
      response: NextResponse!.json(
        { error: "Insufficient permissions", required: KIRO_ANALYTICS_MIN_ROLE },
        { status: 403 },
      ),
    };
  }
  return { ok: true };
}

/** Build a minimal authenticated Session carrying the given resolved appRole. */
function sessionWithRole(appRole: AppRole): Session {
  return {
    user: { name: "Test User", email: "test@iskaypet.com", appRole },
    expires: "2999-01-01T00:00:00.000Z",
  } as unknown as Session;
}

/* ------------------------------------------------------------------ */
/*  The change under test: the shared minimum-role constant             */
/* ------------------------------------------------------------------ */

test("KIRO_ANALYTICS_MIN_ROLE is exactly \"managers\" (Req 4.2)", skipOpts, () => {
  assert.equal(KIRO_ANALYTICS_MIN_ROLE, "managers");
});

/* ------------------------------------------------------------------ */
/*  401 — no session                                                    */
/* ------------------------------------------------------------------ */

test("guard() returns 401 when there is no session (Req 4.7)", skipOpts, () => {
  const result = guardWith(null);
  assert.equal(result.ok, false);
  assert.equal((result as { ok: false; response: GuardResponse }).response.status, 401);
});

test("guard() returns 401 when the session has no user (Req 4.7)", skipOpts, () => {
  const result = guardWith({ expires: "2999-01-01T00:00:00.000Z" } as unknown as Session);
  assert.equal(result.ok, false);
  assert.equal((result as { ok: false; response: GuardResponse }).response.status, 401);
});

/* ------------------------------------------------------------------ */
/*  403 — insufficient role                                             */
/* ------------------------------------------------------------------ */

for (const role of ["staff", "desarrolladores", "externos"] as const) {
  test(`guard() returns 403 for role "${role}" (Req 4.7)`, skipOpts, () => {
    const result = guardWith(sessionWithRole(role));
    assert.equal(result.ok, false);
    const response = (result as { ok: false; response: GuardResponse }).response;
    assert.equal(response.status, 403);
  });
}

/* ------------------------------------------------------------------ */
/*  ok — sufficient role                                                */
/* ------------------------------------------------------------------ */

for (const role of ["managers", "directores", "admin"] as const) {
  test(`guard() allows role "${role}" (Req 4.5)`, skipOpts, () => {
    const result = guardWith(sessionWithRole(role));
    assert.equal(result.ok, true);
  });
}

/* ------------------------------------------------------------------ */
/*  Capitalised appRole from Azure AD normalises correctly              */
/* ------------------------------------------------------------------ */

test('guard() allows a capitalised "Managers" appRole (getSessionRole lowercases it)', skipOpts, () => {
  const session = { user: { appRole: "Managers" }, expires: "2999-01-01T00:00:00.000Z" } as unknown as Session;
  const result = guardWith(session);
  assert.equal(result.ok, true);
});

/* ------------------------------------------------------------------ */
/*  403 body carries the required role for observability                */
/* ------------------------------------------------------------------ */

test("guard() 403 response reports the required role as \"managers\"", skipOpts, async () => {
  const result = guardWith(sessionWithRole("staff"));
  assert.equal(result.ok, false);
  const response = (result as { ok: false; response: GuardResponse }).response;
  const body = (await response.json()) as { required?: string };
  assert.equal(body.required, "managers");
});
