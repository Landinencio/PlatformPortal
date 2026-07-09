#!/usr/bin/env bash
# Roll out the AWS Health fan-in EventBridge rule to every org account.
#
# In each account this script ensures (idempotent — create-or-update):
#   1. IAM role  portal-aws-health-putevents   (trusted by events.amazonaws.com)
#        + inline policy allowing events:PutEvents on the dp-tooling central bus.
#   2. Rule      portal-aws-health-forward      on the `default` event bus,
#        pattern {"source":["aws.health"]}, target = dp-tooling central bus ARN,
#        using the role above for the cross-account PutEvents.
#
# The central hub (queue + bus + bus rule + IRSA reader policy) must already exist
# in dp-tooling — run ops/setup-aws-health-hub.sh first.
#
# Same pattern as ops/apply-infra-live-policy.sh: iterate AWS profiles, skip any
# profile without a valid SSO session (logged), every AWS call is idempotent.
set -uo pipefail

# Central bus in dp-tooling that every account forwards to.
HUB_ACCOUNT="444455556666"
HUB_REGION="eu-west-1"
HUB_BUS_ARN="arn:aws:events:${HUB_REGION}:${HUB_ACCOUNT}:event-bus/portal-aws-health"

ROLE_NAME="portal-aws-health-putevents"
ROLE_POLICY_NAME="PutEventsToPortalHealthBus"
RULE_NAME="portal-aws-health-forward"

# Trust policy: EventBridge assumes this role to deliver cross-account.
TRUST_DOC='{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "events.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}'

# Permissions: only PutEvents, only to the central bus.
ROLE_POLICY_DOC=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PutEventsToPortalHealthBus",
      "Effect": "Allow",
      "Action": "events:PutEvents",
      "Resource": "${HUB_BUS_ARN}"
    }
  ]
}
JSON
)

# The 22 org accounts where the portal operates (same set where n8n-cost-reader-role
# exists, per steering portal-architecture.md §7). Excludes log, pruebas, the 4
# sandbox-* accounts and root-iskaypet (no portal footprint there). Each account
# forwards its aws.health events to the dp-tooling central bus.
ALL_PROFILES=(
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
  retail-dev retail-uat retail-prod
  sap
  sistemas-tiendanimal
)

# Optional staged rollout: `AWS_HEALTH_PROFILES="digital-dev eks-dev" ./apply-aws-health-eventbridge.sh`
# limits the run to a subset (space-separated). Default = all 22 accounts.
if [ -n "${AWS_HEALTH_PROFILES:-}" ]; then
  # shellcheck disable=SC2206
  PROFILES=(${AWS_HEALTH_PROFILES})
else
  PROFILES=("${ALL_PROFILES[@]}")
fi

# AWS Health events are emitted in the account's home region; aws.health is a
# global-ish source but the EventBridge rule must live in the region where the
# events land. IskayPet operates in eu-west-1, so the forwarding rule + role
# target that region. Override with AWS_HEALTH_ACCOUNT_REGION if needed.
REGION="${AWS_HEALTH_ACCOUNT_REGION:-eu-west-1}"

for p in "${PROFILES[@]}"; do
  acct=$(aws sts get-caller-identity --profile "$p" --query Account --output text 2>/dev/null)
  if [ -z "$acct" ]; then
    echo "[$p] SKIP — no valid session"
    continue
  fi

  # 1. IAM role (global) — create if missing, then (re)attach inline policy.
  role_created=0
  if aws iam get-role --role-name "$ROLE_NAME" --profile "$p" >/dev/null 2>&1; then
    : # role exists
  else
    if aws iam create-role \
        --role-name "$ROLE_NAME" \
        --assume-role-policy-document "$TRUST_DOC" \
        --description "EventBridge cross-account PutEvents to the portal AWS Health hub" \
        --profile "$p" >/dev/null 2>&1; then
      role_created=1
    else
      echo "[$p / $acct] FAILED to create role $ROLE_NAME"
      continue
    fi
  fi

  if ! aws iam put-role-policy \
      --role-name "$ROLE_NAME" \
      --policy-name "$ROLE_POLICY_NAME" \
      --policy-document "$ROLE_POLICY_DOC" \
      --profile "$p" >/dev/null 2>&1; then
    echo "[$p / $acct] FAILED to attach inline policy to $ROLE_NAME"
    continue
  fi

  ROLE_ARN="arn:aws:iam::${acct}:role/${ROLE_NAME}"

  # New roles need a moment before EventBridge can assume them (IAM eventual consistency).
  if [ "$role_created" -eq 1 ]; then
    echo "[$p / $acct] role $ROLE_NAME created — waiting 10s for IAM propagation"
    sleep 10
  fi

  # 2. Rule on the default bus: aws.health -> central hub bus.
  if ! aws events put-rule \
      --name "$RULE_NAME" \
      --event-bus-name default \
      --event-pattern '{"source":["aws.health"]}' \
      --state ENABLED \
      --description "Forward aws.health events to the portal central bus in dp-tooling" \
      --profile "$p" --region "$REGION" >/dev/null 2>&1; then
    echo "[$p / $acct] FAILED to put rule $RULE_NAME"
    continue
  fi

  if aws events put-targets \
      --rule "$RULE_NAME" \
      --event-bus-name default \
      --targets "Id=portal-health-hub,Arn=${HUB_BUS_ARN},RoleArn=${ROLE_ARN}" \
      --profile "$p" --region "$REGION" >/dev/null 2>&1; then
    echo "[$p / $acct] OK — aws.health forwarding -> $HUB_BUS_ARN"
  else
    echo "[$p / $acct] FAILED to set target (rule exists, retry to finish)"
  fi
done

echo ""
echo "== Rollout complete =="
echo "   Verify a test event reaches the queue (see header of this file / spec task 9)."
