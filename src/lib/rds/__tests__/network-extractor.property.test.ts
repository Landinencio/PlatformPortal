// Feature: infra-self-service-hardening, Property: extractNetworkWiring is total and replicates repo wiring
//
// Property-based tests (fast-check) for the pure network wiring extractor
// (`src/lib/rds/network-extractor.ts`, SRE-001). The extractor discovers the
// VPC/subnet/security-group wiring from the target repo's existing RDS modules
// so the generator can replicate it instead of defaulting to the account's
// default VPC.
//
// Properties:
//   (a) Totality — never throws on arbitrary strings / arrays.
//   (b) Round-trip — given synthetic HCL built from a known wiring,
//       extractNetworkWiring recovers exactly that wiring.
//   (c) Majority — when several modules share the same wiring and a minority
//       uses a different one, the majority wiring is returned.
//   (d) Null — returns null when no RDS module has both SG + subnet_ids.

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { extractNetworkWiring, type NetworkWiring } from "../network-extractor";

/** Field-by-field equality (fast-check records have a null prototype, which
 *  trips assert/strict deepEqual's prototype check). */
function assertWiringEqual(actual: NetworkWiring | null, expected: NetworkWiring): void {
  assert.ok(actual !== null, "expected a wiring, got null");
  assert.equal(actual!.vpcIdExpr, expected.vpcIdExpr);
  assert.equal(actual!.subnetIdsExpr, expected.subnetIdsExpr);
  assert.equal(actual!.ingressCidrExpr, expected.ingressCidrExpr);
  assert.equal(actual!.port, expected.port);
}

/* ------------------------------------------------------------------ */
/*  Synthetic HCL builders                                            */
/* ------------------------------------------------------------------ */

/** A Terraform-ish identifier / expression token (never empty). */
const tokenArb: fc.Arbitrary<string> = fc.string({
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_".split("")),
  minLength: 3,
  maxLength: 14,
});

/** A raw RHS expression such as `var.foo` or `concat(var.a, var.b)`. */
const exprArb: fc.Arbitrary<string> = fc.oneof(
  tokenArb.map((t) => `var.${t}`),
  fc
    .tuple(tokenArb, tokenArb)
    .map(([a, b]) => `concat(var.${a}, var.${b})`),
);

/** A distinct db label used for module/SG names. */
const dbNameArb: fc.Arbitrary<string> = tokenArb;

const wiringArb: fc.Arbitrary<NetworkWiring> = fc.record({
  vpcIdExpr: exprArb,
  subnetIdsExpr: exprArb,
  ingressCidrExpr: exprArb,
  port: fc.integer({ min: 1, max: 65535 }),
});

/**
 * Renders a security group + RDS module pair for a given db name and wiring.
 * `withIndex` toggles the `[0]` on the SG reference so both forms are covered.
 */
function renderPair(db: string, w: NetworkWiring, withIndex: boolean): string {
  const sgRef = withIndex
    ? `aws_security_group.${db}[0].id`
    : `aws_security_group.${db}.id`;
  return [
    `resource "aws_security_group" "${db}" {`,
    `  description = "${db} RDS Access"`,
    `  vpc_id      = ${w.vpcIdExpr}`,
    `  ingress {`,
    `    protocol    = "tcp"`,
    `    from_port   = ${w.port}`,
    `    to_port     = ${w.port}`,
    `    cidr_blocks = ${w.ingressCidrExpr}`,
    `  }`,
    `}`,
    ``,
    `module "${db}" {`,
    `  source  = "terraform-aws-modules/rds/aws"`,
    `  version = "6.10.0"`,
    ``,
    `  identifier = "${db}"`,
    `  vpc_security_group_ids = [${sgRef}]`,
    `  subnet_ids             = ${w.subnetIdsExpr}`,
    `}`,
    ``,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/*  (a) Totality                                                       */
/* ------------------------------------------------------------------ */

// Feature: infra-self-service-hardening, Property: extractNetworkWiring is total and replicates repo wiring
test("Property (a): totality — never throws on arbitrary string arrays", () => {
  fc.assert(
    fc.property(fc.array(fc.string(), { maxLength: 12 }), (contents) => {
      assert.doesNotThrow(() => extractNetworkWiring(contents));
      const result = extractNetworkWiring(contents);
      assert.ok(result === null || typeof result === "object");
    }),
    { numRuns: 100 },
  );
});

// Feature: infra-self-service-hardening, Property: extractNetworkWiring is total and replicates repo wiring
test("Property (a'): totality — tolerates non-array / non-string inputs", () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(fc.string(), fc.constant(""), fc.constant("{{{ unbalanced")), {
        maxLength: 8,
      }),
      (contents) => {
        assert.doesNotThrow(() => extractNetworkWiring(contents));
      },
    ),
    { numRuns: 100 },
  );
  // Non-array input is tolerated too (defensive, returns null).
  assert.equal(extractNetworkWiring(undefined as unknown as string[]), null);
  assert.equal(extractNetworkWiring(null as unknown as string[]), null);
});

/* ------------------------------------------------------------------ */
/*  (b) Round-trip                                                     */
/* ------------------------------------------------------------------ */

// Feature: infra-self-service-hardening, Property: extractNetworkWiring is total and replicates repo wiring
test("Property (b): round-trip — recovers exactly the wiring used to build the HCL", () => {
  fc.assert(
    fc.property(
      dbNameArb,
      wiringArb,
      fc.boolean(),
      (db, wiring, withIndex) => {
        const tf = renderPair(db, wiring, withIndex);
        const result = extractNetworkWiring([tf]);
        assertWiringEqual(result, wiring);
      },
    ),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  (c) Majority                                                       */
/* ------------------------------------------------------------------ */

// Feature: infra-self-service-hardening, Property: extractNetworkWiring is total and replicates repo wiring
test("Property (c): majority — the wiring shared by most modules wins over a minority", () => {
  fc.assert(
    fc.property(
      wiringArb,
      wiringArb,
      fc.integer({ min: 2, max: 4 }), // majority copies
      (majority, minority, majorityCount) => {
        // Ensure the two wirings are actually different; otherwise the property
        // is vacuously satisfied (both equal).
        fc.pre(JSON.stringify(majority) !== JSON.stringify(minority));

        const contents: string[] = [];
        for (let i = 0; i < majorityCount; i++) {
          contents.push(renderPair(`maj_${i}`, majority, true));
        }
        // Exactly one minority module (strictly fewer than the majority).
        contents.push(renderPair("min_0", minority, true));

        const result = extractNetworkWiring(contents);
        assertWiringEqual(result, majority);
      },
    ),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  (d) Null                                                           */
/* ------------------------------------------------------------------ */

// Feature: infra-self-service-hardening, Property: extractNetworkWiring is total and replicates repo wiring
test("Property (d): null — returns null when no RDS module has both SG + subnet_ids", () => {
  fc.assert(
    fc.property(dbNameArb, exprArb, (db, subnets) => {
      // An RDS module WITHOUT any network wiring (the incident shape).
      const noWiring = [
        `module "${db}" {`,
        `  source  = "terraform-aws-modules/rds/aws"`,
        `  version = "6.10.0"`,
        `  identifier = "${db}"`,
        `}`,
      ].join("\n");
      assert.equal(extractNetworkWiring([noWiring]), null);

      // An RDS module with subnet_ids but NO vpc_security_group_ids → incomplete.
      const subnetsOnly = [
        `module "${db}" {`,
        `  source  = "terraform-aws-modules/rds/aws"`,
        `  subnet_ids = ${subnets}`,
        `}`,
      ].join("\n");
      assert.equal(extractNetworkWiring([subnetsOnly]), null);

      // A NON-RDS module with full wiring must be ignored (wrong source).
      const wrongSource = [
        `resource "aws_security_group" "${db}" {`,
        `  vpc_id = var.vpc_id`,
        `  ingress { from_port = 5432\n cidr_blocks = var.c }`,
        `}`,
        `module "${db}" {`,
        `  source  = "terraform-aws-modules/s3-bucket/aws"`,
        `  subnet_ids = ${subnets}`,
        `  vpc_security_group_ids = [aws_security_group.${db}[0].id]`,
        `}`,
      ].join("\n");
      assert.equal(extractNetworkWiring([wrongSource]), null);
    }),
    { numRuns: 100 },
  );
});
