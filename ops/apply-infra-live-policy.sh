#!/usr/bin/env bash
# Attach the infra-live-detector read-only inline policy to n8n-cost-reader-role
# in every squad AWS account. Idempotent: put-role-policy overwrites.
set -uo pipefail

ROLE="n8n-cost-reader-role"
POLICY_NAME="InfraLiveDetectorReadOnly"
POLICY_DOC='{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InfraLiveDetectorReadOnly",
      "Effect": "Allow",
      "Action": [
        "sqs:GetQueueUrl",
        "sqs:GetQueueAttributes",
        "sns:ListTopics",
        "dynamodb:DescribeTable",
        "rds:DescribeDBInstances",
        "secretsmanager:ListSecrets",
        "secretsmanager:DescribeSecret",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "events:ListRules",
        "events:DescribeRule"
      ],
      "Resource": "*"
    }
  ]
}'

PROFILES=(
  clinicanimal
  data-dev
  digital-dev digital-uat digital-prod
  digital-ecommerce
  ecommerce-tiendanimal
  eks-dev eks-uat eks-prd eks-tooling
  helios-dev helios-uat helios-prod
  infra
  iskaypet-data
  iskaypet-ecommerce
  log
  pruebas
  retail-dev retail-uat retail-prod
  sap
  sistemas-tiendanimal
  sandbox-backoffice sandbox-data sandbox-digital sandbox-retail
  root-iskaypet
)

for p in "${PROFILES[@]}"; do
  acct=$(aws sts get-caller-identity --profile "$p" --query Account --output text 2>/dev/null)
  if [ -z "$acct" ]; then
    echo "[$p] SKIP — no valid session"
    continue
  fi
  if ! aws iam get-role --role-name "$ROLE" --profile "$p" >/dev/null 2>&1; then
    echo "[$p / $acct] SKIP — role $ROLE not found"
    continue
  fi
  if aws iam put-role-policy \
      --role-name "$ROLE" \
      --policy-name "$POLICY_NAME" \
      --policy-document "$POLICY_DOC" \
      --profile "$p" >/dev/null 2>&1; then
    echo "[$p / $acct] OK — policy $POLICY_NAME applied to $ROLE"
  else
    echo "[$p / $acct] FAILED to apply policy"
  fi
done
