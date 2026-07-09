/**
 * Integration tests for the `execute` endpoint's RDS branch
 * (spec: portal-rds-creation-improvement, task 9.4).
 *
 * These are example-based integration tests (node:test). The real route handler
 * (`src/app/api/infra-assistant/execute/[id]/route.ts`) is tightly coupled to
 * `pool` (postgres), `requireInternalAuth`, `repoCatalog`, `jiraCreateIssue`,
 * `createNotification`, etc., so importing it directly is impractical for a
 * deterministic, DB-free unit test. Instead we verify the two integration
 * concerns at the level of the building blocks the route is built from, using
 * an in-memory mock GitLab client that records every write:
 *
 *   A. "422 sin crear rama/MR cuando falta la rotación" (R5.3):
 *      `validateRdsPasswordRotation` is invoked BEFORE `createBranch` in the
 *      route. We drive the same gate here: a `.tf` lacking (or with an incorrect)
 *      Bloque_Rotacion makes the validator invalid → the gate returns 422 and the
 *      mock GitLab client records ZERO branch / file / MR writes. A valid `.tf`
 *      (produced by the real generator) passes the gate and reaches branch
 *      creation.
 *
 *   B. "auxiliaryFiles aplicadas a los 3 tfvars + variables.tf" (R3.2, R3.3):
 *      We drive `RdsGenerator.generate` to PRODUCE a real preview, then feed its
 *      `auxiliaryFiles` through an in-test applier that mirrors the route's
 *      create / append / upsert-entries semantics (the route's `applyAuxiliaryFileOp`
 *      uses exactly `upsertTfvarsEntries` + optimistic-locked create/update). We
 *      assert that after applying: variables.tf received the five `var "<db>_..."`
 *      declarations, and each of dev/uat/pro tfvars received the five `<db>_...`
 *      entries with correct typing (bool unquoted, string quoted) — all on the
 *      feature branch.
 *
 * _Requirements: 5.3, 3.2, 3.3_
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { gitlabClient, GitLabTreeItem } from "../gitlab";
import type { AuxiliaryFileOp } from "../infra-agent";
import { RdsGenerator, type RdsGenerateInput } from "../rds/rds-generator";
import { tfId, upsertTfvarsEntries } from "../rds/render-rds";
import { defaultVersionForEngine } from "../rds/version-catalog";
import { validateRdsPasswordRotation } from "../terraform-validator";
import type { RdsFields } from "../infra-prompt-builder";

/* ------------------------------------------------------------------ */
/*  In-memory, write-recording mock GitLab client                      */
/* ------------------------------------------------------------------ */

interface FileWrite {
  method: "createFile" | "updateFile";
  path: string;
  branch: string;
  content: string;
}

interface InMemoryGitLab {
  client: typeof gitlabClient;
  /** Current file contents keyed by repo path (mutated by writes). */
  files: Record<string, string>;
  /** Every createFile/updateFile call, in order. */
  writes: FileWrite[];
  /** Branches created via createBranch. */
  branches: string[];
  /** MRs created via createMR. */
  mrs: Array<{ source: string; target: string }>;
}

/**
 * Builds an in-memory mock that seeds `initialFiles`, serves reads (tree + raw +
 * with-meta), and records every write/branch/MR. The same instance backs both
 * `RdsGenerator.generate` (reads) and the auxiliary-file apply step (read+write),
 * mirroring how the route operates against a single repository.
 */
function createInMemoryGitLab(initialFiles: Record<string, string>): InMemoryGitLab {
  const files: Record<string, string> = { ...initialFiles };
  const writes: FileWrite[] = [];
  const branches: string[] = [];
  const mrs: Array<{ source: string; target: string }> = [];

  const treeFor = (prefix: string): GitLabTreeItem[] =>
    Object.keys(files)
      .filter((p) => p.startsWith(prefix))
      .map((path, i) => ({
        id: String(i),
        name: path.split("/").pop()!,
        type: "blob",
        path,
        mode: "100644",
      }));

  const mock = {
    async listRepoTree(
      _projectId: number,
      path: string,
      _ref: string,
      _recursive?: boolean,
    ): Promise<GitLabTreeItem[]> {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      return treeFor(prefix);
    },
    async getRepositoryFileRaw(
      _projectId: number,
      filePath: string,
      _ref: string,
    ): Promise<string | null> {
      return files[filePath] ?? null;
    },
    async getRepositoryFileWithMeta(
      _projectId: number,
      filePath: string,
      _ref: string,
    ): Promise<{ content: string; lastCommitId: string } | null> {
      if (!(filePath in files)) return null;
      return { content: files[filePath], lastCommitId: `commit-${filePath}` };
    },
    async createFile(
      _projectId: number,
      filePath: string,
      branch: string,
      content: string,
      _commitMessage: string,
    ): Promise<{ file_path: string; branch: string }> {
      files[filePath] = content;
      writes.push({ method: "createFile", path: filePath, branch, content });
      return { file_path: filePath, branch };
    },
    async updateFile(
      _projectId: number,
      filePath: string,
      branch: string,
      content: string,
      _commitMessage: string,
      _lastCommitId?: string,
    ): Promise<{ file_path: string; branch: string }> {
      files[filePath] = content;
      writes.push({ method: "updateFile", path: filePath, branch, content });
      return { file_path: filePath, branch };
    },
    async createBranch(
      _projectId: number,
      branchName: string,
      _ref: string,
    ): Promise<{ name: string; web_url: string }> {
      branches.push(branchName);
      return { name: branchName, web_url: `https://gitlab/branch/${branchName}` };
    },
    async createMR(
      _projectId: number,
      sourceBranch: string,
      targetBranch: string,
      _title: string,
      _description: string,
    ): Promise<{ iid: number; web_url: string }> {
      mrs.push({ source: sourceBranch, target: targetBranch });
      return { iid: mrs.length, web_url: `https://gitlab/mr/${mrs.length}` };
    },
  };

  return { client: mock as unknown as typeof gitlabClient, files, writes, branches, mrs };
}

/* ------------------------------------------------------------------ */
/*  Repo fixture: a readable iac/databases/ with the conventional       */
/*  module + variables.tf (existing db only) + three tfvars.            */
/* ------------------------------------------------------------------ */

function buildRepoFiles(): Record<string, string> {
  return {
    "iac/databases/existing-db.tf": [
      'resource "aws_security_group" "existing_db" {',
      '  count       = contains(["dev", "uat", "prod"], var.environment) ? 1 : 0',
      '  description = "existing-db RDS Access"',
      "  vpc_id      = var.vpc_id",
      "  ingress {",
      '    protocol    = "tcp"',
      "    from_port   = 5432",
      "    to_port     = 5432",
      "    cidr_blocks = var.private_subnet_cidrs",
      "  }",
      "}",
      "",
      'module "existing_db" {',
      '  source  = "terraform-aws-modules/rds/aws"',
      '  version = "6.10.0"',
      "",
      '  identifier = "existing-db"',
      '  engine         = "postgres"',
      "  engine_version = var.existing_db_rds_version",
      "",
      "  vpc_security_group_ids = [aws_security_group.existing_db[0].id]",
      "  subnet_ids             = var.private_subnets",
      "}",
      "",
    ].join("\n"),
    "iac/databases/variables.tf": [
      'variable "existing_db_rds_version" { type = string }',
      "",
    ].join("\n"),
    "iac/databases/vars/dev.tfvars": 'existing_db_rds_version = "16"\n',
    "iac/databases/vars/uat.tfvars": 'existing_db_rds_version = "16"\n',
    "iac/databases/vars/pro.tfvars": 'existing_db_rds_version = "16"\n',
  };
}

function buildInput(
  overrides: Partial<{
    identifier: string;
    engine: "postgres";
    engineVersion: string;
    targetEnvironments: string[];
  }> = {},
): RdsGenerateInput {
  const engine = overrides.engine ?? "postgres";
  const identifier = overrides.identifier ?? "orders-db";
  const fields: RdsFields = {
    identifier,
    dbName: tfId(identifier),
    instanceClass: "db.t4g.micro",
    storageGb: 20,
    multiAz: false,
    engine,
    engineVersion: overrides.engineVersion ?? defaultVersionForEngine(engine),
  };
  return {
    fields,
    targetEnvironments: overrides.targetEnvironments ?? ["dev", "uat"],
    projectId: 12345,
    defaultBranch: "main",
    portalDefaultModuleVersion: "6.10.0",
  };
}

/* ------------------------------------------------------------------ */
/*  Test replicas of the route's two relevant steps                    */
/* ------------------------------------------------------------------ */

/**
 * Mirrors the route's RDS rotation gate ordering: `validateRdsPasswordRotation`
 * is checked BEFORE `createBranch`. When the rotation block is missing/incorrect
 * the route returns 422 and never touches the repo; otherwise it proceeds to
 * create the branch. Returns the HTTP-ish status the route would emit.
 */
async function runRotationGateThenBranch(
  gl: InMemoryGitLab,
  content: string,
  branchName: string,
): Promise<{ status: number; rotationErrors: string[] }> {
  const rotation = validateRdsPasswordRotation(content);
  if (!rotation.valid) {
    // Route: 422, repo left intact (no branch/commit/MR).
    return { status: 422, rotationErrors: rotation.errors.map((e) => e.message) };
  }
  // Valid → the route proceeds to create the branch (and later the MR).
  await gl.client.createBranch(12345, branchName, "main");
  return { status: 200, rotationErrors: [] };
}

/**
 * Mirrors the route's `applyAuxiliaryFileOp` (single attempt — concurrency
 * retries are out of scope here): read current content with meta, then
 *   - create:        write op.content (create-or-update)
 *   - append:        current + "\n\n" + op.content (or content if absent)
 *   - upsert-entries: non-destructive tfvars merge via upsertTfvarsEntries
 * creating the file when absent and updating it otherwise.
 */
async function applyAuxiliaryFileOp(
  gl: InMemoryGitLab,
  branch: string,
  op: AuxiliaryFileOp,
): Promise<void> {
  const meta = await gl.client.getRepositoryFileWithMeta(12345, op.filePath, branch);
  const exists = meta !== null;
  const currentContent = meta?.content ?? "";
  const lastCommitId = meta?.lastCommitId;

  let newContent: string;
  switch (op.op) {
    case "create":
      newContent = op.content ?? "";
      break;
    case "append":
      newContent =
        exists && currentContent.length > 0
          ? currentContent + "\n\n" + (op.content ?? "")
          : op.content ?? "";
      break;
    case "upsert-entries":
      newContent = upsertTfvarsEntries(currentContent, op.entries ?? []);
      break;
    default:
      throw new Error(`Unknown auxiliary file op: ${(op as AuxiliaryFileOp).op}`);
  }

  if (exists) {
    await gl.client.updateFile(12345, op.filePath, branch, newContent, "msg", lastCommitId);
  } else {
    await gl.client.createFile(12345, op.filePath, branch, newContent, "msg");
  }
}

/* ================================================================== */
/*  Concern A — 422 without branch/MR when rotation is missing (R5.3)  */
/* ================================================================== */

test("execute returns 422 and creates no branch/MR when the .tf lacks the rotation block (R5.3)", async () => {
  const gl = createInMemoryGitLab(buildRepoFiles());

  // A syntactically fine RDS module that OMITS the Bloque_Rotacion entirely.
  const rotationlessTf = [
    'module "orders_db" {',
    '  source  = "terraform-aws-modules/rds/aws"',
    '  version = "6.10.0"',
    "",
    '  identifier        = "orders-db"',
    '  engine            = "postgres"',
    "  engine_version    = var.orders_db_rds_version",
    "}",
    "",
  ].join("\n");

  // Validator must flag it invalid (drives the route's 422).
  const rotation = validateRdsPasswordRotation(rotationlessTf);
  assert.equal(rotation.valid, false);
  assert.ok(rotation.errors.length > 0);

  const result = await runRotationGateThenBranch(gl, rotationlessTf, "feat/SRE-99");

  assert.equal(result.status, 422);
  // The repository is left completely intact: no branch, no file writes, no MR.
  assert.equal(gl.branches.length, 0, "no branch should have been created");
  assert.equal(gl.writes.length, 0, "no file should have been written");
  assert.equal(gl.mrs.length, 0, "no MR should have been created");
});

test("execute returns 422 when a rotation attribute has an incorrect value (rotate_immediately = true)", async () => {
  const gl = createInMemoryGitLab(buildRepoFiles());

  // All four attributes present, but rotate_immediately is wrong (true vs false).
  const wrongValueTf = [
    'module "orders_db" {',
    '  source  = "terraform-aws-modules/rds/aws"',
    '  version = "6.10.0"',
    '  identifier = "orders-db"',
    "  manage_master_user_password                       = true",
    "  manage_master_user_password_rotation              = true",
    "  master_user_password_rotate_immediately           = true",
    '  master_user_password_rotation_schedule_expression = "rate(15 days)"',
    "}",
    "",
  ].join("\n");

  const result = await runRotationGateThenBranch(gl, wrongValueTf, "feat/SRE-100");

  assert.equal(result.status, 422);
  assert.ok(
    result.rotationErrors.some((m) =>
      m.includes("master_user_password_rotate_immediately"),
    ),
    "the diagnostic should name the offending attribute",
  );
  assert.equal(gl.branches.length, 0);
  assert.equal(gl.writes.length, 0);
  assert.equal(gl.mrs.length, 0);
});

test("a generator-produced .tf passes the rotation gate and reaches branch creation", async () => {
  const gl = createInMemoryGitLab(buildRepoFiles());
  const generator = new RdsGenerator(gl.client);

  const gen = await generator.generate(buildInput({ identifier: "orders-db" }));
  assert.equal(gen.ok, true);
  if (!gen.ok) return; // narrow

  const result = await runRotationGateThenBranch(gl, gen.preview.content, "feat/SRE-101");

  assert.equal(result.status, 200);
  assert.deepEqual(gl.branches, ["feat/SRE-101"]);
});

/* ================================================================== */
/*  Concern B — auxiliaryFiles applied to variables.tf + 3 tfvars       */
/*  (R3.2, R3.3)                                                        */
/* ================================================================== */

test("auxiliaryFiles are applied to variables.tf + the three tfvars with correct content (R3.2, R3.3)", async () => {
  const gl = createInMemoryGitLab(buildRepoFiles());
  const generator = new RdsGenerator(gl.client);

  const identifier = "orders-db";
  const db = tfId(identifier); // orders_db
  const gen = await generator.generate(
    buildInput({ identifier, engine: "postgres", engineVersion: "18" }),
  );
  assert.equal(gen.ok, true);
  if (!gen.ok) return; // narrow

  const aux = gen.preview.auxiliaryFiles;
  assert.ok(aux && aux.length === 4, "expected 4 auxiliary ops (variables.tf + 3 tfvars)");

  const branch = "feat/SRE-42";
  await gl.client.createBranch(12345, branch, "main");

  // Apply every auxiliary op exactly as the route does.
  for (const op of aux!) {
    await applyAuxiliaryFileOp(gl, branch, op);
  }

  const fiveVars = [
    `${db}_rds_version`,
    `${db}_family`,
    `${db}_major_engine_version`,
    `${db}_allow_major_version_upgrade`,
    `${db}_apply_immediately`,
  ];

  /* ---- variables.tf: the five new declarations were appended ---- */
  const variablesTf = gl.files["iac/databases/variables.tf"];
  for (const name of fiveVars) {
    assert.ok(
      new RegExp(`variable\\s+"${name}"`).test(variablesTf),
      `variables.tf should declare ${name}`,
    );
  }
  // The pre-existing declaration is preserved (append, not overwrite).
  assert.ok(
    variablesTf.includes('variable "existing_db_rds_version"'),
    "variables.tf must preserve the existing declaration",
  );
  // The variables.tf write happened on the feature branch.
  const varsWrite = gl.writes.find((w) => w.path === "iac/databases/variables.tf");
  assert.ok(varsWrite, "variables.tf should have been written");
  assert.equal(varsWrite!.branch, branch);

  /* ---- each tfvars: five typed entries with correct values ---- */
  const tfvarsFiles = [
    "iac/databases/vars/dev.tfvars",
    "iac/databases/vars/uat.tfvars",
    "iac/databases/vars/pro.tfvars",
  ];
  for (const file of tfvarsFiles) {
    const body = gl.files[file];

    // string-typed entries are quoted ("18", "postgres18")
    assert.ok(
      new RegExp(`${db}_rds_version\\s*=\\s*"18"`).test(body),
      `${file}: ${db}_rds_version should be "18"`,
    );
    assert.ok(
      new RegExp(`${db}_family\\s*=\\s*"postgres18"`).test(body),
      `${file}: ${db}_family should be "postgres18"`,
    );
    assert.ok(
      new RegExp(`${db}_major_engine_version\\s*=\\s*"18"`).test(body),
      `${file}: ${db}_major_engine_version should be "18"`,
    );

    // bool-typed entries are unquoted (false)
    assert.ok(
      new RegExp(`${db}_allow_major_version_upgrade\\s*=\\s*false(?!")`).test(body),
      `${file}: ${db}_allow_major_version_upgrade should be unquoted false`,
    );
    assert.ok(
      new RegExp(`${db}_apply_immediately\\s*=\\s*false(?!")`).test(body),
      `${file}: ${db}_apply_immediately should be unquoted false`,
    );

    // Pre-existing entry preserved (non-destructive upsert).
    assert.ok(
      body.includes('existing_db_rds_version = "16"'),
      `${file}: existing entry must be preserved`,
    );

    // The write targeted the feature branch.
    const w = gl.writes.find((x) => x.path === file);
    assert.ok(w, `${file} should have been written`);
    assert.equal(w!.branch, branch);
  }

  // Exactly the four expected files were written (variables.tf + 3 tfvars),
  // each once, all on the feature branch.
  const writtenPaths = gl.writes.map((w) => w.path).sort();
  assert.deepEqual(writtenPaths, [
    "iac/databases/variables.tf",
    "iac/databases/vars/dev.tfvars",
    "iac/databases/vars/pro.tfvars",
    "iac/databases/vars/uat.tfvars",
  ]);
});

test("the prod environment maps to pro.tfvars (R6.4) — pro.tfvars receives the entries", async () => {
  const gl = createInMemoryGitLab(buildRepoFiles());
  const generator = new RdsGenerator(gl.client);

  const identifier = "billing-db";
  const db = tfId(identifier);
  const gen = await generator.generate(
    buildInput({ identifier, engine: "postgres", engineVersion: "18", targetEnvironments: ["prod"] }),
  );
  assert.equal(gen.ok, true);
  if (!gen.ok) return; // narrow

  const branch = "feat/SRE-7";
  await gl.client.createBranch(12345, branch, "main");
  for (const op of gen.preview.auxiliaryFiles!) {
    await applyAuxiliaryFileOp(gl, branch, op);
  }

  // pro.tfvars (NOT prod.tfvars) must carry the postgres family value.
  const pro = gl.files["iac/databases/vars/pro.tfvars"];
  assert.ok(
    new RegExp(`${db}_family\\s*=\\s*"postgres18"`).test(pro),
    "pro.tfvars should contain the postgres18 family entry",
  );
  assert.equal(gl.files["iac/databases/vars/prod.tfvars"], undefined);
});
