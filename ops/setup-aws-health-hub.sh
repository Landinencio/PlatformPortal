#!/usr/bin/env bash
# Provision the central AWS Health ingestion hub in dp-tooling (444455556666, eu-west-1).
# Idempotent: every step is create-or-update and can be re-run safely.
#
# Creates / updates:
#   1. SQS queue   portal-aws-health-events            (+ queue policy: EventBridge -> SendMessage)
#   2. EventBridge bus portal-aws-health               (+ resource policy: org accounts -> PutEvents)
#   3. EventBridge rule portal-aws-health-to-sqs        on that bus, pattern {"source":["aws.health"]} -> SQS
#   4. Inline IAM policy AwsHealthQueueReader           on role portal-inventory-irsa (portal SQS read access)
#
# Per-account forwarding rules (the 22 org accounts -> this bus) are applied by
# ops/apply-aws-health-eventbridge.sh (separate, multi-account rollout).
set -uo pipefail

PROFILE="${AWS_HEALTH_TOOLING_PROFILE:-eks-tooling}"
REGION="${AWS_HEALTH_REGION:-eu-west-1}"
ACCOUNT_ID="444455556666"
ORG_ID="${AWS_HEALTH_ORG_ID:-o-8u43vqg0jh}"

QUEUE_NAME="portal-aws-health-events"
BUS_NAME="portal-aws-health"
RULE_NAME="portal-aws-health-to-sqs"
IRSA_ROLE="portal-inventory-irsa"
IRSA_POLICY="AwsHealthQueueReader"

QUEUE_ARN="arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${QUEUE_NAME}"
BUS_ARN="arn:aws:events:${REGION}:${ACCOUNT_ID}:event-bus/${BUS_NAME}"
RULE_ARN="arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${BUS_NAME}/${RULE_NAME}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== AWS Health hub setup (dp-tooling) =="
echo "   profile=$PROFILE region=$REGION account=$ACCOUNT_ID org=$ORG_ID"

# Pre-flight: confirm we are really in dp-tooling.
CALLER_ACCT=$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text 2>/dev/null)
if [ "$CALLER_ACCT" != "$ACCOUNT_ID" ]; then
  echo "ABORT — profile '$PROFILE' resolves to account '$CALLER_ACCT', expected $ACCOUNT_ID (dp-tooling). No session? run: aws sso login --profile $PROFILE"
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. SQS queue
# ---------------------------------------------------------------------------
echo "-- [1/4] SQS queue $QUEUE_NAME"
aws sqs create-queue \
  --queue-name "$QUEUE_NAME" \
  --attributes "MessageRetentionPeriod=1209600,ReceiveMessageWaitTimeSeconds=5,VisibilityTimeout=120" \
  --profile "$PROFILE" --region "$REGION" >/dev/null \
  && echo "   queue ensured: $QUEUE_ARN" \
  || { echo "   FAILED creating queue"; exit 1; }

# Queue policy: allow EventBridge (the central bus rule) to SendMessage.
# The JSON ships with the real dp-tooling ARNs hardcoded (fixed account), so we
# only strip the _comment field. set-queue-attributes needs an {"Policy":"..."}
# map whose value is the policy as a JSON *string*; build it with python to escape
# correctly (the shorthand Policy=... form breaks on the JSON commas/equals).
SQS_ATTRS_FILE="$(mktemp)"
trap 'rm -f "$SQS_ATTRS_FILE"' EXIT
python3 - "$SCRIPT_DIR/aws-health-sqs-policy.json" "$SQS_ATTRS_FILE" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
doc = json.load(open(src))
doc.pop("_comment", None)
json.dump({"Policy": json.dumps(doc)}, open(dst, "w"))
PY
aws sqs set-queue-attributes \
  --queue-url "https://sqs.${REGION}.amazonaws.com/${ACCOUNT_ID}/${QUEUE_NAME}" \
  --attributes "file://${SQS_ATTRS_FILE}" \
  --profile "$PROFILE" --region "$REGION" >/dev/null \
  && echo "   queue policy applied (EventBridge SendMessage)" \
  || { echo "   FAILED applying queue policy"; exit 1; }

# ---------------------------------------------------------------------------
# 2. EventBridge bus + resource policy
# ---------------------------------------------------------------------------
echo "-- [2/4] EventBridge bus $BUS_NAME"
if aws events describe-event-bus --name "$BUS_NAME" --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; then
  echo "   bus already exists"
else
  aws events create-event-bus --name "$BUS_NAME" --profile "$PROFILE" --region "$REGION" >/dev/null \
    && echo "   bus created: $BUS_ARN" \
    || { echo "   FAILED creating bus"; exit 1; }
fi

# Resource policy: any account in the org can PutEvents (PrincipalOrgID condition).
BUS_POLICY=$(sed "s#o-8u43vqg0jh#${ORG_ID}#g" "$SCRIPT_DIR/aws-health-bus-policy.json" | grep -v '"_comment"')
aws events put-permission \
  --event-bus-name "$BUS_NAME" \
  --policy "$(echo "$BUS_POLICY" | tr -d '\n')" \
  --profile "$PROFILE" --region "$REGION" >/dev/null \
  && echo "   bus resource policy applied (org $ORG_ID -> PutEvents)" \
  || { echo "   FAILED applying bus policy"; exit 1; }

# ---------------------------------------------------------------------------
# 3. Rule on the bus: source=aws.health -> SQS
# ---------------------------------------------------------------------------
echo "-- [3/4] rule $RULE_NAME on $BUS_NAME"
aws events put-rule \
  --name "$RULE_NAME" \
  --event-bus-name "$BUS_NAME" \
  --event-pattern '{"source":["aws.health"]}' \
  --state ENABLED \
  --description "Route aws.health events fanned-in from org accounts to the portal SQS queue" \
  --profile "$PROFILE" --region "$REGION" >/dev/null \
  && echo "   rule ensured" \
  || { echo "   FAILED creating rule"; exit 1; }

aws events put-targets \
  --rule "$RULE_NAME" \
  --event-bus-name "$BUS_NAME" \
  --targets "Id=portal-aws-health-sqs,Arn=${QUEUE_ARN}" \
  --profile "$PROFILE" --region "$REGION" >/dev/null \
  && echo "   target -> $QUEUE_ARN" \
  || { echo "   FAILED setting target"; exit 1; }

# ---------------------------------------------------------------------------
# 4. Inline IRSA policy: portal can read the queue
# ---------------------------------------------------------------------------
echo "-- [4/4] inline policy $IRSA_POLICY on $IRSA_ROLE"
IRSA_DOC=$(grep -v '"_comment"' "$SCRIPT_DIR/aws-health-queue-reader-policy.json")
aws iam put-role-policy \
  --role-name "$IRSA_ROLE" \
  --policy-name "$IRSA_POLICY" \
  --policy-document "$IRSA_DOC" \
  --profile "$PROFILE" >/dev/null \
  && echo "   inline policy attached to $IRSA_ROLE" \
  || { echo "   FAILED attaching inline policy"; exit 1; }

echo ""
echo "== Done. Central hub ready =="
echo "   Queue ARN : $QUEUE_ARN"
echo "   Bus ARN   : $BUS_ARN"
echo "   Next      : run ops/apply-aws-health-eventbridge.sh to forward aws.health from the 22 org accounts."
echo "   Portal env: set AWS_HEALTH_QUEUE_URL=https://sqs.${REGION}.amazonaws.com/${ACCOUNT_ID}/${QUEUE_NAME}"
