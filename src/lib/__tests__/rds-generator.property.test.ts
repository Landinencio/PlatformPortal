/**
 * Property-based tests for the deterministic RdsGenerator
 * (`src/lib/rds/rds-generator.ts`).
 *
 * Feature: portal-rds-creation-improvement
 *
 * This file holds the generator-level correctness properties (Properties 3, 4,
 * 5, 9, 16, 17 — tasks 6.2–6.7). The shared helpers below (a reusable mock
 * GitLab client, `invalidEngineArb`, the `buildInput` helper and the catalog
 * arbitraries) are defined once here so later tasks can reuse them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import type { gitlabClient } from "../gitlab";
import type { GitLabTreeItem } from "../gitlab";
import {
  RdsGenerator,
  findLiteralRdsAttribute,
  findTfvarsGap,
  checkRdsCoherence,
  ENV_TO_TFVARS,
  type RdsGenerateInput,
} from "../rds/rds-generator";
import {
  type RdsEngine,
  versionsForEngine,
  defaultVersionForEngine,
  familyForVersion,
} from "../rds/version-catalog";
import { tfId, type ParameterizedVar } from "../rds/render-rds";
import type { RdsFields } from "../infra-prompt-builder";

/* ------------------------------------------------------------------ */
/*  Shared mock GitLab client (reused by all generator properties)     */
/* ------------------------------------------------------------------ */

/**
 * A minimal but reusable in-memory fake of the methods `readRdsConvention`
 * touches (`listRepoTree`, `getRepositoryFileRaw`). It exposes a readable
 * `iac/databases/` directory containing a valid `terraform-aws-modules/rds/aws`
 * module plus the conventional variables.tf and three tfvars, so that
 * valid-path properties (5, 9, 16, 17) work, while invalid-input properties
 * (3, 4) — which are rejected before any repo read — also exercise it harmlessly.
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
    '  engine_version = var.existing_db_rds_version',
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

function buildTree(): GitLabTreeItem[] {
  return Object.keys(REPO_FILES).map((path, i) => ({
    id: String(i),
    name: path.split("/").pop()!,
    type: "blob",
    path,
    mode: "100644",
  }));
}

export function createMockGitlab(): typeof gitlabClient {
  const mock = {
    async listRepoTree(
      _projectId: number,
      _path: string,
      _ref: string,
      _recursive?: boolean,
    ): Promise<GitLabTreeItem[]> {
      return buildTree();
    },
    async getRepositoryFileRaw(
      _projectId: number,
      filePath: string,
      _ref: string,
    ): Promise<string | null> {
      return REPO_FILES[filePath] ?? null;
    },
  };
  return mock as unknown as typeof gitlabClient;
}

/* ------------------------------------------------------------------ */
/*  Shared arbitraries / input builder                                 */
/* ------------------------------------------------------------------ */

/** Any string that is NOT one of the two supported Motores. */
export const invalidEngineArb: fc.Arbitrary<string> = fc
  .string()
  .filter((s) => s !== "postgres" && s !== "mysql");

/** Engine generator: PostgreSQL is the only supported Motor (MySQL removed). */
export const engineArb: fc.Arbitrary<RdsEngine> = fc.constantFrom("postgres");

/** A valid RDS identifier (exercises `tfId` and the `<db>_` prefix). */
export const identifierArb: fc.Arbitrary<string> = fc.stringMatching(
  /^[a-z][a-z0-9-]{1,40}[a-z0-9]$/,
);

/** A non-empty subset of the three Portal environments. */
export const targetEnvsArb: fc.Arbitrary<string[]> = fc.subarray(
  ["dev", "uat", "prod"],
  { minLength: 1 },
);

/**
 * Builds a valid `RdsGenerateInput`. `engineOverride` lets a test inject an
 * arbitrary (possibly invalid) engine string; `fields.engine` is typed
 * `RdsEngine`, so the override is cast via `as any`.
 */
export function buildInput(
  engineOverride?: string,
  overrides: Partial<{
    engineVersion: string;
    identifier: string;
    targetEnvironments: string[];
  }> = {},
): RdsGenerateInput {
  const engine = (engineOverride ?? "postgres") as RdsEngine;
  const engineVersion =
    overrides.engineVersion ??
    (engineOverride === "postgres" || engineOverride === "mysql" || engineOverride == null
      ? defaultVersionForEngine((engineOverride ?? "postgres") as RdsEngine)
      : "0");
  const identifier = overrides.identifier ?? "marketplace-payments-api-db";

  const fields: RdsFields = {
    identifier,
    dbName: tfId(identifier),
    instanceClass: "db.t4g.micro",
    storageGb: 20,
    multiAz: false,
    engine: engineOverride as any,
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

// Touch the catalog arbitraries so unused-import linting stays quiet while these
// helpers are shared with later tasks (Properties 4, 5, 9, 16, 17).
void engineArb;
void identifierArb;
void targetEnvsArb;
void versionsForEngine;

/* ------------------------------------------------------------------ */
/*  Property 3: Rechazo de motor inválido                              */
/*  **Validates: Requirements 1.5**                                    */
/* ------------------------------------------------------------------ */

// Feature: portal-rds-creation-improvement, Property 3: Rechazo de motor inválido
test("Property 3: an unsupported engine produces no preview and an error naming the engine + supported values", async () => {
  const generator = new RdsGenerator(createMockGitlab());

  await fc.assert(
    fc.asyncProperty(invalidEngineArb, async (engine) => {
      const result = await generator.generate(buildInput(engine));

      // No preview is produced.
      assert.equal(result.ok, false);
      if (result.ok) return; // narrow for TS

      // Rejected specifically as an invalid engine.
      assert.equal(result.code, "invalid_engine");

      // The message contains the offending engine string...
      assert.ok(
        result.message.includes(engine),
        `message should contain the invalid engine "${engine}", got: ${result.message}`,
      );

      // ...and enumerates the supported value(s) — PostgreSQL only.
      assert.ok(
        result.message.includes("postgres"),
        `message should enumerate "postgres", got: ${result.message}`,
      );
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 4: Rechazo de versión inválida                            */
/*  **Validates: Requirements 2.5**                                    */
/* ------------------------------------------------------------------ */

/**
 * Pairs a valid engine with a version string that is NOT in that engine's
 * catalog. The version space mixes random strings, random integers and a few
 * hand-picked near-misses (e.g. "13"/"5.7" — real versions we don't offer),
 * always filtered to exclude the engine's actual catalog versions.
 */
const invalidEngineVersionArb: fc.Arbitrary<{ engine: RdsEngine; invalidVersion: string }> =
  engineArb.chain((engine) => {
    const valid = new Set(versionsForEngine(engine).map((v) => v.version));
    const invalidVersion = fc
      .oneof(
        fc.string(),
        fc.integer({ min: 0, max: 9999 }).map(String),
        fc.constantFrom("99", "0", "abc", "13", "14", "5.7", "10.0"),
      )
      .filter((v) => !valid.has(v));
    return fc.record({ engine: fc.constant(engine), invalidVersion });
  });

// Feature: portal-rds-creation-improvement, Property 4: Rechazo de versión inválida
test("Property 4: a version outside the engine catalog produces no preview and an error naming the version + engine", async () => {
  const generator = new RdsGenerator(createMockGitlab());

  await fc.assert(
    fc.asyncProperty(invalidEngineVersionArb, async ({ engine, invalidVersion }) => {
      const result = await generator.generate(
        buildInput(engine, { engineVersion: invalidVersion }),
      );

      // No preview is produced.
      assert.equal(result.ok, false);
      if (result.ok) return; // narrow for TS

      // Rejected specifically as an invalid version.
      assert.equal(result.code, "invalid_version");

      // The message identifies the offending version...
      assert.ok(
        result.message.includes(invalidVersion),
        `message should contain the invalid version "${invalidVersion}", got: ${result.message}`,
      );

      // ...and the engine it was requested for.
      assert.ok(
        result.message.includes(engine),
        `message should contain the engine "${engine}", got: ${result.message}`,
      );
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 5: Fidelidad de metadatos entre preview y formulario      */
/*  **Validates: Requirements 1.6, 7.2**                               */
/* ------------------------------------------------------------------ */

/**
 * Pairs a valid engine with a valid version drawn from that engine's catalog,
 * a valid identifier and a non-empty subset of the Portal environments. This
 * exercises the happy path so the generator returns `{ ok: true, preview }`.
 */
const validRdsInputArb: fc.Arbitrary<{
  engine: RdsEngine;
  engineVersion: string;
  identifier: string;
  targetEnvironments: string[];
}> = engineArb.chain((engine) =>
  fc.record({
    engine: fc.constant(engine),
    engineVersion: fc.constantFrom(
      ...versionsForEngine(engine).map((v) => v.version),
    ),
    identifier: identifierArb,
    targetEnvironments: targetEnvsArb,
  }),
);

// Feature: portal-rds-creation-improvement, Property 5: Fidelidad de metadatos entre preview y formulario
test("Property 5: preview metadata (engine/engineVersion) and targetEnvironments mirror the form input exactly, without default substitution", async () => {
  const generator = new RdsGenerator(createMockGitlab());

  await fc.assert(
    fc.asyncProperty(
      validRdsInputArb,
      async ({ engine, engineVersion, identifier, targetEnvironments }) => {
        const result = await generator.generate(
          buildInput(engine, { engineVersion, identifier, targetEnvironments }),
        );

        // The valid path must produce a preview.
        assert.equal(result.ok, true);
        if (!result.ok) return; // narrow for TS

        // metadata.engine is exactly the engine received from the form.
        assert.equal(result.preview.metadata?.engine, engine);

        // metadata.engineVersion is exactly the version received from the form
        // (no substitution by the engine's default version).
        assert.equal(result.preview.metadata?.engineVersion, engineVersion);

        // targetEnvironments is the exact list received from the form.
        assert.deepEqual(result.preview.targetEnvironments, targetEnvironments);
      },
    ),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 9: Guarda anti-literal                                    */
/*  **Validates: Requirements 3.6**                                    */
/* ------------------------------------------------------------------ */

/**
 * The five parameterized attributes, mirroring the exact lines the generator
 * emits in the `.tf`. `varSuffix` is the `<db>_` suffix used for the
 * `var.<db>_<suffix>` reference; `literal` is a representative literal value
 * (string attrs quoted, bool attrs unquoted) that the guard MUST reject.
 */
const GUARD_ATTRS = [
  { attr: "engine_version", varSuffix: "rds_version", literal: '"18"' },
  { attr: "family", varSuffix: "family", literal: '"postgres18"' },
  { attr: "major_engine_version", varSuffix: "major_engine_version", literal: '"18"' },
  {
    attr: "allow_major_version_upgrade",
    varSuffix: "allow_major_version_upgrade",
    literal: "false",
  },
  { attr: "apply_immediately", varSuffix: "apply_immediately", literal: "false" },
] as const;

/**
 * Builds a candidate `.tf` for a database prefix `db`, rendering each of the
 * five attributes either as a `var.<db>_<suffix>` reference (`asLiteral=false`)
 * or as a literal (`asLiteral=true`), mirroring the generator's line anchoring
 * (each attribute on its own line, leading indentation). Wrapped in a realistic
 * module block so the guard's `^`-anchored regex is exercised as in production.
 */
function buildCandidateTf(db: string, asLiteral: boolean[]): string {
  const lines: string[] = [];
  lines.push(`module "${db}" {`);
  lines.push(`  source  = "terraform-aws-modules/rds/aws"`);
  lines.push(`  version = "6.10.0"`);
  lines.push("");
  lines.push(`  identifier = "${db}"`);
  lines.push(`  engine     = "postgres"`);
  GUARD_ATTRS.forEach((a, i) => {
    const rhs = asLiteral[i] ? a.literal : `var.${db}_${a.varSuffix}`;
    lines.push(`  ${a.attr} = ${rhs}`);
  });
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

/** Exactly five booleans deciding literal-vs-reference per attribute. */
const literalFlagsArb: fc.Arbitrary<boolean[]> = fc.array(fc.boolean(), {
  minLength: GUARD_ATTRS.length,
  maxLength: GUARD_ATTRS.length,
});

// Feature: portal-rds-creation-improvement, Property 9: Guarda anti-literal
test("Property 9: the guard blocks any literal assignment of the five attributes and passes only when all use var.<db>_... references", async () => {
  await fc.assert(
    fc.property(identifierArb, literalFlagsArb, (identifier, flags) => {
      const db = tfId(identifier);
      const tf = buildCandidateTf(db, flags);

      const offending = findLiteralRdsAttribute(tf);
      const literalAttrs = GUARD_ATTRS.filter((_, i) => flags[i]).map((a) => a.attr);

      if (literalAttrs.length === 0) {
        // All five are var references → valid, the guard returns null.
        assert.equal(
          offending,
          null,
          `expected null (all var refs) but guard flagged "${offending}"\n${tf}`,
        );
      } else {
        // At least one literal → blocked, and the flagged attribute must be one
        // of the attributes actually rendered as a literal.
        assert.notEqual(offending, null, `expected a literal to be detected\n${tf}`);
        assert.ok(
          offending != null && (literalAttrs as readonly string[]).includes(offending),
          `guard flagged "${offending}", which is not among the literal attrs ` +
            `[${literalAttrs.join(", ")}]\n${tf}`,
        );
      }
    }),
    { numRuns: 200 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 16: Guarda de completitud de tfvars                       */
/*  **Validates: Requirements 6.6**                                    */
/* ------------------------------------------------------------------ */

/**
 * The five parameterized variable suffixes and their Terraform types, mirroring
 * the variables the render emits with the per-database `<db>_` prefix.
 */
const TFVARS_VAR_SUFFIXES = [
  { suffix: "rds_version", type: "string" as const },
  { suffix: "family", type: "string" as const },
  { suffix: "major_engine_version", type: "string" as const },
  { suffix: "allow_major_version_upgrade", type: "bool" as const },
  { suffix: "apply_immediately", type: "bool" as const },
];

/** The three tfvars environment keys, in the order the guard scans them. */
const TFVARS_ENV_KEYS: Array<keyof ParameterizedVar["values"]> = ["dev", "uat", "pro"];

/** A non-empty value (any non-empty string counts as covered for the guard). */
const nonEmptyValueArb: fc.Arbitrary<string> = fc.string({ minLength: 1 });

/**
 * Generates a full 5×3 set of ParameterizedVar for a database prefix, with
 * arbitrary non-empty values, plus an optional single gap (one variable blanked
 * out in one specific environment). When `gap` is null the coverage is complete.
 */
const tfvarsCoverageArb: fc.Arbitrary<{
  db: string;
  vars: ParameterizedVar[];
  gap: { varIndex: number; envIndex: number } | null;
}> = fc
  .record({
    identifier: identifierArb,
    // 5 variables × 3 environments of non-empty values.
    grid: fc.array(
      fc.tuple(nonEmptyValueArb, nonEmptyValueArb, nonEmptyValueArb),
      { minLength: TFVARS_VAR_SUFFIXES.length, maxLength: TFVARS_VAR_SUFFIXES.length },
    ),
    gap: fc.option(
      fc.record({
        varIndex: fc.integer({ min: 0, max: TFVARS_VAR_SUFFIXES.length - 1 }),
        envIndex: fc.integer({ min: 0, max: TFVARS_ENV_KEYS.length - 1 }),
      }),
      { nil: null },
    ),
  })
  .map(({ identifier, grid, gap }) => {
    const db = tfId(identifier);
    const vars: ParameterizedVar[] = TFVARS_VAR_SUFFIXES.map((s, i) => ({
      name: `${db}_${s.suffix}`,
      type: s.type,
      values: { dev: grid[i][0], uat: grid[i][1], pro: grid[i][2] },
    }));

    // Introduce exactly one gap (blank a single cell) when requested.
    if (gap) {
      const envKey = TFVARS_ENV_KEYS[gap.envIndex];
      vars[gap.varIndex].values[envKey] = "";
    }

    return { db, vars, gap };
  });

// Feature: portal-rds-creation-improvement, Property 16: Guarda de completitud de tfvars
test("Property 16: the tfvars completeness guard aborts identifying variable + file on any 5×3 gap, and passes with complete coverage", () => {
  fc.assert(
    fc.property(tfvarsCoverageArb, ({ db, vars, gap }) => {
      const result = findTfvarsGap(vars);

      if (gap == null) {
        // Complete 5×3 coverage → guard passes (returns null).
        assert.equal(
          result,
          null,
          `expected null for complete coverage but guard flagged ${JSON.stringify(result)}`,
        );
      } else {
        // A gap exists → guard aborts identifying the exact variable + file.
        assert.notEqual(result, null, "expected the guard to detect the gap");
        if (result == null) return; // narrow for TS

        const expectedVariable = `${db}_${TFVARS_VAR_SUFFIXES[gap.varIndex].suffix}`;
        const expectedFile = ENV_TO_TFVARS[gap.envIndex].file;

        assert.equal(
          result.variable,
          expectedVariable,
          `guard flagged variable "${result.variable}", expected "${expectedVariable}"`,
        );
        assert.equal(
          result.file,
          expectedFile,
          `guard flagged file "${result.file}", expected "${expectedFile}"`,
        );
      }
    }),
    { numRuns: 200 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 17: Guarda de coherencia preview↔formulario               */
/*  **Validates: Requirements 7.5**                                    */
/* ------------------------------------------------------------------ */

/** The three fields the coherence guard compares, in scan order. */
const COHERENCE_FIELDS = ["engine", "engineVersion", "family"] as const;
type CoherenceField = (typeof COHERENCE_FIELDS)[number];

/**
 * Builds a valid form triple {engine, engineVersion, family} drawn from the
 * catalog (via `versionsForEngine`/`familyForVersion`) plus a `perturb`
 * directive: either `null` (metadata identical to form) or exactly one of the
 * three fields to diverge from the form selection.
 */
const coherenceCaseArb: fc.Arbitrary<{
  engine: RdsEngine;
  engineVersion: string;
  family: string;
  perturb: CoherenceField | null;
}> = engineArb.chain((engine) => {
  const versions = versionsForEngine(engine);
  return fc.record({
    engine: fc.constant(engine),
    entry: fc.constantFrom(...versions),
    perturb: fc.constantFrom<CoherenceField | null>(
      null,
      "engine",
      "engineVersion",
      "family",
    ),
  });
}).map(({ engine, entry, perturb }) => ({
  engine,
  engineVersion: entry.version,
  // Cross-check the catalog derivation matches the version entry's family.
  family: familyForVersion(engine, entry.version) ?? entry.family,
  perturb,
}));

// Feature: portal-rds-creation-improvement, Property 17: Guarda de coherencia preview↔formulario
test("Property 17: the coherence guard passes when metadata mirrors the form, and rejects identifying the single discrepant field otherwise", () => {
  fc.assert(
    fc.property(coherenceCaseArb, ({ engine, engineVersion, family, perturb }) => {
      const form = { engine, engineVersion, family };
      const metadata: { engine?: string; engineVersion?: string; family?: string } = {
        ...form,
      };

      if (perturb === "engine") {
        // Diverge to the other supported engine (guaranteed different).
        metadata.engine = engine === "postgres" ? "mysql" : "postgres";
      } else if (perturb === "engineVersion") {
        // Any value different from the form version.
        metadata.engineVersion = `${engineVersion}-divergent`;
      } else if (perturb === "family") {
        metadata.family = `${family}-divergent`;
      }

      const result = checkRdsCoherence(metadata, form);

      if (perturb == null) {
        // All three match → guard passes (returns null), preview is persisted.
        assert.equal(
          result,
          null,
          `expected null for matching metadata but guard flagged ${JSON.stringify(result)}`,
        );
      } else {
        // Exactly one field diverges → guard rejects identifying that field.
        assert.notEqual(result, null, "expected the guard to reject the divergence");
        if (result == null) return; // narrow for TS
        assert.equal(
          result.field,
          perturb,
          `guard flagged field "${result.field}", expected the perturbed field "${perturb}"`,
        );
      }
    }),
    { numRuns: 100 },
  );
});
