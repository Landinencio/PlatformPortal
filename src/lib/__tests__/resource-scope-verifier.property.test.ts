/**
 * Property-based tests for Resource Scope Verifier.
 *
 * Feature: infra-robustness
 * Property 4: Resource block extraction
 * Property 5: Scope verification rejects non-target changes
 *
 * **Validates: Requirements 3.2, 3.3**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  extractResourceBlocks,
  verifyModifyScope,
} from "../resource-scope-verifier";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Generate a valid Terraform resource type */
const resourceTypeArb = fc.constantFrom(
  "aws_instance",
  "aws_s3_bucket",
  "aws_rds_instance",
  "aws_iam_role",
  "aws_security_group",
  "aws_vpc",
  "aws_subnet",
  "aws_lambda_function",
  "aws_db_subnet_group",
  "aws_iam_policy_attachment",
  "aws_route53_record",
  "aws_cloudwatch_alarm"
);

/** Generate a valid resource name (alphanumeric + underscores, starts with letter) */
const resourceNameArb = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
    fc.array(
      fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_".split("")),
      { minLength: 1, maxLength: 15 }
    )
  )
  .map(([first, rest]) => first + rest.join(""));

/** Generate a simple HCL block body (non-nested braces for simplicity) */
const blockBodyArb = fc
  .array(
    fc.constantFrom(
      '  instance_type = "t3.micro"',
      '  name = "example"',
      "  count = 1",
      '  engine = "postgres"',
      "  allocated_storage = 20",
      "  multi_az = true",
      '  bucket = "my-bucket"',
      "  tags = {}",
      '  cidr_block = "10.0.0.0/16"',
      '  ami = "ami-12345678"'
    ),
    { minLength: 1, maxLength: 4 }
  )
  .map((lines) => lines.join("\n"));

/** Generate a resource block as a string */
const resourceBlockArb = fc
  .tuple(resourceTypeArb, resourceNameArb, blockBodyArb)
  .map(
    ([type, name, body]) => `resource "${type}" "${name}" {\n${body}\n}`
  );

/** Generate a module block as a string */
const moduleBlockArb = fc
  .tuple(resourceNameArb, blockBodyArb)
  .map(([name, body]) => `module "${name}" {\n${body}\n}`);

/** Generate either a resource or module block */
const anyBlockArb = fc.oneof(
  { weight: 4, arbitrary: resourceBlockArb },
  { weight: 1, arbitrary: moduleBlockArb }
);

/** Generate HCL content with N blocks separated by blank lines */
const hclContentArb = (minBlocks: number, maxBlocks: number) =>
  fc
    .array(anyBlockArb, { minLength: minBlocks, maxLength: maxBlocks })
    .map((blocks) => blocks.join("\n\n"));

/** Generate a unique set of resource blocks (unique type.name combinations) */
const uniqueResourceBlocksArb = fc
  .array(
    fc.tuple(resourceTypeArb, resourceNameArb, blockBodyArb),
    { minLength: 1, maxLength: 6 }
  )
  .map((tuples) => {
    // Deduplicate by type.name
    const seen = new Set<string>();
    const unique: Array<[string, string, string]> = [];
    for (const [type, name, body] of tuples) {
      const key = type + "." + name;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push([type, name, body]);
      }
    }
    return unique;
  })
  .filter((arr) => arr.length >= 1);

/** Generate unique module blocks */
const uniqueModuleBlocksArb = fc
  .array(
    fc.tuple(resourceNameArb, blockBodyArb),
    { minLength: 0, maxLength: 3 }
  )
  .map((tuples) => {
    const seen = new Set<string>();
    const unique: Array<[string, string]> = [];
    for (const [name, body] of tuples) {
      if (!seen.has(name)) {
        seen.add(name);
        unique.push([name, body]);
      }
    }
    return unique;
  });

/* ------------------------------------------------------------------ */
/*  Property 4: Resource block extraction                              */
/*  **Validates: Requirements 3.2**                                    */
/* ------------------------------------------------------------------ */

test("Property 4: extractResourceBlocks returns exactly N entries for N resource/module blocks", () => {
  fc.assert(
    fc.property(
      uniqueResourceBlocksArb,
      uniqueModuleBlocksArb,
      (resources, modules) => {
        // Build HCL content from unique resources and modules
        // Ensure module names don't collide with resource names in the "module.X" namespace
        const resourceBlocks = resources.map(
          ([type, name, body]) => `resource "${type}" "${name}" {\n${body}\n}`
        );
        const moduleBlocks = modules
          .filter(([name]) => !resources.some(([, rName]) => rName === name))
          .map(([name, body]) => `module "${name}" {\n${body}\n}`);

        const content = [...resourceBlocks, ...moduleBlocks].join("\n\n");
        const expectedCount = resourceBlocks.length + moduleBlocks.length;

        const result = extractResourceBlocks(content);

        // Should return exactly N entries
        assert.equal(
          result.size,
          expectedCount,
          `Expected ${expectedCount} blocks, got ${result.size}. Content:\n${content}\nKeys: ${[...result.keys()].join(", ")}`
        );

        // Verify resource block names match "type.name" pattern
        for (const [type, name] of resources) {
          const key = `${type}.${name}`;
          assert.ok(
            result.has(key),
            `Expected block "${key}" to be in result. Got keys: ${[...result.keys()].join(", ")}`
          );
        }

        // Verify module block names match "module.name" pattern
        for (const [name] of moduleBlocks.map((_, i) => modules.filter(([n]) => !resources.some(([, rName]) => rName === n))[i]).filter(Boolean)) {
          const key = `module.${name}`;
          assert.ok(
            result.has(key),
            `Expected module block "${key}" to be in result. Got keys: ${[...result.keys()].join(", ")}`
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 4: extractResourceBlocks returns correct block names matching type.name pattern", () => {
  fc.assert(
    fc.property(
      uniqueResourceBlocksArb,
      (resources) => {
        const content = resources
          .map(([type, name, body]) => `resource "${type}" "${name}" {\n${body}\n}`)
          .join("\n\n");

        const result = extractResourceBlocks(content);

        // Every key should match the pattern "type.name"
        for (const key of result.keys()) {
          const dotIndex = key.indexOf(".");
          assert.ok(
            dotIndex > 0,
            `Block name "${key}" should contain a dot separating type and name`
          );
          const typePart = key.substring(0, dotIndex);
          const namePart = key.substring(dotIndex + 1);
          assert.ok(
            typePart.length > 0,
            `Type part of "${key}" should be non-empty`
          );
          assert.ok(
            namePart.length > 0,
            `Name part of "${key}" should be non-empty`
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 5: Scope verification rejects non-target changes          */
/*  **Validates: Requirements 3.3**                                    */
/* ------------------------------------------------------------------ */

test("Property 5: scope verifier rejects when a non-target resource body is changed", () => {
  fc.assert(
    fc.property(
      resourceTypeArb,
      resourceNameArb,
      resourceTypeArb,
      resourceNameArb,
      blockBodyArb,
      blockBodyArb,
      blockBodyArb,
      (targetType, targetName, otherType, otherName, targetBody, otherBody, modifiedOtherBody) => {
        // Ensure the other resource name does NOT start with the target name
        // to guarantee it's truly unrelated
        fc.pre(!otherName.startsWith(targetName));
        fc.pre(otherName !== targetName);
        fc.pre(otherBody !== modifiedOtherBody);

        const original = [
          `resource "${targetType}" "${targetName}" {\n${targetBody}\n}`,
          `resource "${otherType}" "${otherName}" {\n${otherBody}\n}`,
        ].join("\n\n");

        // Modified: change the OTHER resource's body (not the target)
        const modified = [
          `resource "${targetType}" "${targetName}" {\n${targetBody}\n}`,
          `resource "${otherType}" "${otherName}" {\n${modifiedOtherBody}\n}`,
        ].join("\n\n");

        const result = verifyModifyScope(original, modified, targetName);

        assert.equal(
          result.valid,
          false,
          `Should reject change to non-target resource "${otherType}.${otherName}" when target is "${targetName}"`
        );
        assert.ok(
          result.unexpectedChanges.length > 0,
          "Should report at least one unexpected change"
        );
        assert.ok(
          result.unexpectedChanges.includes(`${otherType}.${otherName}`),
          `Unexpected changes should include "${otherType}.${otherName}", got: ${result.unexpectedChanges.join(", ")}`
        );
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 5: scope verifier rejects when a non-target resource is added", () => {
  fc.assert(
    fc.property(
      resourceTypeArb,
      resourceNameArb,
      resourceTypeArb,
      resourceNameArb,
      blockBodyArb,
      blockBodyArb,
      (targetType, targetName, addedType, addedName, targetBody, addedBody) => {
        // Ensure the added resource name does NOT start with the target name
        fc.pre(!addedName.startsWith(targetName));
        fc.pre(addedName !== targetName);

        const original = `resource "${targetType}" "${targetName}" {\n${targetBody}\n}`;

        // Modified: add a new unrelated resource
        const modified = [
          `resource "${targetType}" "${targetName}" {\n${targetBody}\n}`,
          `resource "${addedType}" "${addedName}" {\n${addedBody}\n}`,
        ].join("\n\n");

        const result = verifyModifyScope(original, modified, targetName);

        assert.equal(
          result.valid,
          false,
          `Should reject addition of non-target resource "${addedType}.${addedName}" when target is "${targetName}"`
        );
        assert.ok(
          result.unexpectedChanges.includes(`${addedType}.${addedName}`),
          `Unexpected changes should include "${addedType}.${addedName}"`
        );
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 5: scope verifier rejects when a non-target resource is removed", () => {
  fc.assert(
    fc.property(
      resourceTypeArb,
      resourceNameArb,
      resourceTypeArb,
      resourceNameArb,
      blockBodyArb,
      blockBodyArb,
      (targetType, targetName, removedType, removedName, targetBody, removedBody) => {
        // Ensure the removed resource name does NOT start with the target name
        fc.pre(!removedName.startsWith(targetName));
        fc.pre(removedName !== targetName);

        const original = [
          `resource "${targetType}" "${targetName}" {\n${targetBody}\n}`,
          `resource "${removedType}" "${removedName}" {\n${removedBody}\n}`,
        ].join("\n\n");

        // Modified: remove the unrelated resource
        const modified = `resource "${targetType}" "${targetName}" {\n${targetBody}\n}`;

        const result = verifyModifyScope(original, modified, targetName);

        assert.equal(
          result.valid,
          false,
          `Should reject removal of non-target resource "${removedType}.${removedName}" when target is "${targetName}"`
        );
        assert.ok(
          result.unexpectedChanges.includes(`${removedType}.${removedName}`),
          `Unexpected changes should include "${removedType}.${removedName}"`
        );
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 5: scope verifier allows changes to target and related resources (name prefix match)", () => {
  fc.assert(
    fc.property(
      resourceTypeArb,
      resourceNameArb,
      blockBodyArb,
      blockBodyArb,
      blockBodyArb,
      blockBodyArb,
      fc.constantFrom("_subnet_group", "_security_group", "_policy_attachment", "_backup"),
      (targetType, targetName, targetBody, modifiedTargetBody, relatedBody, modifiedRelatedBody, suffix) => {
        fc.pre(targetBody !== modifiedTargetBody);
        fc.pre(relatedBody !== modifiedRelatedBody);

        const relatedName = targetName + suffix;

        const original = [
          `resource "${targetType}" "${targetName}" {\n${targetBody}\n}`,
          `resource "aws_db_subnet_group" "${relatedName}" {\n${relatedBody}\n}`,
        ].join("\n\n");

        // Modified: change both target and related resource
        const modified = [
          `resource "${targetType}" "${targetName}" {\n${modifiedTargetBody}\n}`,
          `resource "aws_db_subnet_group" "${relatedName}" {\n${modifiedRelatedBody}\n}`,
        ].join("\n\n");

        const result = verifyModifyScope(original, modified, targetName);

        assert.equal(
          result.valid,
          true,
          `Should allow changes to target "${targetName}" and related "${relatedName}", but got unexpected: ${result.unexpectedChanges.join(", ")}`
        );
        assert.equal(result.unexpectedChanges.length, 0);
      }
    ),
    { numRuns: 100 }
  );
});
