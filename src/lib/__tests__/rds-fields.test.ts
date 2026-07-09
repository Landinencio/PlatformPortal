/**
 * Unit (example-based) tests for the Formulario_RDS (RdsFieldsPanel + its
 * container infra-request-form-v2).
 *
 * Feature: portal-rds-creation-improvement
 *   - src/components/infra-request-v2/rds-fields.tsx
 *   - src/components/infra-request-v2/infra-request-form-v2.tsx
 *
 * The repo's test stack is `node:test` (via `tsx --test`) with no DOM /
 * React renderer available, so these tests target the deterministic,
 * catalog-driven logic the form relies on (defaults, labels, submit-blocking
 * validation and the field payload shape). Component label requirements are
 * verified by asserting on the component source text — DOM-free but still a
 * real check of the rendered strings.
 *
 * Covers:
 *   - Catalog defaults (R2.2, R2.3)
 *   - Resource-type / engine label "PostgreSQL" + "MySQL" (R7.4)
 *   - Submit blocked with empty environments (R6.5) / empty catalog (R2.6)
 *   - Field transmission engine + engineVersion + targetEnvironments (R7.1)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  defaultVersionForEngine,
  familyForVersion,
  versionsForEngine,
  isValidEngineVersion,
  type RdsEngine,
} from "../rds/version-catalog";

// ── Helpers ────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const componentDir = join(here, "../../components/infra-request-v2");

function readComponent(name: string): string {
  return readFileSync(join(componentDir, name), "utf8");
}

/**
 * Mirrors the submit-validation predicate used by RdsFieldsPanel.notify():
 *
 *   const versionValid = !catalogEmpty && isValidEngineVersion(engine, engineVersion)
 *   const envsValid    = targetEnvironments.length > 0
 *   const valid        = identifierValid && dbNameValid && envsValid && versionValid
 *
 * Identifier/dbName regexes are also mirrored from the component so the example
 * tests exercise the same deterministic core that drives the form's `valid`.
 */
const IDENTIFIER_RE = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;
const DB_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

function formIsValid(input: {
  identifier: string;
  dbName: string;
  engine: string;
  engineVersion: string;
  targetEnvironments: string[];
}): boolean {
  const identifierValid = IDENTIFIER_RE.test(input.identifier);
  const dbNameValid = DB_NAME_RE.test(input.dbName);
  const envsValid = input.targetEnvironments.length > 0;
  const catalogEmpty = versionsForEngine(input.engine).length === 0;
  const versionValid =
    !catalogEmpty && isValidEngineVersion(input.engine, input.engineVersion);
  return identifierValid && dbNameValid && envsValid && versionValid;
}

/**
 * Mirrors the RDS branch of infra-request-form-v2.handleSubmit(): it always
 * forwards engine, engineVersion (with the postgres/"" backward-compatible
 * fallbacks) and lifts targetEnvironments to the top level of the request body.
 */
function buildRdsRequestBody(
  fields: {
    identifier: string;
    dbName: string;
    engine?: RdsEngine;
    engineVersion?: string;
    targetEnvironments: string[];
  },
  team: string,
) {
  const { targetEnvironments, ...rest } = fields;
  const outFields = {
    ...rest,
    engine: rest.engine ?? "postgres",
    engineVersion: rest.engineVersion ?? "",
  };
  return { team, resourceType: "rds" as const, fields: outFields, targetEnvironments };
}

// ── Catalog defaults (R2.2, R2.3) ────────────────────────────────────────────

test("R2.2: postgres default version is 18 with family postgres18", () => {
  assert.equal(defaultVersionForEngine("postgres"), "18");
  assert.equal(familyForVersion("postgres", "18"), "postgres18");
});

test("R2.3 (decision): mysql is no longer supported — empty catalog, no default, no family", () => {
  // Organizational decision: new RDS may only use PostgreSQL. MySQL is removed
  // from the catalog, so it has no versions, no derivable family and is invalid.
  assert.equal(versionsForEngine("mysql").length, 0);
  assert.equal(familyForVersion("mysql", "8.4"), null);
  assert.equal(isValidEngineVersion("mysql", "8.4"), false);
});

test("R2.2/R2.3: each engine's default version exists in its own catalog", () => {
  for (const engine of ["postgres"] as RdsEngine[]) {
    const def = defaultVersionForEngine(engine);
    assert.ok(
      isValidEngineVersion(engine, def),
      `default version "${def}" must belong to ${engine} catalog`,
    );
    // The derived family must start with the engine name (no cross-engine leak).
    const family = familyForVersion(engine, def);
    assert.ok(family && family.startsWith(engine), `family "${family}" must start with "${engine}"`);
  }
});

// ── Resource-type / engine label "PostgreSQL" only, MySQL removed (R7.4) ──────

test("R7.4: resource-type label in infra-request-form-v2 says PostgreSQL only (no MySQL)", () => {
  const src = readComponent("infra-request-form-v2.tsx");
  // The selectable RDS item and the success summary label PostgreSQL only.
  assert.match(src, /RDS \(PostgreSQL\)/);
  assert.ok(src.includes("PostgreSQL"), "label must mention PostgreSQL");
  // MySQL must NOT be offered anywhere in the resource-type labelling.
  assert.ok(!src.includes("MySQL"), "label must not mention MySQL (engine removed)");
});

test("R7.4: rds-fields no longer offers MySQL as an engine option", () => {
  const src = readComponent("rds-fields.tsx");
  assert.ok(src.includes("PostgreSQL"), "engineLabel must produce PostgreSQL");
  // The form is catalog-driven (SUPPORTED_ENGINES = ['postgres']); there must be
  // no MySQL option literal in the component.
  assert.ok(!src.includes('"MySQL"'), "rds-fields must not present a MySQL option");
});

// ── Submit blocking: empty environments (R6.5) ───────────────────────────────

test("R6.5: submit is blocked when no target environment is selected", () => {
  const blocked = formIsValid({
    identifier: "my-database",
    dbName: "my_database",
    engine: "postgres",
    engineVersion: "18",
    targetEnvironments: [], // empty -> must block
  });
  assert.equal(blocked, false);
});

test("R6.5: submit is allowed once at least one environment is selected (others valid)", () => {
  const ok = formIsValid({
    identifier: "my-database",
    dbName: "my_database",
    engine: "postgres",
    engineVersion: "18",
    targetEnvironments: ["dev"],
  });
  assert.equal(ok, true);
});

// ── Submit blocking: empty catalog (R2.6) ────────────────────────────────────

test("R2.6: submit is blocked when the engine catalog is empty (unsupported engine)", () => {
  // An unsupported engine yields an empty catalog -> versionsForEngine returns [].
  assert.equal(versionsForEngine("oracle").length, 0);
  const blocked = formIsValid({
    identifier: "my-database",
    dbName: "my_database",
    engine: "oracle",
    engineVersion: "19",
    targetEnvironments: ["dev"],
  });
  assert.equal(blocked, false);
});

test("R2.6: the only supported engine (postgres) never has an empty catalog; mysql is empty", () => {
  assert.ok(versionsForEngine("postgres").length > 0);
  assert.equal(versionsForEngine("mysql").length, 0);
});

test("R1.4/R2.6: submit is blocked when no valid version is selected (empty selection)", () => {
  const blocked = formIsValid({
    identifier: "my-database",
    dbName: "my_database",
    engine: "postgres",
    engineVersion: "", // "sin selección"
    targetEnvironments: ["dev"],
  });
  assert.equal(blocked, false);
});

// ── Field transmission (R7.1) ────────────────────────────────────────────────

test("R7.1: request body carries engine, engineVersion and targetEnvironments", () => {
  const body = buildRdsRequestBody(
    {
      identifier: "marketplace-payments-api-db",
      dbName: "marketplace_payments",
      engine: "postgres",
      engineVersion: "18",
      targetEnvironments: ["dev", "uat"],
    },
    "digital",
  );

  assert.equal(body.resourceType, "rds");
  assert.equal(body.fields.engine, "postgres");
  assert.equal(body.fields.engineVersion, "18");
  // targetEnvironments is lifted to the top level and preserved exactly.
  assert.deepEqual(body.targetEnvironments, ["dev", "uat"]);
  // engine/engineVersion must NOT be stripped from the forwarded fields.
  assert.ok("engine" in body.fields);
  assert.ok("engineVersion" in body.fields);
});

test("R7.1: engine defaults to postgres and engineVersion to '' when absent (backward compat)", () => {
  const body = buildRdsRequestBody(
    {
      identifier: "legacy-db",
      dbName: "legacy",
      targetEnvironments: ["prod"],
    },
    "digital",
  );

  assert.equal(body.fields.engine, "postgres");
  assert.equal(body.fields.engineVersion, "");
  assert.deepEqual(body.targetEnvironments, ["prod"]);
});

test("R7.1: postgres selection round-trips engine + default version through the body", () => {
  const body = buildRdsRequestBody(
    {
      identifier: "core-db",
      dbName: "core",
      engine: "postgres",
      engineVersion: defaultVersionForEngine("postgres"),
      targetEnvironments: ["dev", "uat", "prod"],
    },
    "digital",
  );

  assert.equal(body.fields.engine, "postgres");
  assert.equal(body.fields.engineVersion, "18");
  assert.deepEqual(body.targetEnvironments, ["dev", "uat", "prod"]);
});
