/**
 * Integration tests for the Execute_API IAM anti-admin chain
 * (feature: iam-role-least-privilege, task 9.2 — Req 5.7, 5.8, 5.9, 7.5, 7.7).
 *
 * These are example-based integration tests (node:test, run via `tsx --test`).
 * They drive the REAL `POST` handler of
 * `src/app/api/infra-assistant/execute/[id]/route.ts` end to end, exercising the
 * real validators (`validateHclSyntax`, `scanForSecrets`, `validateIamPolicyAdmin`,
 * `validateManagedPolicyArn`) and the real generator (`generateIamRoleHcl`).
 *
 * Why we patch singletons instead of `mock.module`: on this repo's Node runtime
 * `mock.module` is unavailable (see `src/lib/__tests__/cur-direct-route.test.ts`
 * and `src/app/api/kiro-analytics/__tests__/guard.role-gate.test.ts`). So we mock
 * ONLY the external boundaries by mutating the shared singleton objects that the
 * route imports:
 *   - `pool` (default export of `@/lib/db`) — `pool.query` is swapped for an
 *     in-memory fake that serves the `infra_requests` row, simulates the atomic
 *     claim `rowCount`, and records every write (also serves the
 *     `user_notifications` INSERT that `createNotification` performs).
 *   - `gitlabClient` (`@/lib/gitlab`) — `createBranch` / `getRepositoryFileWithMeta`
 *     / `updateFile` / `createFile` / `createMR` are swapped for recording spies.
 *   - `repoCatalog.getByTeam` (`@/lib/repo-catalog`) — returns a canned repo.
 *   - `global.fetch` — serves the Jira REST calls (`jiraCreateIssue`) and records
 *     them so we can assert Jira was / was not invoked.
 *
 * The route module is imported dynamically AFTER the singletons exist so the
 * module cache guarantees the route and this test share the same instances.
 *
 * The feature flag `ENABLE_INFRA_HARDENING_V1` is left OFF (its default): this
 * keeps the byte-exact baseline (no precheck, idempotent 200 on a lost claim
 * race) and lets us assert the double-execution guard (Req 7.5) via the baseline
 * response while still proving no second execution happens.
 *
 * `next/server` (pulled transitively by the route) needs the Web `Request`/
 * `Response`/`Headers` globals (Node 18+). CI runs on `node:20-bookworm-slim`;
 * on Node 16 we skip the whole suite rather than exploding at import time.
 *
 * _Requirements: 5.7, 5.8, 5.9, 7.5, 7.7_
 */

const WEB_API_AVAILABLE =
  typeof (globalThis as { Request?: unknown }).Request !== "undefined";

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const skipOpts = {
  skip: WEB_API_AVAILABLE ? false : "requires Web API globals (Node 18+)",
};

/* ------------------------------------------------------------------ */
/*  Lazy singleton + route handles (populated on Node 18+ only)         */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

interface PgResult {
  rows: any[];
  rowCount: number;
}

let pool: { query: AnyFn };
let gitlabClient: Record<string, AnyFn>;
let repoCatalog: { getByTeam: AnyFn };
let generateIamRoleHcl: AnyFn;
let POST: (
  request: Request,
  ctx: { params: { id: string } }
) => Promise<Response>;

// Saved originals for restoration.
const originals: {
  poolQuery?: AnyFn;
  gitlab?: Record<string, AnyFn>;
  getByTeam?: AnyFn;
  fetch?: typeof globalThis.fetch;
} = {};

/* ------------------------------------------------------------------ */
/*  Recorders                                                          */
/* ------------------------------------------------------------------ */

interface Recorder {
  queries: { sql: string; params: any[] }[];
  gitlabCalls: string[];
  fetchCalls: { url: string; method: string }[];
  /** rowCount the simulated atomic claim UPDATE should return. */
  claimRowCount: number;
}

let rec: Recorder;

/** Faithful in-memory `pool.query` that serves the route's SQL by shape. */
function fakePoolQuery(sql: string, params: any[] = []): Promise<PgResult> {
  rec.queries.push({ sql, params });
  const s = sql.replace(/\s+/g, " ").trim();

  // Initial row load.
  if (/^SELECT id, status, executed_at/i.test(s)) {
    return Promise.resolve({ rows: [currentRow], rowCount: 1 });
  }
  // Atomic claim approved → executing.
  if (/UPDATE infra_requests SET status = 'executing' WHERE id = \$1 AND status = 'approved'/i.test(s)) {
    return Promise.resolve({ rows: [], rowCount: rec.claimRowCount });
  }
  // Success terminal transition.
  if (/UPDATE infra_requests SET gitlab_mr_url/i.test(s)) {
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  // Failure transition (baseline, flag off).
  if (/UPDATE infra_requests SET status = 'execute_failed'/i.test(s)) {
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  // createNotification INSERT ... RETURNING id.
  if (/INSERT INTO user_notifications/i.test(s)) {
    return Promise.resolve({ rows: [{ id: 1 }], rowCount: 1 });
  }
  // Any other query: benign empty result.
  return Promise.resolve({ rows: [], rowCount: 0 });
}

/** The infra_requests row served by the current test. */
let currentRow: any;

/* ------------------------------------------------------------------ */
/*  Setup / teardown                                                  */
/* ------------------------------------------------------------------ */

beforeEach(async () => {
  if (!WEB_API_AVAILABLE) return;

  // Ensure the hardening flag stays OFF for byte-exact baseline behaviour.
  delete process.env.ENABLE_INFRA_HARDENING_V1;
  // Keep Teams webhook unset so Step 7 is skipped (no extra fetch).
  delete process.env.TEAMS_WEBHOOK_URL;

  const db = await import("@/lib/db");
  pool = (db as unknown as { default: { query: AnyFn } }).default;
  const gl = await import("@/lib/gitlab");
  gitlabClient = gl.gitlabClient as unknown as Record<string, AnyFn>;
  const rc = await import("@/lib/repo-catalog");
  repoCatalog = rc.repoCatalog as unknown as { getByTeam: AnyFn };
  const gen = await import("@/lib/iam-catalog/generator");
  generateIamRoleHcl = gen.generateIamRoleHcl;
  const route = await import("@/app/api/infra-assistant/execute/[id]/route");
  POST = route.POST as typeof POST;

  rec = { queries: [], gitlabCalls: [], fetchCalls: [], claimRowCount: 1 };

  // ── Patch pool.query ──
  originals.poolQuery = pool.query.bind(pool);
  pool.query = fakePoolQuery as AnyFn;

  // ── Patch gitlabClient methods ──
  originals.gitlab = {};
  for (const m of [
    "createBranch",
    "createFile",
    "updateFile",
    "getRepositoryFileWithMeta",
    "createMR",
  ]) {
    originals.gitlab[m] = gitlabClient[m];
  }
  gitlabClient.createBranch = (async (_pid: number, branch: string) => {
    rec.gitlabCalls.push("createBranch");
    return { name: branch, web_url: `https://gitlab.com/branch/${branch}` };
  }) as AnyFn;
  gitlabClient.getRepositoryFileWithMeta = (async () => {
    rec.gitlabCalls.push("getRepositoryFileWithMeta");
    return { content: "# existing roles.tf\n", lastCommitId: "commit-abc" };
  }) as AnyFn;
  gitlabClient.updateFile = (async () => {
    rec.gitlabCalls.push("updateFile");
    return { file_path: "iac/services/roles.tf", branch: "feat/SRE-1" };
  }) as AnyFn;
  gitlabClient.createFile = (async () => {
    rec.gitlabCalls.push("createFile");
    return { file_path: "iac/x.tf", branch: "feat/SRE-1" };
  }) as AnyFn;
  gitlabClient.createMR = (async () => {
    rec.gitlabCalls.push("createMR");
    return { iid: 1, web_url: "https://gitlab.com/mr/1" };
  }) as AnyFn;

  // ── Patch repoCatalog.getByTeam ──
  originals.getByTeam = repoCatalog.getByTeam;
  repoCatalog.getByTeam = (async () => ({
    id: 1,
    team: "digital",
    gitlabProjectId: 45379727,
    defaultBranch: "main",
    infraRootPath: "iac",
    description: null,
    active: true,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  })) as AnyFn;

  // ── Patch global.fetch (Jira boundary; also any stray call) ──
  originals.fetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const method = (init?.method || "GET").toUpperCase();
    rec.fetchCalls.push({ url, method });
    // Jira user search → empty array (reporter resolution falls back).
    if (url.includes("/rest/api/3/user/search")) {
      return jsonResponse(200, []);
    }
    // Jira issue creation → canned issue.
    if (url.includes("/rest/api/3/issue")) {
      return jsonResponse(201, { key: "SRE-100", id: "10000" });
    }
    // Anything else (should not happen in these tests) → benign 404.
    return jsonResponse(404, {});
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  if (!WEB_API_AVAILABLE) return;
  if (originals.poolQuery) pool.query = originals.poolQuery;
  if (originals.gitlab) {
    for (const [m, fn] of Object.entries(originals.gitlab)) gitlabClient[m] = fn;
  }
  if (originals.getByTeam) repoCatalog.getByTeam = originals.getByTeam;
  if (originals.fetch) globalThis.fetch = originals.fetch;
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeRequest(): Request {
  return new Request("https://portal.local/api/infra-assistant/execute/1", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}

/** Build an approved iam_role infra_requests row with the given preview. */
function makeRow(preview: Record<string, unknown>, payload: Record<string, unknown> = {}): any {
  return {
    id: 1,
    status: "approved",
    executed_at: null,
    requestor_email: "dev@iskaypet.com",
    team: "digital",
    resource_type: "iam_role",
    terraform_preview: preview,
    payload,
  };
}

/** A real, acceptable least-privilege IRSA HCL from the deterministic generator. */
function acceptableHcl(): string {
  const result = generateIamRoleHcl({
    roleName: "my-app-role",
    namespace: "my-namespace",
    selections: [
      {
        presetId: "s3-read-only",
        resourceArns: ["arn:aws:s3:::my-bucket", "arn:aws:s3:::my-bucket/*"],
      },
    ],
    targetEnvironments: ["dev", "uat"],
  });
  assert.equal(result.ok, true, "generator must produce acceptable HCL");
  return (result as { ok: true; hcl: string }).hcl;
}

/* ================================================================== */
/*  Test 1 — creation with an acceptable policy → branch / MR / Jira   */
/*  (Req 5.7 happy path, Req 7.5 claim succeeds)                       */
/* ================================================================== */

test(
  "iam_role creation with an acceptable least-privilege policy creates branch + MR + Jira and marks executed (Req 5.7)",
  skipOpts,
  async () => {
    currentRow = makeRow({
      content: acceptableHcl(),
      filePath: "iac/services/roles.tf",
      resourceType: "iam_role",
      resourceName: "my-app-role",
      targetEnvironments: ["dev", "uat"],
      isModification: false,
    });

    const res = await POST(makeRequest(), { params: { id: "1" } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean; gitlab_branch?: string; jira_key?: string };
    assert.equal(body.ok, true);
    assert.equal(body.gitlab_branch, "feat/SRE-1");

    // Branch + MR were created (the shared roles.tf goes through the append path).
    assert.ok(rec.gitlabCalls.includes("createBranch"), "createBranch must run");
    assert.ok(rec.gitlabCalls.includes("createMR"), "createMR must run");

    // Jira issue was created (POST to /rest/api/3/issue).
    assert.ok(
      rec.fetchCalls.some((c) => c.url.includes("/rest/api/3/issue") && c.method === "POST"),
      "jiraCreateIssue must be invoked"
    );

    // The request was marked executed.
    assert.ok(
      rec.queries.some((q) => /status = 'executed'/i.test(q.sql)),
      "row must transition to executed"
    );
    assert.ok(
      !rec.queries.some((q) => /status = 'execute_failed'/i.test(q.sql)),
      "must NOT transition to execute_failed"
    );
  }
);

/* ================================================================== */
/*  Test 2 — creation with a wildcard-admin policy → execute_failed    */
/*  with the concrete rule, NO branch / MR / Jira (Req 5.7, 5.9)       */
/* ================================================================== */

const WILDCARD_ADMIN_HCL = `resource "aws_iam_role" "admin_role" {
  name = "admin-role"
  assume_role_policy = templatefile("role_templates/iskaypet_dh_access.json.tmpl", {
    AWS_ACCOUNT_ID    = var.oms_account_id
    OIDC_PROVIDER_URL = var.dp_eks_oidc_provider_url
    NAMESPACE         = "ns"
  })
}

resource "aws_iam_policy" "admin_role" {
  name = "admin-role-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "adminall"
        Effect   = "Allow"
        Action   = ["*"]
        Resource = ["*"]
      }
    ]
  })
}
`;

test(
  "iam_role creation with a wildcard Allow on Resource \"*\" is rejected as execute_failed with the rule, no branch/MR/Jira (Req 5.7, 5.9)",
  skipOpts,
  async () => {
    currentRow = makeRow({
      content: WILDCARD_ADMIN_HCL,
      filePath: "iac/services/roles.tf",
      resourceType: "iam_role",
      resourceName: "admin-role",
      targetEnvironments: ["dev"],
      isModification: false,
    });

    const res = await POST(makeRequest(), { params: { id: "1" } });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error?: string; rule?: string };
    assert.equal(body.error, "IAM policy grants admin privileges");
    assert.equal(body.rule, "wildcard_action_on_all_resources");

    // Req 5.9: no branch, no MR, no Jira.
    assert.deepEqual(rec.gitlabCalls, [], "no GitLab writes on admin rejection");
    assert.ok(
      !rec.fetchCalls.some((c) => c.url.includes("/rest/api/3/issue")),
      "no Jira issue on admin rejection"
    );

    // The row was transitioned to execute_failed (Req 5.9).
    assert.ok(
      rec.queries.some((q) => /status = 'execute_failed'/i.test(q.sql)),
      "row must transition to execute_failed"
    );
  }
);

/* ================================================================== */
/*  Test 3 — modification adding a *FullAccess managed ARN →           */
/*  execute_failed, no branch/MR/Jira (Req 5.8, 5.9)                   */
/* ================================================================== */

test(
  "iam_role modification adding a managed admin ARN (*FullAccess) is rejected as execute_failed, no branch/MR/Jira (Req 5.8, 5.9)",
  skipOpts,
  async () => {
    currentRow = makeRow({
      content: acceptableHcl(), // valid HCL so the pre-chain passes to the IAM guard
      filePath: "iac/services/roles.tf",
      resourceType: "iam_role",
      resourceName: "my-app-role",
      targetEnvironments: ["dev", "uat"],
      isModification: true,
      modifications: {
        addPermissions: ["arn:aws:iam::aws:policy/AmazonS3FullAccess"],
      },
    });

    const res = await POST(makeRequest(), { params: { id: "1" } });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error?: string; rule?: string };
    assert.equal(body.error, "IAM policy grants admin privileges");
    assert.equal(body.rule, "managed_full_access");

    // Req 5.9: no repo/Jira side effects.
    assert.deepEqual(rec.gitlabCalls, [], "no GitLab writes on managed-admin rejection");
    assert.ok(
      !rec.fetchCalls.some((c) => c.url.includes("/rest/api/3/issue")),
      "no Jira issue on managed-admin rejection"
    );
    assert.ok(
      rec.queries.some((q) => /status = 'execute_failed'/i.test(q.sql)),
      "row must transition to execute_failed"
    );
  }
);

/* ================================================================== */
/*  Test 4 — atomic claim lost race → no second execution (Req 7.5)    */
/* ================================================================== */

test(
  "a lost atomic claim (approved→executing already taken) does NOT start a second execution: no branch/MR/Jira (Req 7.5)",
  skipOpts,
  async () => {
    currentRow = makeRow({
      content: acceptableHcl(),
      filePath: "iac/services/roles.tf",
      resourceType: "iam_role",
      resourceName: "my-app-role",
      targetEnvironments: ["dev", "uat"],
      isModification: false,
    });
    // Simulate another invocation having already claimed the row: the
    // conditional UPDATE matches 0 rows.
    rec.claimRowCount = 0;

    const res = await POST(makeRequest(), { params: { id: "1" } });

    // Baseline (flag OFF): idempotent 200, status still executing, no work done.
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean; status?: string };
    assert.equal(body.status, "executing");

    // The critical guarantee: NO second execution occurred.
    assert.deepEqual(rec.gitlabCalls, [], "a lost claim must not create any branch/MR");
    assert.ok(
      !rec.fetchCalls.some((c) => c.url.includes("/rest/api/3/issue")),
      "a lost claim must not create a Jira issue"
    );
    assert.ok(
      !rec.queries.some((q) => /status = 'executed'/i.test(q.sql)),
      "a lost claim must not mark the row executed"
    );
  }
);
