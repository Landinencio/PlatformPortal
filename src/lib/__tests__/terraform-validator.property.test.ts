/**
 * Property-based tests for Enhanced Terraform Validator.
 *
 * Feature: infra-robustness
 * Property 1: Variable reference validation
 * Property 2: Resource name validation
 * Property 3: Count expression balanced parentheses
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  validateVariableReferences,
  validateResourceNames,
  validateCountExpressions,
  validateRdsPasswordRotation,
} from "../terraform-validator";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Generate a valid Terraform identifier: [a-zA-Z_][a-zA-Z0-9_]* */
const validIdentifierArb = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_".split("")),
    fc.array(
      fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split("")),
      { minLength: 0, maxLength: 15 }
    )
  )
  .map(([first, rest]) => first + rest.join(""));

/** Generate an invalid Terraform identifier (starts with digit or contains invalid chars) */
const invalidIdentifierArb = fc.oneof(
  // Starts with a digit
  fc
    .tuple(
      fc.constantFrom(..."0123456789".split("")),
      fc.array(
        fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_".split("")),
        { minLength: 1, maxLength: 10 }
      )
    )
    .map(([first, rest]) => first + rest.join("")),
  // Contains invalid characters (hyphen, dot, space, etc.)
  fc
    .tuple(
      fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz_".split("")),
      fc.array(
        fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_".split("")),
        { minLength: 0, maxLength: 5 }
      ),
      fc.constantFrom("-", "!", "@", "#", "$", "%", "^", "&", "+", "="),
      fc.array(
        fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_".split("")),
        { minLength: 1, maxLength: 5 }
      )
    )
    .map(([first, mid, invalid, rest]) => first + mid.join("") + invalid + rest.join(""))
);

/** Generate a valid resource name: [a-zA-Z0-9_-]+ */
const validResourceNameArb = fc
  .array(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-".split("")),
    { minLength: 1, maxLength: 20 }
  )
  .map((chars) => chars.join(""));

/** Generate an invalid resource name (contains invalid chars) */
const invalidResourceNameArb = fc
  .tuple(
    fc.array(
      fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_".split("")),
      { minLength: 0, maxLength: 5 }
    ),
    fc.constantFrom("!", "@", "#", "$", "%", "^", "&", "*", "+", "=", " ", ".", "/", "\\", "~"),
    fc.array(
      fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_".split("")),
      { minLength: 1, maxLength: 5 }
    )
  )
  .map(([prefix, invalid, suffix]) => prefix.join("") + invalid + suffix.join(""));

/** Generate a resource type */
const resourceTypeArb = fc.constantFrom(
  "aws_instance",
  "aws_s3_bucket",
  "aws_rds_instance",
  "aws_iam_role",
  "aws_security_group",
  "aws_vpc",
  "aws_subnet",
  "aws_lambda_function"
);

/** Generate innocuous HCL lines for context */
const innocuousLineArb = fc.constantFrom(
  '  instance_type = "t3.micro"',
  "  tags = {",
  '    Name = "web-server"',
  "  }",
  "}",
  "",
  "# This is a comment",
  '  bucket = "my-bucket-name"',
  "  region = var.aws_region"
);

/** Generate a balanced parentheses expression */
const balancedExpressionArb = fc.oneof(
  fc.constant("length(var.subnets)"),
  fc.constant("length(var.subnets) > 0 ? 1 : 0"),
  fc.constant("(var.enabled ? 1 : 0)"),
  fc.constant("min(length(var.azs), 3)"),
  fc.constant("max(1, length(var.instances))"),
  fc.constant("(length(var.list) + 1)"),
  fc.constant("var.count"),
  fc.constant("1"),
  fc.constant("0")
);

/** Generate an unbalanced parentheses expression */
const unbalancedExpressionArb = fc.oneof(
  fc.constant("length(var.subnets"),
  fc.constant("length(var.subnets))"),
  fc.constant("(var.enabled ? 1 : 0"),
  fc.constant("min(length(var.azs), 3"),
  fc.constant("((var.count + 1)"),
  fc.constant("length(var.list)))"),
  fc.constant("(((var.x))")
);

/* ------------------------------------------------------------------ */
/*  Property 1: Variable reference validation                          */
/*  **Validates: Requirements 2.1, 2.4**                               */
/* ------------------------------------------------------------------ */

test("Property 1: valid variable references are accepted", () => {
  fc.assert(
    fc.property(
      validIdentifierArb,
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 3 }),
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 3 }),
      (identifier, prefixLines, suffixLines) => {
        const lines = [
          ...prefixLines,
          `  value = var.${identifier}`,
          ...suffixLines,
        ];
        const content = lines.join("\n");

        const result = validateVariableReferences(content);
        assert.equal(
          result.valid,
          true,
          `Should accept valid variable reference 'var.${identifier}', got errors: ${JSON.stringify(result.errors)}`
        );
        assert.equal(result.errors.length, 0);
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 1: invalid variable references are rejected with line number", () => {
  fc.assert(
    fc.property(
      invalidIdentifierArb,
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 5 }),
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 5 }),
      (identifier, prefixLines, suffixLines) => {
        const lines = [
          ...prefixLines,
          `  value = var.${identifier}`,
          ...suffixLines,
        ];
        const content = lines.join("\n");

        const result = validateVariableReferences(content);
        assert.equal(
          result.valid,
          false,
          `Should reject invalid variable reference 'var.${identifier}'`
        );
        assert.ok(result.errors.length > 0, "Should have at least one error");

        const error = result.errors[0];
        assert.equal(
          error.line,
          prefixLines.length + 1,
          "Error line number should match where the invalid reference was placed"
        );
        assert.equal(error.rule, "invalid_var_reference");
        assert.ok(
          error.message.length > 0,
          "Error message should be non-empty"
        );
      }
    ),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 2: Resource name validation                               */
/*  **Validates: Requirements 2.2, 2.4**                               */
/* ------------------------------------------------------------------ */

test("Property 2: valid resource names are accepted", () => {
  fc.assert(
    fc.property(
      resourceTypeArb,
      validResourceNameArb,
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 3 }),
      (resourceType, name, suffixLines) => {
        const lines = [
          `resource "${resourceType}" "${name}" {`,
          '  instance_type = "t3.micro"',
          ...suffixLines,
          "}",
        ];
        const content = lines.join("\n");

        const result = validateResourceNames(content);
        assert.equal(
          result.valid,
          true,
          `Should accept valid resource name '${name}', got errors: ${JSON.stringify(result.errors)}`
        );
        assert.equal(result.errors.length, 0);
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 2: invalid resource names are rejected with line number", () => {
  fc.assert(
    fc.property(
      resourceTypeArb,
      invalidResourceNameArb,
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 5 }),
      (resourceType, name, prefixLines) => {
        const lines = [
          ...prefixLines,
          `resource "${resourceType}" "${name}" {`,
          '  instance_type = "t3.micro"',
          "}",
        ];
        const content = lines.join("\n");

        const result = validateResourceNames(content);
        assert.equal(
          result.valid,
          false,
          `Should reject invalid resource name '${name}'`
        );
        assert.ok(result.errors.length > 0, "Should have at least one error");

        const error = result.errors[0];
        assert.equal(
          error.line,
          prefixLines.length + 1,
          "Error line number should match where the invalid resource was declared"
        );
        assert.equal(error.rule, "invalid_resource_name");
        assert.ok(
          error.message.length > 0,
          "Error message should be non-empty"
        );
      }
    ),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 3: Count expression balanced parentheses                  */
/*  **Validates: Requirements 2.3, 2.4**                               */
/* ------------------------------------------------------------------ */

test("Property 3: balanced count expressions are accepted", () => {
  fc.assert(
    fc.property(
      balancedExpressionArb,
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 3 }),
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 3 }),
      (expression, prefixLines, suffixLines) => {
        const lines = [
          ...prefixLines,
          `  count = ${expression}`,
          ...suffixLines,
        ];
        const content = lines.join("\n");

        const result = validateCountExpressions(content);
        assert.equal(
          result.valid,
          true,
          `Should accept balanced count expression '${expression}', got errors: ${JSON.stringify(result.errors)}`
        );
        assert.equal(result.errors.length, 0);
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 3: unbalanced count expressions are rejected with line number", () => {
  fc.assert(
    fc.property(
      unbalancedExpressionArb,
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 5 }),
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 5 }),
      (expression, prefixLines, suffixLines) => {
        const lines = [
          ...prefixLines,
          `  count = ${expression}`,
          ...suffixLines,
        ];
        const content = lines.join("\n");

        const result = validateCountExpressions(content);
        assert.equal(
          result.valid,
          false,
          `Should reject unbalanced count expression '${expression}'`
        );
        assert.ok(result.errors.length > 0, "Should have at least one error");

        const error = result.errors[0];
        assert.equal(
          error.line,
          prefixLines.length + 1,
          "Error line number should match where the unbalanced expression was placed"
        );
        assert.equal(error.rule, "invalid_count_expression");
        assert.ok(
          error.message.length > 0,
          "Error message should be non-empty"
        );
      }
    ),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 14: Validador de rotación exacto                          */
/*  **Validates: Requirements 5.2**                                    */
/* ------------------------------------------------------------------ */
// Feature: portal-rds-creation-improvement, Property 14: Validador de rotación exacto

/**
 * The four mandatory Bloque_Rotacion attributes with their EXACT expected
 * values, mirroring `validateRdsPasswordRotation` in terraform-validator.ts.
 */
const ROTATION_SPEC = [
  { name: "manage_master_user_password", expected: "true", kind: "bool" },
  { name: "manage_master_user_password_rotation", expected: "true", kind: "bool" },
  { name: "master_user_password_rotate_immediately", expected: "false", kind: "bool" },
  {
    name: "master_user_password_rotation_schedule_expression",
    expected: '"rate(15 days)"',
    kind: "string",
  },
] as const;

/** Innocuous module lines that never collide with the rotation attribute names. */
const rdsInnocuousLineArb = fc.constantFrom(
  '  identifier = "my-db"',
  '  engine     = "postgres"',
  "  multi_az          = var.environment == \"prod\" ? true : false",
  '  instance_class = "db.t3.micro"',
  "  allocated_storage = 20",
  "  # comentario inocuo",
  "  tags = {",
  '    Environment = "prod"',
  "  }"
);

/**
 * Builds an RDS `module` block. For each of the four rotation attributes,
 * `values[i]` is either the raw value string to assign, or `null` to omit the
 * line entirely.
 */
function buildRdsTf(
  values: (string | null)[],
  prefix: string[],
  suffix: string[],
): string {
  const attrLines = ROTATION_SPEC.map((a, i) =>
    values[i] === null ? null : `  ${a.name} = ${values[i]}`,
  ).filter((l): l is string => l !== null);

  return [
    'module "rds" {',
    '  source  = "terraform-aws-modules/rds/aws"',
    '  version = "6.10.0"',
    ...prefix,
    ...attrLines,
    ...suffix,
    "}",
  ].join("\n");
}

/** All four attributes assigned their exact expected values. */
const exactValues = (): string[] => ROTATION_SPEC.map((a) => a.expected);

test("Property 14: a .tf with all four exact rotation attributes is valid", () => {
  fc.assert(
    fc.property(
      fc.array(rdsInnocuousLineArb, { minLength: 0, maxLength: 4 }),
      fc.array(rdsInnocuousLineArb, { minLength: 0, maxLength: 4 }),
      (prefix, suffix) => {
        const content = buildRdsTf(exactValues(), prefix, suffix);

        const result = validateRdsPasswordRotation(content);
        assert.equal(
          result.valid,
          true,
          `Should accept .tf with exact Bloque_Rotacion, got errors: ${JSON.stringify(result.errors)}`,
        );
        assert.equal(result.errors.length, 0);
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 14: omitting any rotation attribute is rejected and lists that attribute", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 3 }),
      fc.array(rdsInnocuousLineArb, { minLength: 0, maxLength: 4 }),
      fc.array(rdsInnocuousLineArb, { minLength: 0, maxLength: 4 }),
      (idx, prefix, suffix) => {
        const values = exactValues();
        values[idx] = null; // omit the chosen attribute line
        const attr = ROTATION_SPEC[idx];
        const content = buildRdsTf(values, prefix, suffix);

        const result = validateRdsPasswordRotation(content);
        assert.equal(
          result.valid,
          false,
          `Should reject .tf missing '${attr.name}'`,
        );
        const missing = result.errors.find(
          (e) => e.rule === "rds_rotation_missing" && e.message.includes(attr.name),
        );
        assert.ok(
          missing,
          `Expected a rds_rotation_missing error mentioning '${attr.name}', got: ${JSON.stringify(result.errors)}`,
        );
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 14: a wrong value for any rotation attribute is rejected and lists that attribute", () => {
  /** A value that differs from the attribute's exact expected value. */
  const wrongValueCaseArb = fc.constantFrom(0, 1, 2, 3).chain((idx) => {
    const spec = ROTATION_SPEC[idx];
    const valueArb =
      spec.kind === "bool"
        ? fc
            .constantFrom("true", "false", "yes", "no", "1", "0", "enabled", "disabled")
            .filter((v) => v !== spec.expected)
        : fc
            .constantFrom(
              '"rate(30 days)"',
              '"rate(7 days)"',
              '"rate(1 days)"',
              '"rate(15 day)"',
              '"cron(0 12 * * ? *)"',
              '"15 days"',
              '""',
            )
            .filter((v) => v !== spec.expected);
    return fc.record({ idx: fc.constant(idx), value: valueArb });
  });

  fc.assert(
    fc.property(
      wrongValueCaseArb,
      fc.array(rdsInnocuousLineArb, { minLength: 0, maxLength: 4 }),
      fc.array(rdsInnocuousLineArb, { minLength: 0, maxLength: 4 }),
      ({ idx, value }, prefix, suffix) => {
        const values = exactValues();
        values[idx] = value; // mutate the chosen attribute to an incorrect value
        const attr = ROTATION_SPEC[idx];
        const content = buildRdsTf(values, prefix, suffix);

        const result = validateRdsPasswordRotation(content);
        assert.equal(
          result.valid,
          false,
          `Should reject .tf where '${attr.name}' = ${value} (expected ${attr.expected})`,
        );
        const invalid = result.errors.find(
          (e) =>
            e.rule === "rds_rotation_invalid_value" && e.message.includes(attr.name),
        );
        assert.ok(
          invalid,
          `Expected a rds_rotation_invalid_value error mentioning '${attr.name}', got: ${JSON.stringify(result.errors)}`,
        );
      },
    ),
    { numRuns: 100 },
  );
});
