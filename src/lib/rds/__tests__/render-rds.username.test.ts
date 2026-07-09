/**
 * Feature: infra-self-service-hardening — hotfix incidente 2026-07-07
 *
 * El módulo upstream `terraform-aws-modules/rds/aws@6.6.0` requiere `username`
 * en `aws_db_instance` incluso cuando `manage_master_user_password = true`.
 * El generador determinista lo omitía → `terraform apply` fallaba en dev con
 * `"username": required field is not set` (repo `oms`, MR !357).
 *
 * Este test fija la convención `<db_name minus trailing "db">adm` observada en
 * el resto de RDS del repo `oms` (`subscriptions-api.tf`, `core.tf`,
 * `marketplace.tf`, `loyalty.tf`) y garantiza que el output del `renderRds`
 * emite la línea `username = "..."` para no volver a caer en el mismo fallo.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildMasterUsername, renderRds } from "../render-rds";
import type { RdsFields } from "../../infra-prompt-builder";

test("buildMasterUsername follows the digital-squad naming convention", () => {
  const cases: Array<[string, string]> = [
    // Real db_names observed in iskaypetcom/…/oms/iac/databases/*.tf
    ["coredb", "coreadm"],
    ["marketplacedb", "marketplaceadm"],
    ["loyaltydb", "loyaltyadm"],
    ["storesinterlocutordb", "storesinterlocutoradm"],
    ["subssapi", "subssapiadm"],
    // Portal-generated db_names (no trailing "db"): keep the whole base + "adm".
    ["mkp_ur_connector", "mkpurconnectoradm"],
    // Non-alphanumeric characters (hyphens, underscores) are stripped.
    ["oms-events-db", "omseventsadm"],
    // Case-insensitive input.
    ["Marketplace-DB", "marketplaceadm"],
  ];

  for (const [input, expected] of cases) {
    assert.equal(
      buildMasterUsername(input),
      expected,
      `buildMasterUsername(${JSON.stringify(input)}) should be ${JSON.stringify(expected)}`,
    );
  }
});

test("renderRds emits `username` in the aws_db_instance block", () => {
  // Regression guard: the incident of 2026-07-07 was caused by the generator
  // not emitting `username`, so `terraform apply` failed in dev with
  // `"username": required field is not set`.
  const fields: RdsFields = {
    identifier: "mkp-ur-connector",
    dbName: "mkp_ur_connector",
    instanceClass: "db.t4g.micro",
    storageGb: 20,
    multiAz: false,
    engine: "postgres",
    engineVersion: "18",
    family: "postgres18",
  };

  const network = {
    vpcIdExpr: "var.vpc_id",
    subnetIdsExpr: "var.oms_pvt_subnet",
    ingressCidrExpr: "var.eks_vpc_private_subnet_cidrs",
    port: 5432,
  };
  const result = renderRds(fields, "postgres18", "6.6.0", ["dev", "prod"], new Set(), network);

  assert.match(
    result.tf,
    /^\s*username\s+=\s+"mkpurconnectoradm"$/m,
    "renderRds output must contain a `username` line for the master user",
  );

  // The username line must sit right after `db_name` in the module body — this
  // matches the ordering used by every hand-written RDS in the digital `oms`
  // repo and keeps the generated HCL diff-friendly.
  const dbNameIdx = result.tf.indexOf('db_name           = "mkp_ur_connector"');
  const usernameIdx = result.tf.indexOf('username          = "mkpurconnectoradm"');
  assert.ok(dbNameIdx >= 0, "db_name line must exist");
  assert.ok(usernameIdx > dbNameIdx, "username must be emitted immediately after db_name");
});
