#!/usr/bin/env bash
# Audit script — fire many CUR queries and dump distilled results.
# Helps decide which dimensions are worth surfacing in the portal.
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
RUN="$DIR/athena-explore.sh"

probe() {
  local name="$1"; local sql="$2"
  echo
  echo "════ [$name] ════"
  "$RUN" "$sql" 2>/dev/null | python3 -c "
import sys, json
arr = json.load(sys.stdin)
# Treat first len(arr)/N as header. Determine column count from first probe. Print all rows.
for i, v in enumerate(arr):
  print(repr(v) if v else '<null>', end='\t')
  print()
" 2>/dev/null || echo "(failed)"
}

# What month do we have?
probe "available months" \
"SELECT date_format(date_trunc('month', line_item_usage_start_date), '%Y-%m') AS month, ROUND(SUM(line_item_unblended_cost), 2) AS cost
 FROM athenacurcfn_finnops.data
 WHERE line_item_usage_start_date >= DATE '2026-01-01'
 GROUP BY 1 ORDER BY 1"

# Top services current month
probe "top services may26" \
"SELECT line_item_product_code AS service, ROUND(SUM(line_item_unblended_cost), 2) AS cost
 FROM athenacurcfn_finnops.data
 WHERE line_item_usage_start_date >= DATE '2026-05-01' AND line_item_usage_start_date < DATE '2026-06-01'
   AND line_item_line_item_type IN ('Usage','Tax','Fee')
 GROUP BY 1 ORDER BY cost DESC LIMIT 15"

# Are there resource tags? Which ones?
probe "tag keys (first 20)" \
"SELECT DISTINCT key FROM (
   SELECT array_agg(key) AS keys FROM athenacurcfn_finnops.data
   WHERE line_item_usage_start_date >= DATE '2026-05-01'
 ) CROSS JOIN UNNEST(keys) AS t(key)
 LIMIT 20"

# Spread by usage_type — typical: BoxUsage, DataTransfer, ...
probe "top usage_type may" \
"SELECT line_item_usage_type AS usage_type, ROUND(SUM(line_item_unblended_cost), 2) AS cost
 FROM athenacurcfn_finnops.data
 WHERE line_item_usage_start_date >= DATE '2026-05-01' AND line_item_line_item_type IN ('Usage','Fee')
 GROUP BY 1 ORDER BY cost DESC LIMIT 20"

# Data transfer — internet egress, inter-region, inter-AZ
probe "data transfer may" \
"SELECT
   CASE
     WHEN line_item_usage_type LIKE '%DataTransfer-Out-Bytes%' OR line_item_usage_type LIKE '%DataTransfer-Internet%' THEN 'OutToInternet'
     WHEN line_item_usage_type LIKE '%InterRegion%' OR line_item_usage_type LIKE '%CrossRegion%' THEN 'InterRegion'
     WHEN line_item_usage_type LIKE '%RegionalDataTransfer%' OR line_item_usage_type LIKE '%CrossAZ%' OR line_item_usage_type LIKE '%InterAZ%' THEN 'InterAZ'
     WHEN line_item_usage_type LIKE '%DataTransfer-In%' THEN 'In'
     WHEN line_item_usage_type LIKE '%DataTransfer%' OR line_item_usage_type LIKE '%Bytes%' THEN 'OtherTransfer'
     ELSE 'NoTransfer'
   END AS bucket,
   ROUND(SUM(line_item_unblended_cost), 2) AS cost,
   ROUND(SUM(line_item_usage_amount), 2) AS gb
 FROM athenacurcfn_finnops.data
 WHERE line_item_usage_start_date >= DATE '2026-05-01' AND line_item_usage_start_date < DATE '2026-06-01'
   AND line_item_line_item_type IN ('Usage','Fee')
 GROUP BY 1 ORDER BY cost DESC"

# RI vs SP vs OD vs Spot detail
probe "pricing model may" \
"SELECT
   CASE
     WHEN savings_plan_savings_plan_a_r_n IS NOT NULL THEN 'SavingsPlan'
     WHEN reservation_reservation_a_r_n IS NOT NULL THEN 'ReservedInstance'
     WHEN pricing_term = 'Spot' OR line_item_usage_type LIKE '%Spot%' THEN 'Spot'
     ELSE 'OnDemand'
   END AS pm,
   ROUND(SUM(line_item_unblended_cost), 2) AS cost
 FROM athenacurcfn_finnops.data
 WHERE line_item_usage_start_date >= DATE '2026-05-01' AND line_item_usage_start_date < DATE '2026-06-01'
   AND line_item_line_item_type IN ('Usage','Fee')
 GROUP BY 1 ORDER BY cost DESC"

# Top 10 tags by coverage — useful to assess tag governance
probe "tag coverage user_domain" \
"SELECT
   CASE WHEN resource_tags['user_domain'] IS NULL OR resource_tags['user_domain']='' THEN 'untagged' ELSE 'tagged' END AS s,
   ROUND(SUM(line_item_unblended_cost), 2) AS cost
 FROM athenacurcfn_finnops.data
 WHERE line_item_usage_start_date >= DATE '2026-05-01' AND line_item_usage_start_date < DATE '2026-06-01'
   AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage','Fee')
 GROUP BY 1"

# Top operations for top services to detect waste
probe "ec2 operations" \
"SELECT line_item_operation AS op, ROUND(SUM(line_item_unblended_cost), 2) AS cost
 FROM athenacurcfn_finnops.data
 WHERE line_item_usage_start_date >= DATE '2026-05-01' AND line_item_usage_start_date < DATE '2026-06-01'
   AND line_item_product_code='AmazonEC2' AND line_item_line_item_type IN ('Usage','Fee')
 GROUP BY 1 ORDER BY cost DESC LIMIT 15"

# RDS engine breakdown
probe "rds engine breakdown" \
"SELECT product_database_engine AS engine, COUNT(DISTINCT line_item_resource_id) AS resources,
        ROUND(SUM(line_item_unblended_cost), 2) AS cost
 FROM athenacurcfn_finnops.data
 WHERE line_item_usage_start_date >= DATE '2026-05-01' AND line_item_usage_start_date < DATE '2026-06-01'
   AND line_item_product_code='AmazonRDS' AND line_item_line_item_type IN ('Usage','Fee')
 GROUP BY 1 ORDER BY cost DESC"

# EBS storage type (gp2 vs gp3 vs io1 ...)
probe "ebs volume type" \
"SELECT product_volume_api_name AS vt, ROUND(SUM(line_item_unblended_cost), 2) AS cost,
        ROUND(SUM(line_item_usage_amount), 0) AS gb_month
 FROM athenacurcfn_finnops.data
 WHERE line_item_usage_start_date >= DATE '2026-05-01' AND line_item_usage_start_date < DATE '2026-06-01'
   AND line_item_product_code='AmazonEC2' AND line_item_usage_type LIKE '%EBS%' AND line_item_line_item_type='Usage'
 GROUP BY 1 ORDER BY cost DESC LIMIT 10"

# S3 storage class breakdown
probe "s3 storage class" \
"SELECT product_storage_class AS sc, ROUND(SUM(line_item_unblended_cost), 2) AS cost,
        ROUND(SUM(line_item_usage_amount), 0) AS gb
 FROM athenacurcfn_finnops.data
 WHERE line_item_usage_start_date >= DATE '2026-05-01' AND line_item_usage_start_date < DATE '2026-06-01'
   AND line_item_product_code='AmazonS3' AND line_item_line_item_type='Usage'
 GROUP BY 1 ORDER BY cost DESC LIMIT 10"

# CloudFront vs WAF (front-end costs)
probe "cdn waf may" \
"SELECT line_item_product_code AS svc, ROUND(SUM(line_item_unblended_cost), 2) AS cost
 FROM athenacurcfn_finnops.data
 WHERE line_item_usage_start_date >= DATE '2026-05-01' AND line_item_usage_start_date < DATE '2026-06-01'
   AND line_item_product_code IN ('AmazonCloudFront','awswaf','AWSWAF','AWSWAFv2','AmazonRoute53')
   AND line_item_line_item_type IN ('Usage','Fee')
 GROUP BY 1 ORDER BY cost DESC"

# Bedrock / GenAI usage
probe "bedrock genai may" \
"SELECT line_item_product_code AS svc, line_item_operation AS op, ROUND(SUM(line_item_unblended_cost), 2) AS cost
 FROM athenacurcfn_finnops.data
 WHERE line_item_usage_start_date >= DATE '2026-05-01' AND line_item_usage_start_date < DATE '2026-06-01'
   AND line_item_product_code IN ('AmazonBedrock','AmazonSageMaker','AWSAIComprehensive','AmazonComprehend','AmazonTextract')
   AND line_item_line_item_type IN ('Usage','Fee')
 GROUP BY 1, 2 ORDER BY cost DESC LIMIT 15"

# Daily cost trend last 30 days for anomaly check
probe "daily cost last 30" \
"SELECT date_format(line_item_usage_start_date, '%Y-%m-%d') AS day,
        ROUND(SUM(line_item_unblended_cost), 2) AS cost
 FROM athenacurcfn_finnops.data
 WHERE line_item_usage_start_date >= current_date - INTERVAL '30' DAY
   AND line_item_line_item_type IN ('Usage','Tax','Fee')
 GROUP BY 1 ORDER BY 1"

# NAT Gateway data processing
probe "nat gw cost" \
"SELECT
   CASE
     WHEN line_item_usage_type LIKE '%NatGateway-Hours%' THEN 'Hours'
     WHEN line_item_usage_type LIKE '%NatGateway-Bytes%' OR line_item_usage_type LIKE '%NatGateway-Datatransfer%' THEN 'DataProcessed'
     ELSE 'Other'
   END AS kind,
   ROUND(SUM(line_item_unblended_cost), 2) AS cost,
   ROUND(SUM(line_item_usage_amount), 2) AS qty
 FROM athenacurcfn_finnops.data
 WHERE line_item_usage_start_date >= DATE '2026-05-01' AND line_item_usage_start_date < DATE '2026-06-01'
   AND line_item_usage_type LIKE '%NatGateway%' AND line_item_line_item_type='Usage'
 GROUP BY 1 ORDER BY cost DESC"

# Credits / discounts
probe "credit & discount may" \
"SELECT line_item_line_item_type AS t, ROUND(SUM(line_item_unblended_cost), 2) AS cost
 FROM athenacurcfn_finnops.data
 WHERE line_item_usage_start_date >= DATE '2026-05-01' AND line_item_usage_start_date < DATE '2026-06-01'
   AND line_item_line_item_type IN ('Credit','Refund','SppDiscount','BundledDiscount','SavingsPlanNegation','Tax','Fee')
 GROUP BY 1 ORDER BY cost"

# Resource count vs cost — top resources by cost
probe "top 15 resources may" \
"SELECT line_item_resource_id AS rid, line_item_product_code AS svc,
        ROUND(SUM(line_item_unblended_cost), 2) AS cost
 FROM athenacurcfn_finnops.data
 WHERE line_item_usage_start_date >= DATE '2026-05-01' AND line_item_usage_start_date < DATE '2026-06-01'
   AND line_item_line_item_type IN ('Usage','Fee')
   AND line_item_resource_id IS NOT NULL AND TRIM(line_item_resource_id) <> ''
 GROUP BY 1, 2 ORDER BY cost DESC LIMIT 15"

# How many days behind is the data?
probe "data freshness" \
"SELECT MAX(line_item_usage_start_date) AS latest, MIN(line_item_usage_start_date) AS oldest
 FROM athenacurcfn_finnops.data WHERE line_item_usage_start_date >= current_date - INTERVAL '60' DAY"
