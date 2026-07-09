-- Kiro Analytics — multi-account "user_report" table (usage / licence per user).
--
-- WHY: the crawler-generated `user_report` table is scoped to ONLY the tooling
-- account (s3://test-kiro-logs/logs/logs/AWSLogs/444455556666/KiroLogs/user_report/)
-- and uses LazySimpleSerDe (keeps the surrounding double-quotes from the source CSV,
-- breaking value matching). All three accounts (444455556666, 666777888999,
-- 111222333444) actually have user_report CSVs.
--
-- This table reads user_report from ALL accounts via partition projection and uses
-- OpenCSVSerde to strip the quotes. It is the richer per-user signal (email,
-- subscription tier, total/auto messages, per-Claude-model messages, conversations)
-- complementing by_user_analytic. Named `user_report_multi` (not a folder name) so
-- the daily crawler — which names tables after S3 folders — never overwrites it.
-- Column names (user_id/report_date) match the canonical `user_report_raw` table now
-- defined in the shared-general CloudFormation (iac/kiro_dashboard) — so once that
-- stack is applied, point the portal at `user_report_raw` (env KIRO_REPORT_TABLE)
-- and drop this temporary table.
--
-- Apply (idempotent):
--   aws athena start-query-execution \
--     --query-string "$(cat ops/kiro-user-report-multi-account.sql)" \
--     --work-group kiro-analytics \
--     --query-execution-context Database=kiro_analytics \
--     --region eu-central-1 --profile sys-eks-tooling

CREATE EXTERNAL TABLE IF NOT EXISTS kiro_analytics.user_report_multi (
  report_date string,
  user_id string,
  client_type string,
  chat_conversations string,
  credits_used string,
  overage_cap string,
  overage_credits_used string,
  overage_enabled string,
  profileid string,
  subscription_tier string,
  total_messages string,
  new_user string,
  user_email string,
  auto_messages string,
  claude_messages string
)
PARTITIONED BY (account string)
ROW FORMAT SERDE 'org.apache.hadoop.hive.serde2.OpenCSVSerde'
WITH SERDEPROPERTIES (
  'separatorChar' = ',',
  'quoteChar' = '"',
  'escapeChar' = '\\'
)
STORED AS INPUTFORMAT 'org.apache.hadoop.mapred.TextInputFormat'
OUTPUTFORMAT 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat'
LOCATION 's3://test-kiro-logs/logs/logs/AWSLogs/'
TBLPROPERTIES (
  'skip.header.line.count' = '1',
  'classification' = 'csv',
  'projection.enabled' = 'true',
  'projection.account.type' = 'enum',
  'projection.account.values' = '444455556666,666777888999,111222333444',
  'storage.location.template' = 's3://test-kiro-logs/logs/logs/AWSLogs/${account}/KiroLogs/user_report'
);
