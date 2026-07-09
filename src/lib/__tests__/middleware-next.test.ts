// Feature: session-nav-hardening, Task 13.2: Test del middleware
/**
 * Example-based integration tests (node:test, run via `tsx --test`) for the
 * `middleware` function at the project root `middleware.ts`, which integrates
 * `buildNextParam` from `@/lib/navigation/internal-path`.
 *
 * Feature: session-nav-hardening
 *
 * ## What these tests characterise
 *
 *   1. **Ruta_Protegida sin token → redirect a `/` con `?next=` válido**
 *      (Requirements 3.1, 3.2). A page navigation to a protected route with no
 *      session token MUST 3xx-redirect to the public home `/` carrying a `next`
 *      query param whose decoded value round-trips to the original
 *      pathname + search (via `resolveNextParam`).
 *   2. **`/api/*` protegida sin token → 401** (Requirement 3.5). A protected API
 *      route with no token MUST return `401 { error: "Authentication required" }`
 *      without redirecting.
 *   3. **`/api/*` con token pero rol insuficiente → 403** (Requirement 3.6). A
 *      protected API route reached with a valid token whose role is below the
 *      required minimum MUST return `403 { error: "Insufficient permissions" }`.
 *
 * **Validates: Requirements 3.1, 3.2, 3.5, 3.6**
 *
 * ## Mocking strategy
 *
 * `middleware.ts` calls `getToken({ req })` from `next-auth/jwt`. In this repo's
 * Node runtime `node:test`'s `mock.module()` is unavailable (see
 * `src/lib/__tests__/cur-direct-route.test.ts` and
 * `src/lib/eks-cost/__tests__/route.prop13.property.test.ts`), so we intercept
 * one step earlier: we prime `require.cache` with a real `Module` stub for
 * `next-auth/jwt` **before** the middleware is ever required. `tsx` compiles ES
 * imports of CJS packages as `require(...)` under the hood, so a cache hit is
 * authoritative for the whole process. A shared mutable `mockToken` pointer lets
 * each test drive `getToken`'s return value.
 *
 * Because static `import` declarations are hoisted above module top-level code,
 * we do NOT `import` the middleware: it is loaded lazily via `require(...)`
 * from a helper so the stub is guaranteed to be installed first.
 */

/* ------------------------------------------------------------------ */
/*  next-auth/jwt module stub — MUST run before the middleware loads    */
/* ------------------------------------------------------------------ */

// `next/server` (loaded lazily via require below) expects Web API globals
// (`Request`/`Response`/`Headers`). Node 18+ exposes them natively (CI uses
// `node:20-bookworm-slim`); on Node 16 they are absent and the tests are
// skipped rather than polyfilled.
const WEB_API_AVAILABLE = typeof globalThis.Request !== "undefined";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require("module") as typeof import("module");

/** Absolute path of the next-auth/jwt entry the middleware imports. */
const NEXT_AUTH_JWT_PATH = require.resolve("next-auth/jwt");

/**
 * Shape of the JWT token the middleware reads. Only `appRole`/`roles` matter
 * for the RBAC gate (see `@/lib/rbac` `roleFromTokenData`).
 */
interface MockToken {
  appRole?: string;
  roles?: string[];
}

/**
 * Shared mutable token pointer. Each test writes the value it wants
 * `getToken` to return here; the stub always reads from this variable so no
 * per-test re-import is needed. Scoped to this file — `node:test` runs each
 * file in its own process, so it never leaks.
 */
let mockToken: MockToken | null = null;

/**
 * Populate `require.cache[filename]` with a fully-formed `Module` instance
 * whose `exports` is our mock. A real `Module` (with `paths`/`filename`)
 * matters because Node's CJS/ESM bridge inspects those fields on cached
 * entries; a bare `{ exports }` object breaks them.
 */
function stubCachedModule(filename: string, exports: unknown): void {
  const stub = new Module(filename, null);
  stub.filename = filename;
  stub.loaded = true;
  stub.paths = (Module as unknown as {
    _nodeModulePaths(from: string): string[];
  })._nodeModulePaths(filename);
  stub.exports = exports;
  (require as unknown as { cache: Record<string, NodeJS.Module> }).cache[
    filename
  ] = stub;
}

const mockedJwtExports = {
  __esModule: true,
  getToken: async () => mockToken,
};

stubCachedModule(NEXT_AUTH_JWT_PATH, mockedJwtExports);

/* ------------------------------------------------------------------ */
/*  Test framework imports — safe: none of them touches next-auth/jwt   */
/* ------------------------------------------------------------------ */

import test from "node:test";
import assert from "node:assert/strict";
import { resolveNextParam } from "@/lib/navigation/internal-path";

/* ------------------------------------------------------------------ */
/*  Lazy loaders (require, so require.cache hits our stub)              */
/* ------------------------------------------------------------------ */

const ORIGIN = "https://portal.today.dev.tooling.dp.iskaypet.com";

type NextRequestClass = new (input: string | URL, init?: unknown) => unknown;
let NextRequest: NextRequestClass | null = null;
if (WEB_API_AVAILABLE) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  NextRequest = (require("next/server") as { NextRequest: NextRequestClass })
    .NextRequest;
}

type MiddlewareFn = (request: unknown) => Promise<Response>;
let cachedMiddleware: MiddlewareFn | null = null;

/**
 * Require the middleware on first use. `require` goes through `require.cache`,
 * so the middleware's own `require("next-auth/jwt")` lands on our stub. `@/*`
 * aliases inside the middleware resolve via `tsx`'s tsconfig paths.
 */
function loadMiddleware(): MiddlewareFn {
  if (!cachedMiddleware) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedMiddleware = (require("../../../middleware") as {
      middleware: MiddlewareFn;
    }).middleware;
  }
  return cachedMiddleware;
}

/** Build a NextRequest for an absolute portal URL (path + optional query). */
function makeRequest(pathAndQuery: string): unknown {
  if (!NextRequest) throw new Error("NextRequest unavailable");
  return new NextRequest(`${ORIGIN}${pathAndQuery}`);
}

const SKIP = !WEB_API_AVAILABLE
  ? "requires Node >= 18 (Request global)"
  : false;

/* ------------------------------------------------------------------ */
/*  Case 1 — protected page, no token → redirect to / with ?next=      */
/*  Requirements 3.1, 3.2                                               */
/* ------------------------------------------------------------------ */

test(
  "protected page without token redirects to / with a valid ?next= (3.1/3.2)",
  { skip: SKIP },
  async () => {
    mockToken = null;
    const middleware = loadMiddleware();

    const response = await middleware(makeRequest("/metrics"));

    // 3.1 — must be a redirect (3xx), not a rendered page.
    assert.ok(
      response.status >= 300 && response.status < 400,
      `expected a 3xx redirect, got ${response.status}`,
    );

    const location = response.headers.get("location");
    assert.ok(location, "redirect must carry a Location header");

    const redirectUrl = new URL(location as string);
    // Destination is the public home `/` on the same origin (3.1).
    assert.equal(redirectUrl.origin, ORIGIN, "redirect must stay same-origin");
    assert.equal(redirectUrl.pathname, "/", "redirect target must be `/`");

    // 3.2 — the `next` param is present and round-trips to the Ruta_Previa.
    const next = redirectUrl.searchParams.get("next");
    assert.ok(next, "redirect must carry a non-empty `next` param");
    assert.equal(
      resolveNextParam(next),
      "/metrics",
      "`next` must decode back to the original protected path",
    );
  },
);

test(
  "protected page with query string preserves pathname + search in ?next= (3.2)",
  { skip: SKIP },
  async () => {
    mockToken = null;
    const middleware = loadMiddleware();

    const response = await middleware(makeRequest("/synthetics?tab=lighthouse"));

    assert.ok(
      response.status >= 300 && response.status < 400,
      `expected a 3xx redirect, got ${response.status}`,
    );
    const location = response.headers.get("location");
    assert.ok(location, "redirect must carry a Location header");

    const redirectUrl = new URL(location as string);
    assert.equal(redirectUrl.pathname, "/");
    const next = redirectUrl.searchParams.get("next");
    assert.ok(next, "redirect must carry a non-empty `next` param");
    assert.equal(
      resolveNextParam(next),
      "/synthetics?tab=lighthouse",
      "`next` must preserve both pathname and query string",
    );
  },
);

/* ------------------------------------------------------------------ */
/*  Case 2 — protected /api/* without token → 401                      */
/*  Requirement 3.5                                                    */
/* ------------------------------------------------------------------ */

test(
  "protected /api/* without token responds 401 without redirecting (3.5)",
  { skip: SKIP },
  async () => {
    mockToken = null;
    const middleware = loadMiddleware();

    const response = await middleware(makeRequest("/api/finops/costs"));

    assert.equal(response.status, 401, "missing token on /api/* must be 401");
    assert.equal(
      response.headers.get("location"),
      null,
      "401 must not redirect",
    );

    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.error, "Authentication required");
  },
);

/* ------------------------------------------------------------------ */
/*  Case 3 — protected /api/* with insufficient role → 403             */
/*  Requirement 3.6                                                    */
/* ------------------------------------------------------------------ */

test(
  "protected /api/* with insufficient role responds 403 (3.6)",
  { skip: SKIP },
  async () => {
    // `/api/admin` requires `admin`; `externos` is strictly below it in the
    // RBAC hierarchy (see `@/lib/rbac` ROLE_PRIORITY) → must be rejected 403.
    mockToken = { appRole: "externos", roles: [] };
    const middleware = loadMiddleware();

    const response = await middleware(makeRequest("/api/admin/users"));

    assert.equal(
      response.status,
      403,
      "insufficient role on /api/* must be 403",
    );
    assert.equal(
      response.headers.get("location"),
      null,
      "403 must not redirect",
    );

    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.error, "Insufficient permissions");
  },
);

/* ------------------------------------------------------------------ */
/*  Sanity — sufficient role passes through (no 401/403, no redirect)  */
/* ------------------------------------------------------------------ */

test(
  "protected /api/* with sufficient role passes through",
  { skip: SKIP },
  async () => {
    mockToken = { appRole: "admin", roles: [] };
    const middleware = loadMiddleware();

    const response = await middleware(makeRequest("/api/admin/users"));

    // NextResponse.next() → not a 401/403 and not a redirect.
    assert.notEqual(response.status, 401);
    assert.notEqual(response.status, 403);
    assert.equal(response.headers.get("location"), null);
  },
);
