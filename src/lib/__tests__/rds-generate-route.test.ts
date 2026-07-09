/**
 * Integration tests for the `generate` endpoint's RDS branch
 * (spec: portal-rds-creation-improvement, task 9.2).
 *
 * These are example-based integration tests (node:test) that exercise the
 * core of the route's RDS branch — `RdsGenerator.generate` — end-to-end with
 * an INSTRUMENTED mock GitLab client that records every repository read. The
 * route handler itself pulls in `requireUserAuth`, `repoCatalog` (DB) and a
 * rate limiter, none of which are relevant to the three integration concerns
 * being verified here, so we drive the generator directly to keep the tests
 * deterministic and DB-free.
 *
 * Concerns covered:
 *   1. `generate` reads `iac/databases/` BEFORE rendering a preview (R3.4).
 *   2. An invalid engine/version returns an error WITHOUT touching the repo
 *      (R1.5, R2.5) — the call recorder stays empty.
 *   3. The produced preview includes `auxiliaryFiles` (variables.tf + the three
 *      tfvars) and `metadata.engine`.
 *
 * _Requirements: 1.5, 2.5, 3.4_
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { gitlabClient, GitLabTreeItem } from "../gitlab";
import { RdsGenerator, type RdsGenerateInput } from "../rds/rds-generator";
import { tfId } from "../rds/render-rds";
import { defaultVersionForEngine } from "../rds/version-catalog";
import type { RdsFields } from "../infra-prompt-builder";

/* ------------------------------------------------------------------ */
/*  Instrumented (call-recording) mock GitLab client                   */
/* ------------------------------------------------------------------ */

/**
 * A readable `iac/databases/` directory containing a valid
 * `terraform-aws-modules/rds/aws` module plus the conventional variables.tf
 * and three tfvars. Crucially, `variables.tf` only declares variables for the
 * EXISTING database, so a freshly generated db's five variables are all new
 * and must be appended (exercises the variables.tf `append` op).
 */
const REPO_FILES: Record<string, string> = {
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

interface RecordedCall {
  method: "listRepoTree" | "getRepositoryFileRaw";
  path: string;
}

interface RecordingMock {
  client: typeof gitlabClient;
  calls: RecordedCall[];
}

function buildTree(): GitLabTreeItem[] {
  return Object.keys(REPO_FILES).map((path, i) => ({
    id: String(i),
    name: path.split("/").pop()!,
    type: "blob",
    path,
    mode: "100644",
  }));
}

/**
 * Builds a mock that records every repository read. When `throwOnRead` is true
 * the read methods throw if ever invoked — used to prove that invalid-input
 * paths never reach the repository.
 */
function createRecordingMock(throwOnRead = false): RecordingMock {
  const calls: RecordedCall[] = [];

  const mock = {
    async listRepoTree(
      _projectId: number,
      path: string,
      _ref: string,
      _recursive?: boolean,
    ): Promise<GitLabTreeItem[]> {
      calls.push({ method: "listRepoTree", path });
      if (throwOnRead) {
        throw new Error("repo must not be read for invalid input");
      }
      return buildTree();
    },
    async getRepositoryFileRaw(
      _projectId: number,
      filePath: string,
      _ref: string,
    ): Promise<string | null> {
      calls.push({ method: "getRepositoryFileRaw", path: filePath });
      if (throwOnRead) {
        throw new Error("repo must not be read for invalid input");
      }
      return REPO_FILES[filePath] ?? null;
    },
  };

  return { client: mock as unknown as typeof gitlabClient, calls };
}

/* ------------------------------------------------------------------ */
/*  Input builder                                                      */
/* ------------------------------------------------------------------ */

function buildInput(
  overrides: Partial<{
    engine: string;
    engineVersion: string;
    identifier: string;
    targetEnvironments: string[];
  }> = {},
): RdsGenerateInput {
  const engine = overrides.engine ?? "postgres";
  const engineVersion =
    overrides.engineVersion ??
    (engine === "postgres" ? defaultVersionForEngine("postgres") : "18");
  const identifier = overrides.identifier ?? "marketplace-payments-api-db";

  const fields: RdsFields = {
    identifier,
    dbName: tfId(identifier),
    instanceClass: "db.t4g.micro",
    storageGb: 20,
    multiAz: false,
    engine: engine as RdsFields["engine"],
    engineVersion,
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
/*  1. Reads iac/databases/ before rendering (R3.4)                    */
/* ------------------------------------------------------------------ */

test("generate reads iac/databases/ (lists the dir and reads a .tf) before producing a preview", async () => {
  const { client, calls } = createRecordingMock();
  const generator = new RdsGenerator(client);

  const result = await generator.generate(buildInput());

  // A preview is produced on the valid path.
  assert.equal(result.ok, true);

  // The convention read happened: the directory was listed...
  const listCall = calls.find((c) => c.method === "listRepoTree");
  assert.ok(listCall, "expected listRepoTree to have been called");
  assert.equal(listCall.path, "iac/databases");

  // ...and at least one `.tf` file was read from it.
  const tfReadCall = calls.find(
    (c) => c.method === "getRepositoryFileRaw" && c.path.endsWith(".tf"),
  );
  assert.ok(
    tfReadCall,
    "expected at least one .tf file under iac/databases/ to be read",
  );

  // The directory listing happens before any file read (introspection order).
  const listIndex = calls.findIndex((c) => c.method === "listRepoTree");
  const firstReadIndex = calls.findIndex(
    (c) => c.method === "getRepositoryFileRaw",
  );
  assert.ok(
    listIndex < firstReadIndex,
    "listRepoTree must be called before getRepositoryFileRaw",
  );
});

/* ------------------------------------------------------------------ */
/*  2. Invalid engine returns error without touching the repo (R1.5)   */
/* ------------------------------------------------------------------ */

test("an invalid engine returns invalid_engine and never reads the repo", async () => {
  // The mock throws if any read happens, so reaching the repo would fail loudly.
  const { client, calls } = createRecordingMock(true);
  const generator = new RdsGenerator(client);

  const result = await generator.generate(buildInput({ engine: "oracle" }));

  assert.equal(result.ok, false);
  if (result.ok) return; // narrow for TS
  assert.equal(result.code, "invalid_engine");
  assert.ok(result.message.includes("oracle"));

  // The repository was left completely untouched.
  assert.equal(calls.length, 0, "no repository read should have occurred");
});

test("mysql is rejected as invalid_engine (decision: PostgreSQL-only) and never reads the repo", async () => {
  // Organizational decision: new RDS instances may not use MySQL. The engine is
  // no longer in the catalog, so the generator rejects it before any repo read.
  const { client, calls } = createRecordingMock(true);
  const generator = new RdsGenerator(client);

  const result = await generator.generate(buildInput({ engine: "mysql", engineVersion: "8.4" }));

  assert.equal(result.ok, false);
  if (result.ok) return; // narrow for TS
  assert.equal(result.code, "invalid_engine");
  assert.ok(result.message.includes("mysql"), "message should name the rejected engine");
  assert.equal(calls.length, 0, "no repository read should have occurred");
});

test("an invalid version returns invalid_version and never reads the repo", async () => {
  const { client, calls } = createRecordingMock(true);
  const generator = new RdsGenerator(client);

  // "13" is a real PostgreSQL version we deliberately do not offer.
  const result = await generator.generate(
    buildInput({ engine: "postgres", engineVersion: "13" }),
  );

  assert.equal(result.ok, false);
  if (result.ok) return; // narrow for TS
  assert.equal(result.code, "invalid_version");
  assert.ok(result.message.includes("13"));
  assert.ok(result.message.includes("postgres"));

  // Engine/version validation runs before the repo read, so the repo is intact.
  assert.equal(calls.length, 0, "no repository read should have occurred");
});

/* ------------------------------------------------------------------ */
/*  4. Preview includes auxiliaryFiles (variables.tf + 3 tfvars) and    */
/*     metadata.engine                                                  */
/* ------------------------------------------------------------------ */

test("the preview includes auxiliaryFiles (variables.tf append + 3 tfvars upsert) and metadata.engine", async () => {
  const { client } = createRecordingMock();
  const generator = new RdsGenerator(client);

  const result = await generator.generate(
    buildInput({ engine: "postgres", engineVersion: "18", identifier: "orders-db" }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return; // narrow for TS

  const { preview } = result;
  const aux = preview.auxiliaryFiles;
  assert.ok(aux && aux.length > 0, "expected auxiliaryFiles to be present");

  // variables.tf append op (the new db's five variables are not yet declared).
  const variablesOp = aux.find(
    (op) => op.filePath === "iac/databases/variables.tf",
  );
  assert.ok(variablesOp, "expected an op for iac/databases/variables.tf");
  assert.equal(variablesOp.op, "append");

  // Three tfvars upsert-entries ops, one per environment file.
  const tfvarsFiles = [
    "iac/databases/vars/dev.tfvars",
    "iac/databases/vars/uat.tfvars",
    "iac/databases/vars/pro.tfvars",
  ];
  for (const file of tfvarsFiles) {
    const op = aux.find((o) => o.filePath === file);
    assert.ok(op, `expected an op for ${file}`);
    assert.equal(op.op, "upsert-entries");
    // Each tfvars op carries the five parameterized variables.
    assert.ok(op.entries && op.entries.length === 5, `expected 5 entries for ${file}`);
  }

  // Exactly the three tfvars upsert ops (no extras).
  const upsertOps = aux.filter((o) => o.op === "upsert-entries");
  assert.equal(upsertOps.length, 3, "expected exactly three tfvars upsert ops");

  // metadata.engine mirrors the requested engine.
  assert.equal(preview.metadata?.engine, "postgres");
});
