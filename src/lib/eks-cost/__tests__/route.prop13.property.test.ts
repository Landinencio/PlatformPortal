// Feature: eks-cost-optimization, Property 13: 403 responses never leak cost data
/**
 * Property-based test for the auth/RBAC gate of the `GET /api/finops/k8s-cost`
 * route handler at `src/app/api/finops/k8s-cost/route.ts`.
 *
 * Feature: eks-cost-optimization
 * Property 13: 401/403 responses never leak cost data
 *
 * ## What the property characterises
 *
 * For every session shape whose {@link Session_Role} is inferior to
 * `desarrolladores` — the two cases the design distinguishes:
 *
 *   1. **Anonymous** — `getServerSession(...)` returns `null`. The route
 *      MUST respond `401 { error: "Authentication required" }` per
 *      Requirement 7.1.
 *   2. **`externos`** — the only concrete role strictly below
 *      `desarrolladores` in the RBAC hierarchy (see `src/lib/rbac.ts`
 *      `ROLE_PRIORITY`). The route MUST respond `403 { error: "Access denied" }`
 *      per Requirement 7.2.
 *
 * In BOTH cases the response body MUST expose no cost data whatsoever
 * (Requirement 7.3). The property parameterises over
 * `fc.constantFrom("anonymous", "externos")` — the exhaustive list of
 * cases that must be rejected — and asserts:
 *
 *   - `response.status ∈ {401, 403}` (401 for anonymous, 403 for `externos`).
 *   - `JSON.parse(await response.text())` has its keys ⊆ `{"error"}`.
 *   - None of the seven cost-carrying keys the successful shape uses
 *     (`totalMonthlyEur`, `environments`, `nodegroups`, `squads`,
 *     `workloads`, `recommendations`, `warnings`) appears in the body.
 *
 * The property runs with `numRuns: 100`, well above the two symbolic cases
 * (fast-check will explore both roles many times, together with random
 * query strings) so any regression on either branch surfaces quickly.
 *
 * ## Mocking strategy
 *
 * The route calls `getServerSession(authOptions)` from `next-auth`. In
 * next-auth v4 that named export is a **non-configurable, getter-only**
 * property on the module namespace, so it cannot be re-assigned after the
 * module has been loaded. `node:test`'s `mock.module()` is not available on
 * the Node 20 runtime used by the repo either.
 *
 * We therefore intercept the module ONE step earlier: we prime
 * `require.cache` with a stub {@link Module} entry for both `next-auth` and
 * `next-auth/next` **before** the route (and its transitive `@/lib/auth`
 * dependency) is ever required. `tsx` compiles ES imports of CJS packages
 * as `require("next-auth")` under the hood, so a cache hit is authoritative
 * for the whole process.
 *
 * The stub is a real `Module` instance (with `filename`, `paths`, `loaded`,
 * `exports`) rather than a plain object, so any downstream code that
 * inspects the entry (e.g. the ESM/CJS bridge) survives.
 *
 * Because static `import` declarations are hoisted **above** module
 * top-level code, we deliberately do NOT `import { GET }` from the route:
 * that would be hoisted before our mock is installed and would defeat the
 * whole scheme. The route is loaded lazily via `require(...)` from inside
 * a helper called on the first test iteration.
 *
 * **Validates: Requirements 7.1, 7.2, 7.3**
 */

/* ------------------------------------------------------------------ */
/*  next-auth module stub — MUST execute before the route is required  */
/* ------------------------------------------------------------------ */

// `next/server` (imported below via `require("next/server")`) expects
// `Request`/`Response`/`Headers` to be available as globals. Node 18+
// exposes them natively (that's what CI uses via `node:20-bookworm-slim`);
// on Node 16 they are absent and this test is skipped rather than trying
// to polyfill them (no polyfill dep is available in the portal
// devDependencies, and inventing minimal stubs breaks Next's type checks).
const WEB_API_AVAILABLE = typeof globalThis.Request !== "undefined";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require("module") as typeof import("module");

/** Absolute path of the two next-auth entries the route transitively pulls. */
const NEXT_AUTH_MAIN_PATH = require.resolve("next-auth");
const NEXT_AUTH_NEXT_PATH = require.resolve("next-auth/next");

/**
 * Shared mutable session pointer. Each property iteration writes the value
 * it wants `getServerSession` to return to `mockSession`; the stub always
 * reads from this variable so no per-iteration re-import is needed. Kept
 * scoped to the test file — never leaks out of the process because
 * `node:test` runs each file in its own Node process.
 */
let mockSession: MockSession | null = null;

interface MockSession {
  user?: {
    email?: string;
    appRole?: string;
    roles?: string[];
  };
}

/**
 * Populate `require.cache[filename]` with a fully-formed {@link Module}
 * instance whose `exports` is our mock. Using a real `Module` (with `paths`
 * and `filename`) — instead of a plain object — matters because Node's
 * CJS/ESM bridge and some deep-imports inspect those fields on cached
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

/**
 * The two exports the route imports from next-auth. `default` is a no-op
 * function so any accidental `next-auth`-as-a-function call site (there
 * is none in this route) survives without throwing.
 */
const mockedNextAuthExports = {
  __esModule: true,
  getServerSession: async () => mockSession,
  unstable_getServerSession: async () => mockSession,
  default: function nextAuth() {
    return {};
  },
};

stubCachedModule(NEXT_AUTH_MAIN_PATH, mockedNextAuthExports);
stubCachedModule(NEXT_AUTH_NEXT_PATH, mockedNextAuthExports);

/* ------------------------------------------------------------------ */
/*  Test framework imports — safe: none of them touches next-auth       */
/* ------------------------------------------------------------------ */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

// `NextRequest` is loaded lazily via `require` — a top-level ESM `import`
// would be hoisted and evaluated before the `WEB_API_AVAILABLE` guard, so
// on Node 16 (no `Request` global) `next/server` would explode at parse
// time. When `WEB_API_AVAILABLE` is false the whole test is skipped below
// and this require is never reached.
type NextRequestClass = new (input: string | URL, init?: unknown) => unknown;
let NextRequest: NextRequestClass | null = null;
if (WEB_API_AVAILABLE) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  NextRequest = (require("next/server") as { NextRequest: NextRequestClass }).NextRequest;
}
type NextRequest = InstanceType<NonNullable<typeof NextRequest>>;

/* ------------------------------------------------------------------ */
/*  Lazy route loader                                                   */
/* ------------------------------------------------------------------ */

/**
 * Response shape of the route handler. Kept narrow so this test does not
 * depend on Next's internal type gymnastics.
 */
type RouteHandler = (request: NextRequest) => Promise<Response>;

interface RouteModule {
  GET: RouteHandler;
}

let cachedRoute: RouteModule | null = null;

/**
 * Require the route on first use. `require` (as opposed to `import`) goes
 * through `require.cache`, so the route's own `require("next-auth")` call
 * lands on our stub. `@/*` aliases resolve because `tsx` honours the
 * project's `tsconfig` paths at require time.
 */
function loadRoute(): RouteModule {
  if (!cachedRoute) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedRoute = require("@/app/api/finops/k8s-cost/route") as RouteModule;
  }
  return cachedRoute;
}

/* ------------------------------------------------------------------ */
/*  Cost-carrying keys — must never appear in a 401/403 body            */
/* ------------------------------------------------------------------ */

/**
 * Every top-level key the successful `AllocationResponse` uses to carry
 * cost data (see `src/lib/eks-cost/types.ts` and design.md §Endpoint HTTP
 * > Response 200). Any of these leaking into an unauthorised body would be
 * a Requirement 7.3 breach.
 */
const COST_CARRYING_KEYS: readonly string[] = [
  "totalMonthlyEur",
  "totalNodeCount",
  "totalSpotCoveragePct",
  "totalEstimatedSavingsEur",
  "environments",
  "nodegroups",
  "squads",
  "workloads",
  "recommendations",
  "warnings",
  "generatedAt",
] as const;

/** URL used for every synthetic request. The route only reads query params. */
const ROUTE_URL =
  "https://portal.today.dev.tooling.dp.iskaypet.com/api/finops/k8s-cost";

/* ------------------------------------------------------------------ */
/*  Arbitraries                                                         */
/* ------------------------------------------------------------------ */

/**
 * The two symbolic cases the property parameterises over: anonymous
 * (`getServerSession` returns `null`) and `externos` — the only concrete
 * role in `AppRole` whose `ROLE_PRIORITY` is strictly below the required
 * `desarrolladores` (see `src/lib/rbac.ts`).
 */
type RoleCase = "anonymous" | "externos";
const arbRoleCase: fc.Arbitrary<RoleCase> = fc.constantFrom(
  "anonymous",
  "externos",
);

/**
 * A hardened user email — the value is irrelevant to the auth gate (only
 * the `appRole` is), but a plausible domain keeps the mock realistic.
 */
const arbUserEmail: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z]{2,10}\.[a-z]{2,10}$/)
  .map((local) => `${local}@iskaypet.com`);

/**
 * Additional randomness on top of the role: the URL query string. The 401
 * and 403 branches must fire regardless of what filters the caller
 * passed (the route checks the session before parsing filters), so we
 * throw random query strings at the handler to catch any accidental
 * "filter first, auth later" reordering.
 */
const arbQueryString: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  fc.constant("?env=dev"),
  fc.constant("?env=prod&squad=digital"),
  fc.constant("?nodegroup=main"),
  fc.constant("?env=invalid-value"),
  fc.constant("?env=%3Cscript%3E"), // encoded, to prove no reflection
);

/* ------------------------------------------------------------------ */
/*  Property                                                            */
/* ------------------------------------------------------------------ */

test(
  "Property 13: anonymous and externos never leak cost data (401/403 with only { error })",
  { skip: !WEB_API_AVAILABLE ? "requires Node >= 18 (Request global)" : false },
  async () => {
    await fc.assert(
      fc.asyncProperty(
        arbRoleCase,
        arbUserEmail,
        arbQueryString,
        async (roleCase, email, qs) => {
          // Configure the mocked getServerSession for this iteration.
          if (roleCase === "anonymous") {
            mockSession = null;
          } else {
            mockSession = {
              user: { email, appRole: "externos", roles: [] },
            };
          }

          if (!NextRequest) return; // Skip guard — never reached when WEB_API_AVAILABLE is true.
          const request = new NextRequest(`${ROUTE_URL}${qs}`) as unknown as Parameters<
            typeof GET
          >[0];
          const { GET } = loadRoute();
          const response = await GET(request);

          // ---- 1. Status is the expected reject status ---------------
          const expectedStatus = roleCase === "anonymous" ? 401 : 403;
          assert.equal(
            response.status,
            expectedStatus,
            `role ${roleCase} must produce ${expectedStatus}, got ${response.status}`,
          );

          // ---- 2. Body is valid JSON with keys ⊆ { "error" } ---------
          //     Deliberately go through the raw text so we can verify the
          //     serialised payload the client actually sees, not just the
          //     in-memory value.
          const bodyText = await response.text();
          const body = JSON.parse(bodyText) as Record<string, unknown>;

          assert.equal(
            typeof body,
            "object",
            "response body must be a JSON object",
          );
          assert.ok(body !== null, "response body must not be null");

          const keys = Object.keys(body);
          const extraneous = keys.filter((k) => k !== "error");
          assert.deepStrictEqual(
            extraneous,
            [],
            `unauthorised body must contain ONLY "error", got extraneous keys: ${JSON.stringify(extraneous)}`,
          );

          // The single legal key must be a non-empty string.
          assert.equal(
            typeof body.error,
            "string",
            `body.error must be a string, got ${typeof body.error}`,
          );
          assert.ok(
            (body.error as string).length > 0,
            "body.error must be a non-empty string",
          );

          // ---- 3. None of the cost-carrying keys appears --------------
          for (const costKey of COST_CARRYING_KEYS) {
            assert.ok(
              !(costKey in body),
              `unauthorised body must not contain cost-carrying key "${costKey}"`,
            );
          }

          // ---- 4. Belt and braces: the serialised text does not carry --
          //     any of the successful response's characteristic labels.
          //     This catches an implementation that puts cost data in a
          //     nested field (e.g. { error: "...", details: { environments: [] } }).
          for (const costKey of COST_CARRYING_KEYS) {
            assert.ok(
              !bodyText.includes(`"${costKey}"`),
              `unauthorised body text must not mention cost-carrying key "${costKey}"; got: ${bodyText}`,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  },
);
