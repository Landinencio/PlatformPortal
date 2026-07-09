#!/usr/bin/env bash
# Helper temporal: ejecuta una query Athena (CUR finnops) y espera resultado.
# Uso: _athena_run.sh "<SQL>"
set -euo pipefail
SQL="$1"
PROFILE="root-iskaypet"
REGION="eu-west-1"
DB="athenacurcfn_finnops"
OUT="s3://finnops-iskaypet/athena-query-results/"

QID=$(aws athena start-query-execution \
  --profile "$PROFILE" --region "$REGION" \
  --query-string "$SQL" \
  --query-execution-context Database="$DB" \
  --result-configuration OutputLocation="$OUT" \
  --query 'QueryExecutionId' --output text)

echo "QueryExecutionId: $QID"

while true; do
  ST=$(aws athena get-query-execution --profile "$PROFILE" --region "$REGION" \
        --query-execution-id "$QID" --query 'QueryExecution.Status.State' --output text)
  case "$ST" in
    SUCCEEDED) break ;;
    FAILED|CANCELLED)
      echo "STATE: $ST"
      aws athena get-query-execution --profile "$PROFILE" --region "$REGION" \
        --query-execution-id "$QID" --query 'QueryExecution.Status.StateChangeReason' --output text
      exit 1 ;;
    *) sleep 2 ;;
  esac
done

SCANNED=$(aws athena get-query-execution --profile "$PROFILE" --region "$REGION" \
  --query-execution-id "$QID" --query 'QueryExecution.Statistics.DataScannedInBytes' --output text)
echo "DataScanned: $SCANNED bytes"
echo "----- RESULTS -----"
aws athena get-query-results --profile "$PROFILE" --region "$REGION" \
  --query-execution-id "$QID" --output text --query 'ResultSet.Rows[].Data[].VarCharValue'
