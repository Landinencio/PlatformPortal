/**
 * Property-based tests for Secret Scanner.
 *
 * Feature: infra-robustness
 * Property 14: Secret pattern detection
 * Property 15: Secret log does not leak values
 *
 * **Validates: Requirements 10.2, 10.4**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { scanForSecrets } from "../secret-scanner";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Generate a valid AWS Access Key ID (AKIA + 16 uppercase alphanumeric chars) */
const awsAccessKeyArb = fc
  .array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")), {
    minLength: 16,
    maxLength: 16,
  })
  .map((chars) => `AKIA${chars.join("")}`);

/** Generate a valid AWS Secret Key (40 base64 chars after = or :) */
const awsSecretKeyValueArb = fc
  .array(
    fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("")),
    { minLength: 40, maxLength: 40 }
  )
  .map((chars) => chars.join(""));

const awsSecretKeyLineArb = fc
  .tuple(
    fc.constantFrom("aws_secret_access_key", "secret_key", "secret"),
    fc.constantFrom(" = ", ": ", "=", ":"),
    awsSecretKeyValueArb
  )
  .map(([prefix, sep, value]) => `${prefix}${sep}"${value}"`);

/** Generate a hardcoded password assignment (not a variable reference) */
const hardcodedPasswordArb = fc
  .tuple(
    fc.constantFrom("password", "  password", "    password"),
    fc
      .array(
        fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*".split("")),
        { minLength: 4, maxLength: 30 }
      )
      .map((chars) => chars.join(""))
  )
  .map(([prefix, pwd]) => `${prefix} = "${pwd}"`);

/** Generate a bearer token */
const bearerTokenValueArb = fc
  .array(
    fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~+/".split("")),
    { minLength: 10, maxLength: 60 }
  )
  .map((chars) => chars.join("") + "=");

const bearerTokenLineArb = bearerTokenValueArb.map(
  (token) => `Authorization: Bearer ${token}`
);

/** Generate a Terraform variable reference for password (false positive) */
const falsePositivePasswordArb = fc.constantFrom(
  'password = "var.db_password"',
  "password = var.db_password",
  'password = "random_password.main.result"',
  "password = random_password.main.result",
  'password = "var.master_password"',
  "password = var.master_password",
  'password = "random_password.rds.result"',
  "password = random_password.rds.result"
);

/** Generate innocuous Terraform content (no secrets) */
const innocuousLineArb = fc.constantFrom(
  'resource "aws_instance" "web" {',
  "  ami           = var.ami_id",
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

/* ------------------------------------------------------------------ */
/*  Property 14: Secret pattern detection                              */
/*  **Validates: Requirements 10.2**                                   */
/* ------------------------------------------------------------------ */

test("Property 14: AWS access key IDs are detected", () => {
  fc.assert(
    fc.property(
      awsAccessKeyArb,
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 5 }),
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 5 }),
      (accessKey, prefixLines, suffixLines) => {
        const lines = [
          ...prefixLines,
          `aws_access_key_id = "${accessKey}"`,
          ...suffixLines,
        ];
        const content = lines.join("\n");

        const result = scanForSecrets(content);
        assert.equal(result.clean, false, "Should detect AWS access key");

        const finding = result.findings.find(
          (f) => f.patternType === "aws_access_key"
        );
        assert.ok(finding, "Should have a finding with patternType 'aws_access_key'");
        assert.equal(
          finding.line,
          prefixLines.length + 1,
          "Line number should match where the key was placed"
        );
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 14: AWS secret keys are detected", () => {
  fc.assert(
    fc.property(
      awsSecretKeyLineArb,
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 5 }),
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 5 }),
      (secretKeyLine, prefixLines, suffixLines) => {
        const lines = [
          ...prefixLines,
          secretKeyLine,
          ...suffixLines,
        ];
        const content = lines.join("\n");

        const result = scanForSecrets(content);
        assert.equal(result.clean, false, "Should detect AWS secret key");

        const finding = result.findings.find(
          (f) => f.patternType === "aws_secret_key"
        );
        assert.ok(finding, "Should have a finding with patternType 'aws_secret_key'");
        assert.equal(
          finding.line,
          prefixLines.length + 1,
          "Line number should match where the secret was placed"
        );
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 14: hardcoded password assignments are detected", () => {
  fc.assert(
    fc.property(
      hardcodedPasswordArb,
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 5 }),
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 5 }),
      (passwordLine, prefixLines, suffixLines) => {
        const lines = [
          ...prefixLines,
          passwordLine,
          ...suffixLines,
        ];
        const content = lines.join("\n");

        const result = scanForSecrets(content);
        assert.equal(result.clean, false, "Should detect hardcoded password");

        const finding = result.findings.find(
          (f) => f.patternType === "password"
        );
        assert.ok(finding, "Should have a finding with patternType 'password'");
        assert.equal(
          finding.line,
          prefixLines.length + 1,
          "Line number should match where the password was placed"
        );
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 14: bearer tokens are detected", () => {
  fc.assert(
    fc.property(
      bearerTokenLineArb,
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 5 }),
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 5 }),
      (tokenLine, prefixLines, suffixLines) => {
        const lines = [
          ...prefixLines,
          tokenLine,
          ...suffixLines,
        ];
        const content = lines.join("\n");

        const result = scanForSecrets(content);
        assert.equal(result.clean, false, "Should detect bearer token");

        const finding = result.findings.find(
          (f) => f.patternType === "bearer_token"
        );
        assert.ok(finding, "Should have a finding with patternType 'bearer_token'");
        assert.equal(
          finding.line,
          prefixLines.length + 1,
          "Line number should match where the token was placed"
        );
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 14: Terraform variable references are NOT detected (false positive exclusion)", () => {
  fc.assert(
    fc.property(
      falsePositivePasswordArb,
      fc.array(innocuousLineArb, { minLength: 0, maxLength: 5 }),
      (fpLine, surroundingLines) => {
        const content = [...surroundingLines, fpLine].join("\n");

        const result = scanForSecrets(content);
        const passwordFindings = result.findings.filter(
          (f) => f.patternType === "password"
        );
        assert.equal(
          passwordFindings.length,
          0,
          `Should not flag Terraform variable reference as password: "${fpLine}"`
        );
      }
    ),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 15: Secret log does not leak values                       */
/*  **Validates: Requirements 10.4**                                   */
/* ------------------------------------------------------------------ */

test("Property 15: findings never contain actual secret values (AWS access key)", () => {
  fc.assert(
    fc.property(awsAccessKeyArb, (accessKey) => {
      const content = `aws_access_key_id = "${accessKey}"`;
      const result = scanForSecrets(content);

      assert.equal(result.clean, false);
      for (const finding of result.findings) {
        const findingStr = JSON.stringify(finding);
        assert.ok(
          !findingStr.includes(accessKey),
          "Finding should not contain the actual access key value"
        );
        // Verify finding only has patternType and line
        assert.deepEqual(
          Object.keys(finding).sort(),
          ["line", "patternType"],
          "Finding should only have patternType and line fields"
        );
      }
    }),
    { numRuns: 100 }
  );
});

test("Property 15: findings never contain actual secret values (AWS secret key)", () => {
  fc.assert(
    fc.property(awsSecretKeyValueArb, (secretValue) => {
      const content = `aws_secret_access_key = "${secretValue}"`;
      const result = scanForSecrets(content);

      assert.equal(result.clean, false);
      for (const finding of result.findings) {
        const findingStr = JSON.stringify(finding);
        assert.ok(
          !findingStr.includes(secretValue),
          "Finding should not contain the actual secret key value"
        );
        assert.deepEqual(
          Object.keys(finding).sort(),
          ["line", "patternType"],
          "Finding should only have patternType and line fields"
        );
      }
    }),
    { numRuns: 100 }
  );
});

test("Property 15: findings never contain actual secret values (password)", () => {
  fc.assert(
    fc.property(
      fc
        .array(
          fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*".split("")),
          { minLength: 4, maxLength: 30 }
        )
        .map((chars) => chars.join("")),
      (password) => {
        const content = `password = "${password}"`;
        const result = scanForSecrets(content);

        assert.equal(result.clean, false);
        for (const finding of result.findings) {
          const findingStr = JSON.stringify(finding);
          assert.ok(
            !findingStr.includes(password),
            "Finding should not contain the actual password value"
          );
          assert.deepEqual(
            Object.keys(finding).sort(),
            ["line", "patternType"],
            "Finding should only have patternType and line fields"
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 15: findings never contain actual secret values (bearer token)", () => {
  fc.assert(
    fc.property(bearerTokenValueArb, (tokenValue) => {
      const content = `Authorization: Bearer ${tokenValue}`;
      const result = scanForSecrets(content);

      assert.equal(result.clean, false);
      for (const finding of result.findings) {
        const findingStr = JSON.stringify(finding);
        assert.ok(
          !findingStr.includes(tokenValue),
          "Finding should not contain the actual bearer token value"
        );
        assert.deepEqual(
          Object.keys(finding).sort(),
          ["line", "patternType"],
          "Finding should only have patternType and line fields"
        );
      }
    }),
    { numRuns: 100 }
  );
});
