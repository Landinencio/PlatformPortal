#!/usr/bin/env bash
# Helper to fire ad-hoc queries to the IskayPet CUR Athena database.
# Uses workgroup primary, db athenacurcfn_finnops, output bucket finnops-iskaypet.
set -euo pipefail

PROFILE="${PROFILE:-root-iskaypet}"
REGION="eu-west-1"
DB="athenacurcfn_finnops"
WG="primary"
OUTPUT="s3://finnops-iskaypet/athena-query-results/"

if [ -z "${1:-}" ]; then
  echo "usage: $0 <sql>"
  exit 1
fi
SQL="$1"

QID=$(aws athena start-query-execution \
  --query-string "$SQL" \
  --query-execution-context "Database=$DB" \
  --work-group "$WG" \
  --result-configuration "OutputLocation=$OUTPUT" \
  --region "$REGION" --profile "$PROFILE" \
  --output text --query 'QueryExecutionId')

echo "QID: $QID" >&2

while true; do
  STATE=$(aws athena get-query-execution --query-execution-id "$QID" \
    --region "$REGION" --profile "$PROFILE" \
    --output text --query 'QueryExecution.Status.State')
  case "$STATE" in
    SUCCEEDED) break ;;
    FAILED|CANCELLED)
      REASON=$(aws athena get-query-execution --query-execution-id "$QID" \
        --region "$REGION" --profile "$PROFILE" \
        --output text --query 'QueryExecution.Status.StateChangeReason')
      echo "Query $STATE: $REASON" >&2
      exit 1
      ;;
  esac
  sleep 1
done

aws athena get-query-results --query-execution-id "$QID" \
  --region "$REGION" --profile "$PROFILE" \
  --output json --max-results 100 \
  --query 'ResultSet.Rows[].Data[].VarCharValue'
