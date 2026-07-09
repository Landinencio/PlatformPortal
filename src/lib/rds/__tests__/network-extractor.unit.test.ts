/**
 * Feature: infra-self-service-hardening (SRE-001)
 *
 * Unit tests for `extractNetworkWiring` against the REAL shape of a correct RDS
 * network block, taken from the repo
 * `iskaypetcom/sre-infra/platform-engineering/aws/oms`
 * file `iac/databases/marketplace-payments-api-db.tf` (and the equivalent
 * `core.tf`): a security group with `vpc_id = var.vpc_id`, a `concat(...)`
 * ingress `cidr_blocks`, `from_port = 5432`, and a module wired with
 * `subnet_ids = var.oms_pvt_subnet` + `vpc_security_group_ids = [...[0].id]`.
 *
 * This is the pattern the generator must discover and replicate so a
 * portal-created RDS never lands in the account's default VPC (the
 * `mkp-ur-connector` incident).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { extractNetworkWiring } from "../network-extractor";

const MARKETPLACE_PAYMENTS_API_DB_TF = `
resource "aws_security_group" "marketplace_payments_api_db" {
  count       = contains(["dev", "prod"], var.environment) ? 1 : 0
  description = "Marketplace payments API RDS Access"
  vpc_id      = var.vpc_id
  ingress {
    protocol    = "tcp"
    from_port   = 5432
    to_port     = 5432
    cidr_blocks = concat(var.eks_vpc_private_subnet_cidrs, var.new_vpn_route, var.oms_general_vpc_private_subnet_cidrs, var.environment == "dev" ? var.iskay_vpn_subnet_cidrs : [], var.iskay_office_subnet_cidrs)
  }
}

module "marketplace_payments_api_db_rds_postgres" {
  count      = contains(["dev", "prod"], var.environment) ? 1 : 0
  source     = "terraform-aws-modules/rds/aws"
  version    = "6.6.0"

  identifier = "marketplace-payments-api-db"

  vpc_security_group_ids          = [aws_security_group.marketplace_payments_api_db[0].id]
  storage_encrypted               = true
  create_db_subnet_group          = true
  db_subnet_group_name            = "db_postgres_marketplace_payments_api"
  db_subnet_group_use_name_prefix = false
  subnet_ids                      = var.oms_pvt_subnet
  port                            = 5432

  deletion_protection = var.environment == "prod" ? true : false
  create_cloudwatch_log_group = true
}
`;

test("extractNetworkWiring recovers the marketplace-payments-api-db wiring", () => {
  const result = extractNetworkWiring([MARKETPLACE_PAYMENTS_API_DB_TF]);

  assert.deepEqual(result, {
    vpcIdExpr: "var.vpc_id",
    subnetIdsExpr: "var.oms_pvt_subnet",
    ingressCidrExpr:
      'concat(var.eks_vpc_private_subnet_cidrs, var.new_vpn_route, var.oms_general_vpc_private_subnet_cidrs, var.environment == "dev" ? var.iskay_vpn_subnet_cidrs : [], var.iskay_office_subnet_cidrs)',
    port: 5432,
  });
});

// A second correct RDS (core.tf shape) split across files — the SG lives in one
// file and the module in another. The extractor collects blocks globally.
test("extractNetworkWiring resolves an SG referenced across files", () => {
  const sgFile = `
resource "aws_security_group" "core" {
  description = "Core RDS Access"
  vpc_id      = var.vpc_id
  ingress {
    protocol    = "tcp"
    from_port   = 5432
    to_port     = 5432
    cidr_blocks = var.oms_general_vpc_private_subnet_cidrs
  }
}
`;
  const moduleFile = `
module "core_rds_postgres" {
  source     = "terraform-aws-modules/rds/aws"
  version    = "6.6.0"
  identifier = "core-rds-postgres"

  vpc_security_group_ids = [aws_security_group.core[0].id]
  subnet_ids             = var.oms_pvt_subnet
}
`;

  const result = extractNetworkWiring([sgFile, moduleFile]);
  assert.deepEqual(result, {
    vpcIdExpr: "var.vpc_id",
    subnetIdsExpr: "var.oms_pvt_subnet",
    ingressCidrExpr: "var.oms_general_vpc_private_subnet_cidrs",
    port: 5432,
  });
});

test("extractNetworkWiring returns null for the incident shape (no network block)", () => {
  const incidentTf = `
module "mkp_ur_connector" {
  source  = "terraform-aws-modules/rds/aws"
  version = "6.6.0"
  identifier = "mkp-ur-connector"
  engine  = "postgres"
}
`;
  assert.equal(extractNetworkWiring([incidentTf]), null);
});
