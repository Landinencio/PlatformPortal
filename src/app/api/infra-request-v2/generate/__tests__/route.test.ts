/**
 * Integration tests for `POST /api/infra-request-v2/generate` — the IAM-role
 * branch that either generates least-privilege IRSA HCL deterministically from
 * the curated Catálogo_IAM, or delegates to the Bedrock `InfraAgent` when the
 * selection is not covered by the catalog.
 *
 * Feature: iam-role-least-privilege (task 7.2).
 * _Requirements: 4.1, 4.5, 4.9, 7.3_
 *
 * ## Mocking strategy
 *
 * The real route handler (`src/app/api/infra-request-v2/generate/route.ts`) is
 * tightly coupled to next-auth (`requireUserAuth`), PostgreSQL (`repoCatalog`
 * → `pool`), the Bedrock `InfraAgent`, and the GitLab client. To drive the
 * handler deterministically and offline we prime `require.cache` with real
 * {@link Module} stubs for those boundary modules **before** the route is ever
 * required. `tsx` compiles ES imports of these `@/*` modules as `require(...)`
 * under the hood, so a cache hit is authoritative for the whole process — this
 * is the same one-step-earlier interception the repo's other route tests use
 * (see `src/lib/eks-cost/__tests__/route.prop13.property.test.ts`).
 *
 * Everything that is *pure* (the Catálogo_IAM, the deterministic generator, the
 * field validators, the rate limiter, the prompt builder, the feature flags) is
 * left REAL so the test exercises the genuine decision logic. The route is
 * loaded lazily via `require(...)` (never a hoisted static `import`) so the
 * stubs are guaranteed to be installed first.
 *
 * ## Note on the "unknown preset id" case
 *
 * The route only calls `generateIamRoleHcl` when `isCoveredByCatalog(selections)`
 * is true. A selection that references an id absent from the catalog is
 * therefore NOT covered, and per design Requirement 4.5 the request is delegated
 * to the `InfraAgent` (never producing a `422 unknown_preset`). The route's
 * `unknown_preset → 422` translation is unreachable given this gating. The test
 * below (`test C`) asserts the route's ACTUAL, design-consistent behaviour
 * (delegation to the InfraAgent). The genuinely reachable generator-error → 422
 * path is `invalid_scope`, covered by `test E`.
 */

/* ------------------------------------------------------------------ */
/*  Boundary-module stubs — MUST run before the route is required.     */
/* ------------------------------------------------------------------ */

// The route calls `NextResponse.json(...)`, which needs the `Response`/`Request`
// web globals. Node 18+ (CI uses node:20) exposes them natively; on older Node
// they are absent and the suite is skipped rather than exploding at parse time.
const WEB_API_AVAILABLE = typeof globalThis.Request !== "undefined";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require("module") as typeof import("module");

/** Install a real Module instance into require.cache so imports hit our stub. */
function stubCachedModule(specifier: string, exports: unknown): void {
  const filename = require.resolve(specifier);
  const stub = new Module(filename, null);
  stub.filename = filename;
  stub.loaded = true;
  stub.paths = (
    Module as unknown as { _nodeModulePaths(from: string): string[] }
  )._nodeModulePaths(filename);
  stub.exports = exports;
  (require as unknown as { cache: Record<string, NodeJS.Module> }).cache[filename] =
    stub;
}

/* ---- Shared mutable test doubles (reset per test) ---- */

interface MockSession {
  user?: { email?: string; appRole?: string; roles?: string[] };
}
let mockSession: MockSession | null = null;

const mockCatalogEntry = {
  id: 1,
  team: "digital",
  gitlabProjectId: 12345,
  defaultBranch: "main",
  infraRootPath: "iac",
  description: null,
  active: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

/** Records every InfraAgent construction + run so tests can assert delegation. */
let infraAgentConstructed = 0;
let infraAgentRunCalls: unknown[] = [];

class MockInfraAgent {
  constructor(_opts: unknown) {
    infraAgentConstructed += 1;
  }
  async run(input: unknown): Promise<{ reply: string; terraformPreview: unknown }> {
    infraAgentRunCalls.push(input);
    return {
      reply: "mock agent reply",
      terraformPreview: {
        filePath: "iac/roles/roles.tf",
        content: 'resource "aws_iam_role" "delegated" {}',
        resourceType: "iam_role",
        resourceName: "delegated",
        targetEnvironments: ["dev"],
        estimatedCostMonthly: 0,
      },
    };
  }
}

// --- api-auth: always authenticate, hand back the per-test session. ---
stubCachedModule("@/lib/api-auth", {
  __esModule: true,
  requireUserAuth: async () => ({ session: mockSession, error: null }),
  requireInternalAuth: () => ({ error: null }),
  requireAnyAuth: async () => ({ error: null }),
});

// --- repo-catalog: return a fixed entry, no DB. ---
stubCachedModule("@/lib/repo-catalog", {
  __esModule: true,
  repoCatalog: { getByTeam: async () => mockCatalogEntry },
});

// --- infra-agent: instrumented mock so we can assert (non-)delegation. ---
stubCachedModule("@/lib/infra-agent", {
  __esModule: true,
  InfraAgent: MockInfraAgent,
});

// --- boundary modules only touched on other branches / when the hardening ---
// --- flag is on (off by default here): stub to keep the test hermetic. ---
stubCachedModule("@/lib/gitlab", { __esModule: true, gitlabClient: {} });
stubCachedModule("@/lib/rds/rds-generator", {
  __esModule: true,
  RdsGenerator: class {},
});
stubCachedModule("@/lib/infra/duplicate-guard", {
  __esModule: true,
  validateIdentifier: () => ({ ok: true, value: "" }),
  checkDuplicate: async () => ({}),
});

/* ------------------------------------------------------------------ */
/*  Test framework imports (safe — touch none of the stubbed modules). */
/* ------------------------------------------------------------------ */

import test from "node:test";
import assert from "node:assert/strict";

/* ------------------------------------------------------------------ */
/*  Lazy route loader                                                  */
/* ------------------------------------------------------------------ */

type PostHandler = (request: Request) => Promise<Response>;
let cachedPost: PostHandler | null = null;

function loadPost(): PostHandler {
  if (!cachedPost) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@/app/api/infra-request-v2/generate/route") as {
      POST: PostHandler;
    };
    cachedPost = mod.POST;
  }
  return cachedPost;
}

const ROUTE_URL =
  "https://portal.today.dev.tooling.dp.iskaypet.com/api/infra-request-v2/generate";

/** Build a POST Request with a JSON body and set the per-test session email. */
function makeRequest(payload: unknown, email: string): Request {
  mockSession = { user: { email } };
  return new Request(ROUTE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** Reset the InfraAgent spies before each scenario. */
function resetSpies(): void {
  infraAgentConstructed = 0;
  infraAgentRunCalls = [];
}

/* ================================================================== */
/*  Test A — covered selection → deterministic HCL, no InfraAgent      */
/*  (R4.1)                                                             */
/* ================================================================== */

test(
  "A: a fully-covered preset selection returns deterministic IRSA HCL (iac/services/roles.tf) without invoking the InfraAgent (R4.1)",
  { skip: !WEB_API_AVAILABLE ? "requires Node >= 18 (Request global)" : false },
  async () => {
    resetSpies();
    const POST = loadPost();

    const request = makeRequest(
      {
        team: "digital",
        resourceType: "iam_role",
        targetEnvironments: ["dev"],
        fields: {
          roleName: "my-app-role",
          namespace: "my-namespace",
          presetSelections: [
            { presetId: "s3-read-only" },
            { presetId: "sqs-consumer" },
          ],
        },
      },
      "covered@iskaypet.com",
    );

    const response = await POST(request);
    assert.equal(response.status, 200, "covered selection must return 200");

    const body = (await response.json()) as {
      terraformPreview: {
        filePath: string;
        content: string;
        resourceType: string;
        resourceName: string;
      };
      aiReply: string;
    };

    // Deterministic preview at the canonical roles file.
    assert.equal(body.terraformPreview.filePath, "iac/services/roles.tf");
    assert.equal(body.terraformPreview.resourceType, "iam_role");
    assert.equal(body.terraformPreview.resourceName, "my-app-role");

    // HCL follows the native IRSA pattern (role + trust template + policy).
    const hcl = body.terraformPreview.content;
    assert.match(hcl, /resource "aws_iam_role" "my-app-role"/);
    assert.match(
      hcl,
      /templatefile\("role_templates\/iskaypet_dh_access\.json\.tmpl"/,
    );
    assert.match(hcl, /resource "aws_iam_policy" "my-app-role"/);
    assert.match(hcl, /resource "aws_iam_role_policy_attachment" "my-app-role"/);

    // The InfraAgent must NOT have been touched on the deterministic path.
    assert.equal(infraAgentConstructed, 0, "InfraAgent must not be constructed");
    assert.equal(infraAgentRunCalls.length, 0, "InfraAgent.run must not be called");
  },
);

/* ================================================================== */
/*  Test B — legacy free-text request → delegates to InfraAgent (R4.5) */
/* ================================================================== */

test(
  "B: an iam_role request with no structured presetSelections (legacy free-text) delegates to the InfraAgent (R4.5)",
  { skip: !WEB_API_AVAILABLE ? "requires Node >= 18 (Request global)" : false },
  async () => {
    resetSpies();
    const POST = loadPost();

    const request = makeRequest(
      {
        team: "digital",
        resourceType: "iam_role",
        targetEnvironments: ["dev"],
        fields: {
          roleName: "legacy-role",
          namespace: "legacy-ns",
          // no presetSelections → not covered → InfraAgent
          permissions: ["read from s3", "write to a queue"],
        },
      },
      "legacy@iskaypet.com",
    );

    const response = await POST(request);
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      terraformPreview: { filePath: string } | null;
      aiReply: string;
    };

    assert.equal(infraAgentConstructed, 1, "InfraAgent must be constructed once");
    assert.equal(infraAgentRunCalls.length, 1, "InfraAgent.run must be called once");
    assert.equal(body.aiReply, "mock agent reply");
    assert.equal(body.terraformPreview?.filePath, "iac/roles/roles.tf");
  },
);

/* ================================================================== */
/*  Test C — unknown preset id → NOT covered → delegates to InfraAgent */
/*  (R4.5)                                                             */
/*                                                                     */
/*  NOTE: task 7.2 lists this case as "422 unknown_preset", but the    */
/*  route gates generateIamRoleHcl behind isCoveredByCatalog, so an    */
/*  unknown id makes the selection not-covered and the request is      */
/*  delegated to the InfraAgent (design R4.5). The route's             */
/*  unknown_preset→422 branch is unreachable dead code. This test      */
/*  asserts the ACTUAL, design-consistent behaviour.                   */
/* ================================================================== */

test(
  "C: a selection referencing a non-existent preset id is not covered and delegates to the InfraAgent (R4.5)",
  { skip: !WEB_API_AVAILABLE ? "requires Node >= 18 (Request global)" : false },
  async () => {
    resetSpies();
    const POST = loadPost();

    const request = makeRequest(
      {
        team: "digital",
        resourceType: "iam_role",
        targetEnvironments: ["dev"],
        fields: {
          roleName: "mixed-role",
          namespace: "mixed-ns",
          presetSelections: [{ presetId: "this-preset-does-not-exist" }],
        },
      },
      "unknown@iskaypet.com",
    );

    const response = await POST(request);
    assert.equal(response.status, 200);
    assert.equal(
      infraAgentConstructed,
      1,
      "an unknown preset id must fall through to the InfraAgent",
    );
    assert.equal(infraAgentRunCalls.length, 1);
  },
);

/* ================================================================== */
/*  Test D — missing required fields on a covered selection → 422      */
/*  (R7.3)                                                             */
/* ================================================================== */

test(
  "D: a covered selection with an empty roleName is rejected with 422 missing_required_fields and never reaches the InfraAgent (R7.3)",
  { skip: !WEB_API_AVAILABLE ? "requires Node >= 18 (Request global)" : false },
  async () => {
    resetSpies();
    const POST = loadPost();

    const request = makeRequest(
      {
        team: "digital",
        resourceType: "iam_role",
        targetEnvironments: ["dev"],
        fields: {
          roleName: "", // empty → passes field-validators (skips) but fails validateRequiredRoleFields
          namespace: "my-namespace",
          presetSelections: [{ presetId: "s3-read-only" }],
        },
      },
      "missing@iskaypet.com",
    );

    const response = await POST(request);
    assert.equal(response.status, 422, "missing required fields must return 422");

    const body = (await response.json()) as { error: string; code: string };
    assert.equal(body.code, "missing_required_fields");
    assert.equal(infraAgentConstructed, 0, "InfraAgent must not be constructed");
  },
);

/* ================================================================== */
/*  Test E — covered selection with an invalid ARN scope → 422         */
/*  invalid_scope (reachable generator-error path, R4.9 spirit)        */
/* ================================================================== */

test(
  "E: a covered selection with a malformed ARN scope is rejected with 422 invalid_scope, no InfraAgent (R4.9)",
  { skip: !WEB_API_AVAILABLE ? "requires Node >= 18 (Request global)" : false },
  async () => {
    resetSpies();
    const POST = loadPost();

    const request = makeRequest(
      {
        team: "digital",
        resourceType: "iam_role",
        targetEnvironments: ["dev"],
        fields: {
          roleName: "scoped-role",
          namespace: "scoped-ns",
          presetSelections: [
            { presetId: "s3-read-only", resourceArns: ["not-a-valid-arn"] },
          ],
        },
      },
      "badscope@iskaypet.com",
    );

    const response = await POST(request);
    assert.equal(response.status, 422, "malformed ARN scope must return 422");

    const body = (await response.json()) as { error: string; code: string };
    assert.equal(body.code, "invalid_scope");
    assert.equal(infraAgentConstructed, 0, "InfraAgent must not be constructed");
  },
);
