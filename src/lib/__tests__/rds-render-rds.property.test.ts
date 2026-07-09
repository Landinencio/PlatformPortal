/**
 * Property-based tests for the deterministic RDS render (`src/lib/rds/render-rds.ts`).
 *
 * Feature: portal-rds-creation-improvement
 *
 * This file holds the render-related correctness properties. The shared
 * arbitraries below (identifierArb, engineVersionArb, targetEnvsArb and the
 * `buildRdsFields` helper) are reused by Properties 6, 7, 8, 10, 13 and 15.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { renderRds, tfId, upsertTfvarsEntries } from "../rds/render-rds";
import {
  type RdsEngine,
  versionsForEngine,
  familyForVersion,
} from "../rds/version-catalog";
import type { RdsFields } from "../infra-prompt-builder";

/**
 * A valid network wiring (SRE-001) passed to `renderRds` in every property so
 * the render emits the security group + subnet_ids/vpc_security_group_ids
 * network block instead of defaulting to the account's default VPC. Mirrors the
 * shape discovered from a real repo (`vpc_id`, `oms_pvt_subnet`, a `concat(...)`
 * ingress CIDR expression and port 5432).
 */
const TEST_NETWORK = {
  vpcIdExpr: "var.vpc_id",
  subnetIdsExpr: "var.oms_pvt_subnet",
  ingressCidrExpr:
    "concat(var.eks_vpc_private_subnet_cidrs, var.oms_general_vpc_private_subnet_cidrs)",
  port: 5432,
};

/* ------------------------------------------------------------------ */
/*  Shared arbitraries (reused by Properties 6, 7, 8, 10, 13, 15)      */
/* ------------------------------------------------------------------ */

/**
 * A valid RDS identifier: starts with a lowercase letter, contains lowercase
 * letters / digits / hyphens, and ends with an alphanumeric. Exercises `tfId`
 * and the `<db>_` prefix derivation.
 */
export const identifierArb: fc.Arbitrary<string> = fc.stringMatching(
  /^[a-z][a-z0-9-]{1,40}[a-z0-9]$/,
);

/** Engine generator: PostgreSQL is the only supported Motor (MySQL removed). */
export const engineArb: fc.Arbitrary<RdsEngine> = fc.constantFrom("postgres");

/**
 * Picks a supported engine together with one of its catalog versions, so every
 * (engine, version) pair drawn is guaranteed to belong to the catalog.
 */
export const engineVersionArb: fc.Arbitrary<{ engine: RdsEngine; version: string }> =
  engineArb.chain((engine) => {
    const versions = versionsForEngine(engine);
    return fc
      .integer({ min: 0, max: versions.length - 1 })
      .map((i) => ({ engine, version: versions[i].version }));
  });

/** A pinned MAJOR.MINOR.PATCH module version (no range operators). */
export const moduleVersionArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 0, max: 20 }),
    fc.integer({ min: 0, max: 30 }),
    fc.integer({ min: 0, max: 50 }),
  )
  .map(([maj, min, patch]) => `${maj}.${min}.${patch}`);

/** A non-empty subset of the three Portal environments. */
export const targetEnvsArb: fc.Arbitrary<string[]> = fc
  .subarray(["dev", "uat", "prod"], { minLength: 1 });

/** Builds a valid `RdsFields` from an engine + version + identifier. */
export function buildRdsFields(
  engine: RdsEngine,
  engineVersion: string,
  identifier: string,
): RdsFields {
  return {
    identifier,
    dbName: tfId(identifier),
    instanceClass: "db.t4g.micro",
    storageGb: 20,
    multiAz: false,
    engine,
    engineVersion,
  };
}

/**
 * A full valid render input: engine+version from the catalog, a valid
 * identifier, a pinned module version and a non-empty environment subset.
 */
export const validRdsInputArb = fc
  .record({
    ev: engineVersionArb,
    identifier: identifierArb,
    moduleVersion: moduleVersionArb,
    targetEnvironments: targetEnvsArb,
  })
  .map(({ ev, identifier, moduleVersion, targetEnvironments }) => ({
    fields: buildRdsFields(ev.engine, ev.version, identifier),
    family: familyForVersion(ev.engine, ev.version)!,
    moduleVersion,
    targetEnvironments,
  }));

/* ------------------------------------------------------------------ */
/*  Property 6: Parametrización sin literales con prefijo <db>_        */
/*  **Validates: Requirements 3.1**                                    */
/* ------------------------------------------------------------------ */

/** The five parameterized attributes and the variable suffix each must reference. */
const PARAMETERIZED_ATTRS: Array<{ attr: string; suffix: string }> = [
  { attr: "engine_version", suffix: "rds_version" },
  { attr: "family", suffix: "family" },
  { attr: "major_engine_version", suffix: "major_engine_version" },
  { attr: "allow_major_version_upgrade", suffix: "allow_major_version_upgrade" },
  { attr: "apply_immediately", suffix: "apply_immediately" },
];

// Feature: portal-rds-creation-improvement, Property 6: Parametrización sin literales con prefijo <db>_
test("Property 6: each of the five attributes is assigned via var.<db>_... with prefix tfId(identifier) and never a literal", () => {
  fc.assert(
    fc.property(validRdsInputArb, ({ fields, family, moduleVersion, targetEnvironments }) => {
      const db = tfId(fields.identifier);
      const { tf } = renderRds(fields, family, moduleVersion, targetEnvironments, new Set(), TEST_NETWORK);

      for (const { attr, suffix } of PARAMETERIZED_ATTRS) {
        // Grab the exact attribute assignment line (anchored to line start so
        // `engine_version` cannot accidentally match `major_engine_version`).
        const m = tf.match(new RegExp(`^\\s*${attr}\\s*=\\s*(.+)$`, "m"));
        assert.notEqual(m, null, `attribute "${attr}" should be assigned in the .tf`);

        const rhs = m![1].trim();
        const expectedRef = `var.${db}_${suffix}`;

        // The RHS must be exactly the `var.<db>_...` reference (R3.1).
        assert.equal(
          rhs,
          expectedRef,
          `attribute "${attr}" should reference "${expectedRef}", got "${rhs}"`,
        );

        // ...and therefore NOT a literal value (quoted string, number or bool).
        assert.ok(
          rhs.startsWith(`var.${db}_`),
          `attribute "${attr}" must use a var.<db>_ reference, got "${rhs}"`,
        );
        assert.ok(
          !/^("|\d|true\b|false\b)/.test(rhs),
          `attribute "${attr}" must not be a literal, got "${rhs}"`,
        );
      }
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 7: Declaraciones de variables = referenciadas menos       */
/*  existentes                                                          */
/*  **Validates: Requirements 3.2**                                    */
/* ------------------------------------------------------------------ */

/**
 * Picks an arbitrary subset of the five parameterized variables to mark as
 * "already declared" in variables.tf. The five names depend on the identifier,
 * so the subset is expressed as a 5-length boolean mask (one flag per variable,
 * in render order); the actual variable names are resolved inside the property
 * from the rendered `vars`.
 */
export const existingVarsArb: fc.Arbitrary<boolean[]> = fc.array(fc.boolean(), {
  minLength: 5,
  maxLength: 5,
});

/** Extracts the declared variable names from a `variableDeclarations` blob. */
function parseDeclaredVarNames(declarations: string): string[] {
  const names: string[] = [];
  const re = /variable\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(declarations)) !== null) {
    names.push(m[1]);
  }
  return names;
}

// Feature: portal-rds-creation-improvement, Property 7: Declaraciones de variables = referenciadas menos existentes
test("Property 7: the declarations added are exactly the five parameterized variables not already present (no duplicates, no omissions)", () => {
  fc.assert(
    fc.property(
      validRdsInputArb,
      existingVarsArb,
      ({ fields, family, moduleVersion, targetEnvironments }, mask) => {
        // First render with no existing variables to discover the five names.
        const { vars } = renderRds(fields, family, moduleVersion, targetEnvironments, new Set(), TEST_NETWORK);
        const allNames = vars.map((v) => v.name);
        assert.equal(allNames.length, 5, "render should produce exactly five variables");

        // The mask marks which of the five names already exist in variables.tf.
        const existingNames = allNames.filter((_, i) => mask[i]);
        const existingVariables = new Set(existingNames);

        // Second render with that subset marked as existing.
        const { variableDeclarations } = renderRds(
          fields,
          family,
          moduleVersion,
          targetEnvironments,
          existingVariables,
          TEST_NETWORK,
        );

        const declared = parseDeclaredVarNames(variableDeclarations);

        // Expected = all five names minus the ones already present.
        const expected = allNames.filter((n) => !existingVariables.has(n));

        // No duplicates in the declared set.
        assert.equal(
          declared.length,
          new Set(declared).size,
          `declarations must not contain duplicates, got [${declared.join(", ")}]`,
        );

        // Declared set === referenced (all five) minus existing, exactly.
        assert.deepEqual(
          [...declared].sort(),
          [...expected].sort(),
          `declared variables must be exactly the absent ones; existing=[${existingNames.join(
            ", ",
          )}]`,
        );

        // No already-present variable is re-declared (no duplicating a present one).
        for (const name of existingNames) {
          assert.ok(
            !declared.includes(name),
            `already-present variable "${name}" must not be re-declared`,
          );
        }
      },
    ),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 8: Cobertura completa y bien tipada de los tres tfvars     */
/*  **Validates: Requirements 3.3, 6.1, 6.2, 6.4**                     */
/* ------------------------------------------------------------------ */

/**
 * Arbitrary initial content for a tfvars file: a (possibly empty) list of
 * unrelated `key = value` lines. Keys are valid HCL identifiers and values are
 * either quoted strings or bare booleans, mirroring real tfvars content. Used
 * as the starting content for each of the three files to prove the upsert is
 * non-destructive AND that coverage is complete afterwards.
 */
const tfvarsContentArb: fc.Arbitrary<string> = fc
  .array(
    fc.record({
      key: fc.stringMatching(/^[a-z_][a-z0-9_]{0,20}$/),
      value: fc.oneof(
        fc.stringMatching(/^[a-z0-9.]{1,10}$/).map((s) => `"${s}"`),
        fc.constantFrom("true", "false"),
      ),
    }),
    { maxLength: 8 },
  )
  .map((rows) => rows.map((r) => `${r.key} = ${r.value}`).join("\n"));

/** The three tfvars files keyed exactly as `ParameterizedVar.values` (prod→pro). */
const TFVARS_ENV_KEYS = ["dev", "uat", "pro"] as const;

// Feature: portal-rds-creation-improvement, Property 8: Cobertura completa y bien tipada de los tres tfvars
test("Property 8: each of the three tfvars (dev/uat/pro) covers all five variables with a non-empty, correctly typed value, regardless of selected environments", () => {
  fc.assert(
    fc.property(
      validRdsInputArb,
      fc.tuple(tfvarsContentArb, tfvarsContentArb, tfvarsContentArb),
      ({ fields, family, moduleVersion, targetEnvironments }, initialContents) => {
        const { vars } = renderRds(
          fields,
          family,
          moduleVersion,
          targetEnvironments,
          new Set(),
          TEST_NETWORK,
        );
        assert.equal(vars.length, 5, "render should produce exactly five variables");

        // One tfvars file per environment key; `prod` is keyed as `pro`.
        TFVARS_ENV_KEYS.forEach((envKey, fileIdx) => {
          // Build the entries for this file from the five parameterized vars,
          // taking the value for this specific environment.
          const entries = vars.map((v) => ({
            key: v.name,
            value: v.values[envKey],
            type: v.type,
          }));

          const result = upsertTfvarsEntries(initialContents[fileIdx], entries);

          for (const v of vars) {
            const value = v.values[envKey];

            // Value must be non-empty (R6.1, R6.2).
            assert.ok(
              value.length > 0,
              `variable "${v.name}" must have a non-empty value in the ${envKey} tfvars`,
            );

            // bool → unquoted, string → quoted (R6.x typing).
            const rendered = v.type === "bool" ? value : `"${value}"`;

            // The resulting content must contain exactly `name = <rendered>`.
            const lineRe = new RegExp(
              `^\\s*${v.name}\\s*=\\s*${rendered.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
              "m",
            );
            assert.ok(
              lineRe.test(result),
              `tfvars (${envKey}) must contain "${v.name} = ${rendered}"; got:\n${result}`,
            );

            // String values are quoted; bool values are NOT quoted.
            const anyAssignRe = new RegExp(`^\\s*${v.name}\\s*=\\s*(.+?)\\s*$`, "m");
            const am = result.match(anyAssignRe);
            assert.notEqual(am, null, `variable "${v.name}" should be assigned`);
            const rhs = am![1].trim();
            if (v.type === "bool") {
              assert.ok(
                !rhs.startsWith('"'),
                `bool variable "${v.name}" must be unquoted, got "${rhs}"`,
              );
            } else {
              assert.ok(
                rhs.startsWith('"') && rhs.endsWith('"'),
                `string variable "${v.name}" must be quoted, got "${rhs}"`,
              );
            }
          }
        });
      },
    ),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 10: Version_Modulo exacta sin operadores                  */
/*  **Validates: Requirements 4.1**                                    */
/* ------------------------------------------------------------------ */

/** Range operators that must never appear inside the module `version` value. */
const RANGE_OPERATORS = ["~>", ">=", "<=", ">", "<", "="] as const;

// Feature: portal-rds-creation-improvement, Property 10: Version_Modulo exacta sin operadores
test("Property 10: the module block version is exactly the selected module version, matches MAJOR.MINOR.PATCH and carries no range operators", () => {
  fc.assert(
    fc.property(validRdsInputArb, ({ fields, family, moduleVersion, targetEnvironments }) => {
      const { tf } = renderRds(fields, family, moduleVersion, targetEnvironments, new Set(), TEST_NETWORK);

      // Extract the version value from the module block. Line-anchored so it
      // cannot match anything other than the `version = "..."` attribute.
      const m = tf.match(/^\s*version\s*=\s*"([^"]+)"\s*$/m);
      assert.notEqual(m, null, "the module block must declare a quoted version");

      const captured = m![1];

      // Exactly the selected module version (no fallback, no decoration).
      assert.equal(
        captured,
        moduleVersion,
        `module version must equal "${moduleVersion}", got "${captured}"`,
      );

      // Strict MAJOR.MINOR.PATCH shape (R4.1).
      assert.ok(
        /^\d+\.\d+\.\d+$/.test(captured),
        `module version must match MAJOR.MINOR.PATCH, got "${captured}"`,
      );

      // No range operators inside the captured value (check the value, not the
      // whole line — the `=` of `version =` is part of the assignment, not the
      // version string).
      for (const op of RANGE_OPERATORS) {
        assert.ok(
          !captured.includes(op),
          `module version "${captured}" must not contain the range operator "${op}"`,
        );
      }
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 13: Rotación obligatoria y ausencia de contraseña en      */
/*  claro                                                              */
/*  **Validates: Requirements 5.1, 5.4**                              */
/* ------------------------------------------------------------------ */

/**
 * The four Bloque_Rotacion attributes with their EXACT required values. Each is
 * matched with a line-anchored regex so that, for example,
 * `manage_master_user_password` cannot accidentally match the longer
 * `manage_master_user_password_rotation` line (the `\s*=` after the name forces
 * the match to end at this exact attribute).
 */
const ROTATION_ATTRS: Array<{ attr: string; valueRe: string }> = [
  { attr: "manage_master_user_password", valueRe: "true" },
  { attr: "manage_master_user_password_rotation", valueRe: "true" },
  { attr: "master_user_password_rotate_immediately", valueRe: "false" },
  {
    attr: "master_user_password_rotation_schedule_expression",
    valueRe: '"rate\\(15 days\\)"',
  },
];

// Feature: portal-rds-creation-improvement, Property 13: Rotación obligatoria y ausencia de contraseña en claro
test("Property 13: the generated .tf contains the four Bloque_Rotacion attributes with their exact values and no literal password assignment", () => {
  fc.assert(
    fc.property(validRdsInputArb, ({ fields, family, moduleVersion, targetEnvironments }) => {
      const { tf } = renderRds(fields, family, moduleVersion, targetEnvironments, new Set(), TEST_NETWORK);

      // (1) The four rotation attributes are present with their exact values.
      for (const { attr, valueRe } of ROTATION_ATTRS) {
        const lineRe = new RegExp(`^\\s*${attr}\\s*=\\s*${valueRe}\\s*$`, "m");
        assert.ok(
          lineRe.test(tf),
          `the .tf must contain "${attr} = ${valueRe.replace(/\\/g, "")}" exactly`,
        );
      }

      // (2) No plaintext password. There must be no attribute literally named
      // `password` assigned a value...
      assert.ok(
        !/^\s*password\s*=/m.test(tf),
        `the .tf must not contain a literal "password =" assignment`,
      );

      // ...and no attribute whose name ends in `_password` assigned a quoted
      // string secret (the rotation attributes end in `_password`, but they are
      // assigned bools/refs, and the schedule expression — a quoted string —
      // ends in `_expression`, not `_password`). The negative lookahead keeps a
      // legitimate `"rate(...)"` schedule from being misread as a secret.
      assert.ok(
        !/_password\s*=\s*"(?!rate\()/m.test(tf),
        `the .tf must not assign a quoted string secret to a *_password attribute`,
      );
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 15: Scoping multi-entorno mediante count                  */
/*  **Validates: Requirements 6.3**                                    */
/* ------------------------------------------------------------------ */

/** Canonical Portal environment order (mirror of the render's ALL_ENVS). */
const CANONICAL_ENVS = ["dev", "uat", "prod"] as const;

/** Escapes a string for safe inclusion inside a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Feature: portal-rds-creation-improvement, Property 15: Scoping multi-entorno mediante count
test("Property 15: count scopes the module to exactly the selected environments unless all three are selected, while the five variables keep values in all three tfvars in both cases", () => {
  fc.assert(
    fc.property(validRdsInputArb, ({ fields, family, moduleVersion, targetEnvironments }) => {
      const { tf, vars } = renderRds(
        fields,
        family,
        moduleVersion,
        targetEnvironments,
        new Set(),
        TEST_NETWORK,
      );

      // Expectation is derived from the input: the selected environments in
      // canonical dev/uat/prod order.
      const selected = CANONICAL_ENVS.filter((e) => targetEnvironments.includes(e));

      if (selected.length === CANONICAL_ENVS.length) {
        // All three environments selected → the module carries NO count.
        assert.ok(
          !/^\s*count\s*=/m.test(tf),
          `with all three environments selected the .tf must not contain a "count =" line; got:\n${tf}`,
        );
      } else {
        // A strict, non-empty subset → exactly one count line whose list is the
        // selected environments in canonical order, each quoted.
        const expectedList = selected.map((e) => `"${e}"`).join(", ");
        const expectedExpr = `contains([${expectedList}], var.environment) ? 1 : 0`;
        const countLineRe = new RegExp(
          `^\\s*count\\s*=\\s*${escapeRegExp(expectedExpr)}\\s*$`,
          "m",
        );
        assert.ok(
          countLineRe.test(tf),
          `the .tf must contain "count = ${expectedExpr}"; got:\n${tf}`,
        );

        // And the list must be EXACTLY the selected envs (no extra entries):
        // capture the actual contains([...]) list and compare element-by-element.
        const actual = tf.match(/^\s*count\s*=\s*contains\(\[([^\]]*)\]/m);
        assert.notEqual(actual, null, "the count line must use contains([...])");
        const actualEnvs = actual![1]
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""))
          .filter((s) => s.length > 0);
        assert.deepEqual(
          actualEnvs,
          selected as unknown as string[],
          `the count list must be exactly the selected envs in canonical order`,
        );
      }

      // In BOTH branches the five variables retain a non-empty value across the
      // three tfvars (dev/uat/pro) — scoping is via count, never by dropping a
      // variable value (R6.3 coverage retained).
      assert.equal(vars.length, 5, "render should produce exactly five variables");
      for (const v of vars) {
        for (const envKey of ["dev", "uat", "pro"] as const) {
          assert.ok(
            v.values[envKey].length > 0,
            `variable "${v.name}" must keep a non-empty value in the ${envKey} tfvars`,
          );
        }
      }
    }),
    { numRuns: 100 },
  );
});
