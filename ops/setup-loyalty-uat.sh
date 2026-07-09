#!/bin/bash
# Setup missing methods + integrations for Loyalty-V2 in UAT
set -e

PROFILE="eks-uat"
REGION="eu-west-1"
API_ID="yi5qe8ht03"
VPC_LINK="etc3ca"
BASE_URI="http://loyalty-v2.uat.dp.iskaypet.com"

# Helper function
setup_method() {
  local RESOURCE_ID=$1
  local HTTP_METHOD=$2
  local URI_PATH=$3
  local REQUEST_PARAMS=$4

  echo "=== Setting up $HTTP_METHOD $URI_PATH on resource $RESOURCE_ID ==="

  # Create method
  aws apigateway put-method \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method $HTTP_METHOD \
    --authorization-type NONE \
    --api-key-required \
    --request-parameters "$REQUEST_PARAMS" \
    --profile $PROFILE --region $REGION --output json > /dev/null

  # Create integration
  aws apigateway put-integration \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method $HTTP_METHOD \
    --type HTTP_PROXY \
    --integration-http-method $HTTP_METHOD \
    --uri "${BASE_URI}${URI_PATH}" \
    --connection-type VPC_LINK \
    --connection-id $VPC_LINK \
    --request-parameters "$REQUEST_PARAMS" \
    --passthrough-behavior WHEN_NO_TEMPLATES \
    --timeout-in-millis 29000 \
    --profile $PROFILE --region $REGION --output json > /dev/null

  # Create method response
  aws apigateway put-method-response \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method $HTTP_METHOD \
    --status-code 200 \
    --response-models '{"application/json": "Empty"}' \
    --profile $PROFILE --region $REGION --output json > /dev/null

  # Create integration response
  aws apigateway put-integration-response \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method $HTTP_METHOD \
    --status-code 200 \
    --response-templates '{"application/json": ""}' \
    --profile $PROFILE --region $REGION --output json > /dev/null

  echo "  Done."
}

# 1. /sites/{int}/customers/{string}/carts - POST
setup_method "1zvfid" "POST" "/sites/{int}/customers/{string}/carts" \
  '{"method.request.path.int": true, "method.request.path.string": true}'

# 2. /sites/{int}/customers/{string}/orders - POST
setup_method "aflv7p" "POST" "/sites/{int}/customers/{string}/orders" \
  '{"method.request.path.int": true, "method.request.path.string": true}'

# 3. /sites/{int}/customers/{string}/resend - POST
setup_method "8eyo72" "POST" "/sites/{int}/customers/{string}/resend" \
  '{"method.request.path.int": true, "method.request.path.string": true}'

# 4. /sites/{int}/offers - GET
setup_method "5ik1ej" "GET" "/sites/{int}/offers" \
  '{"method.request.path.int": true}'

echo ""
echo "=== All methods configured. Deploying to stage v1... ==="

# Deploy
aws apigateway create-deployment \
  --rest-api-id $API_ID \
  --stage-name v1 \
  --description "Full Loyalty-V2 deployment with all endpoints" \
  --profile $PROFILE --region $REGION --output json

echo ""
echo "=== Creating API Key and Usage Plan ==="

# Create API Key
KEY_RESULT=$(aws apigateway create-api-key \
  --name "loyalty-v2-uat-key" \
  --enabled \
  --profile $PROFILE --region $REGION --output json)

KEY_ID=$(echo $KEY_RESULT | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['id'])")
KEY_VALUE=$(echo $KEY_RESULT | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['value'])")

echo "  API Key ID: $KEY_ID"
echo "  API Key Value: $KEY_VALUE"

# Create Usage Plan
PLAN_RESULT=$(aws apigateway create-usage-plan \
  --name "loyalty-v2-uat-plan" \
  --api-stages "apiId=$API_ID,stage=v1" \
  --throttle burstLimit=100,rateLimit=50 \
  --quota limit=100000,period=MONTH \
  --profile $PROFILE --region $REGION --output json)

PLAN_ID=$(echo $PLAN_RESULT | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['id'])")
echo "  Usage Plan ID: $PLAN_ID"

# Associate key with plan
aws apigateway create-usage-plan-key \
  --usage-plan-id $PLAN_ID \
  --key-id $KEY_ID \
  --key-type API_KEY \
  --profile $PROFILE --region $REGION --output json > /dev/null

echo ""
echo "=========================================="
echo "  DONE!"
echo "=========================================="
echo "  API URL: https://${API_ID}.execute-api.${REGION}.amazonaws.com/v1"
echo "  API Key: $KEY_VALUE"
echo "=========================================="
