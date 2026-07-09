########################################################################
# PortalRdsCatalogReadOnly — task 1.2 de infra-self-service-hardening
#
# Repo destino:  iskaypetcom/sre-infra/platform-engineering/aws/shared-general
# Fichero:       iac/services/roles.tf
# Patrón:        PortalExplorerS3Access (steering §22) — recurso inline
#                aws_iam_role_policy sobre aws_iam_role.portal_inventory_irsa
# Requirements:  1.10, 8.1, 8.2, 8.6 (spec infra-self-service-hardening)
#
# Justificación del wildcard en Resource (Req 8.2):
#   La API rds:DescribeDBEngineVersions NO soporta ARN-scoping (AWS IAM
#   Service Authorization Reference). El Action NO es wildcard y NO es
#   verbo de escritura (Create/Modify/Delete/Put/Update/Restore).
#
# Sin cambio de trust policy: portal-sa (n8n / platformportal) ya lo tiene.
########################################################################

resource "aws_iam_role_policy" "portal_rds_catalog_read_only" {
  name = "PortalRdsCatalogReadOnly"
  role = aws_iam_role.portal_inventory_irsa.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "RdsEngineDescribe"
      Effect   = "Allow"
      Action   = "rds:DescribeDBEngineVersions"
      Resource = "*"
    }]
  })
}
