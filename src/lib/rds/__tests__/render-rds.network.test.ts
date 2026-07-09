/**
 * Feature: infra-self-service-hardening (SRE-001)
 *
 * The deterministic render MUST emit the network block discovered from the
 * target repo (security group + `vpc_security_group_ids` + `subnet_ids` +
 * `create_db_subnet_group`) so a portal-created RDS never lands in the
 * account's default VPC (the `mkp-ur-connector` incident). This block is
 * emitted UNCONDITIONALLY (not flag-gated) because a DB in the default VPC is
 * a defect, not a baseline to preserve.
 *
 * The render must keep passing the existing pre-emit guards:
 *   - the anti-literal guard `findLiteralRdsAttribute` (the five parameterized
 *     attributes stay `var.<db>_...` references), and
 *   - the tfvars completeness guard `findTfvarsGap`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { renderRds, tfId } from "../render-rds";
import { findLiteralRdsAttribute, findTfvarsGap } from "../rds-generator";
import type { NetworkWiring } from "../network-extractor";
import type { RdsFields } from "../../infra-prompt-builder";

const NETWORK: NetworkWiring = {
  vpcIdExpr: "var.vpc_id",
  subnetIdsExpr: "var.oms_pvt_subnet",
  ingressCidrExpr:
    "concat(var.eks_vpc_private_subnet_cidrs, var.oms_general_vpc_private_subnet_cidrs)",
  port: 5432,
};

function buildFields(identifier = "mkp-ur-connector"): RdsFields {
  return {
    identifier,
    dbName: tfId(identifier),
    instanceClass: "db.t4g.micro",
    storageGb: 20,
    multiAz: false,
    engine: "postgres",
    engineVersion: "18",
    family: "postgres18",
  };
}

test("renderRds emits the discovered network block (SG + subnet/sg wiring)", () => {
  const fields = buildFields();
  const db = tfId(fields.identifier);
  const { tf, vars } = renderRds(
    fields,
    "postgres18",
    "6.6.0",
    ["dev", "prod"],
    new Set(),
    NETWORK,
  );

  // Security group resource emitted BEFORE the module, with the discovered vpc.
  assert.match(tf, new RegExp(`resource "aws_security_group" "${db}" \\{`));
  assert.match(tf, /vpc_id\s+=\s+var\.vpc_id/);
  assert.match(tf, /from_port\s+=\s+5432/);
  assert.match(tf, /to_port\s+=\s+5432/);
  assert.match(
    tf,
    /cidr_blocks\s+=\s+concat\(var\.eks_vpc_private_subnet_cidrs, var\.oms_general_vpc_private_subnet_cidrs\)/,
  );
  const sgIdx = tf.indexOf('resource "aws_security_group"');
  const moduleIdx = tf.indexOf(`module "${db}" {`);
  assert.ok(sgIdx >= 0 && moduleIdx > sgIdx, "SG must be emitted before the module");

  // Module network attributes referencing the SG + discovered subnets.
  assert.match(
    tf,
    new RegExp(`vpc_security_group_ids\\s+=\\s+\\[aws_security_group\\.${db}\\[0\\]\\.id\\]`),
  );
  assert.match(tf, /storage_encrypted\s+=\s+true/);
  assert.match(tf, /create_db_subnet_group\s+=\s+true/);
  assert.match(tf, new RegExp(`db_subnet_group_name\\s+=\\s+"db_postgres_${db}"`));
  assert.match(tf, /db_subnet_group_use_name_prefix\s+=\s+false/);
  assert.match(tf, /subnet_ids\s+=\s+var\.oms_pvt_subnet/);
  assert.match(tf, /^\s*port\s+=\s+5432$/m);
  assert.match(tf, /create_cloudwatch_log_group\s+=\s+true/);
  assert.match(tf, /deletion_protection\s+=\s+var\.environment == "prod" \? true : false/);
  assert.match(tf, /backup_retention_period\s+=\s+30/);
  assert.match(tf, /skip_final_snapshot\s+=\s+var\.environment == "prod" \? true : false/);

  // The anti-literal guard still passes (five attributes are var refs).
  assert.equal(findLiteralRdsAttribute(tf), null);

  // The tfvars completeness guard still passes (5×3 coverage intact).
  assert.equal(findTfvarsGap(vars), null);

  // Rotation block preserved.
  assert.match(tf, /manage_master_user_password\s+=\s+true/);
});

test("SG count mirrors the module count; no [0] index when all three envs are selected", () => {
  const fields = buildFields("orders-db");
  const db = tfId(fields.identifier);

  // Subset of envs → both SG and module carry the same count expression.
  const subset = renderRds(fields, "postgres18", "6.6.0", ["dev", "uat"], new Set(), NETWORK);
  const countLines = subset.tf
    .split("\n")
    .filter((l) => /count\s+=\s+contains\(\["dev", "uat"\], var\.environment\) \? 1 : 0/.test(l));
  assert.equal(countLines.length, 2, "SG and module must each carry the count expression");
  assert.match(
    subset.tf,
    new RegExp(`vpc_security_group_ids\\s+=\\s+\\[aws_security_group\\.${db}\\[0\\]\\.id\\]`),
  );

  // All three envs → no count anywhere, and the SG ref carries no [0] index.
  const all = renderRds(fields, "postgres18", "6.6.0", ["dev", "uat", "prod"], new Set(), NETWORK);
  assert.ok(!/^\s*count\s+=/m.test(all.tf), "no count when all three envs are selected");
  assert.match(
    all.tf,
    new RegExp(`vpc_security_group_ids\\s+=\\s+\\[aws_security_group\\.${db}\\.id\\]`),
  );
  assert.ok(
    !new RegExp(`aws_security_group\\.${db}\\[0\\]`).test(all.tf),
    "no [0] index when the SG has no count",
  );
});
