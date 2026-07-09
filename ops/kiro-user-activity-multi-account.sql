-- Kiro Analytics — multi-account "by_user_analytic" table (clean per-user productivity)
--
-- WHY: the crawler `kiro-user-activity-crawler` targets the *root*
-- s3://test-kiro-logs/logs/logs/AWSLogs/ with recurse, so the auto-generated
-- `user_activity_raw` table mixes TWO incompatible CSV schemas living under it:
--   - <acct>/KiroLogs/by_user_analytic/  -> per-user productivity (userid,date,chat_*,inline_*,dev_*,...)
--   - <acct>/KiroLogs/user_report/       -> usage/licence report (date,userid,user_email,subscription_tier,...)
-- Forcing the by_user_analytic schema over user_report rows shifts columns, so
-- `user_id` receives a date/text and only ~12 rows survive the UUID filter.
--
-- This table is scoped ONLY to the by_user_analytic prefix and is partitioned by
-- account via partition projection, so it reads productivity data from ALL accounts
-- (444455556666 has none today; 666777888999 + 111222333444 do) WITHOUT pulling in
-- user_report rows. Named `user_activity_multi` (not a folder name) so the daily
-- crawler — which names tables after S3 folders — never recreates/overwrites it.
--
-- Apply (idempotent):
--   aws athena start-query-execution \
--     --query-string "$(cat ops/kiro-user-activity-multi-account.sql)" \
--     --work-group kiro-analytics \
--     --query-execution-context Database=kiro_analytics \
--     --region eu-central-1 --profile sys-eks-tooling
--
-- Proper long-term fix (separate, in shared-general IaC): point the crawler at the
-- specific prefixes (by_user_analytic/ and user_report/) instead of the AWSLogs/ root.

CREATE EXTERNAL TABLE IF NOT EXISTS kiro_analytics.user_activity_multi (
  userid string,
  `date` string,
  chat_aicodelines string,
  chat_messagesinteracted string,
  chat_messagessent string,
  codefix_acceptanceeventcount string,
  codefix_acceptedlines string,
  codefix_generatedlines string,
  codefix_generationeventcount string,
  codereview_failedeventcount string,
  codereview_findingscount string,
  codereview_succeededeventcount string,
  dev_acceptanceeventcount string,
  dev_acceptedlines string,
  dev_generatedlines string,
  dev_generationeventcount string,
  docgeneration_acceptedfileupdates string,
  docgeneration_acceptedfilescreations string,
  docgeneration_acceptedlineadditions string,
  docgeneration_acceptedlineupdates string,
  docgeneration_eventcount string,
  docgeneration_rejectedfilecreations string,
  docgeneration_rejectedfileupdates string,
  docgeneration_rejectedlineadditions string,
  docgeneration_rejectedlineupdates string,
  inlinechat_acceptanceeventcount string,
  inlinechat_acceptedlineadditions string,
  inlinechat_acceptedlinedeletions string,
  inlinechat_dismissaleventcount string,
  inlinechat_dismissedlineadditions string,
  inlinechat_dismissedlinedeletions string,
  inlinechat_rejectedlineadditions string,
  inlinechat_rejectedlinedeletions string,
  inlinechat_rejectioneventcount string,
  inlinechat_totaleventcount string,
  inline_aicodelines string,
  inline_acceptancecount string,
  inline_suggestionscount string,
  testgeneration_acceptedlines string,
  testgeneration_acceptedtests string,
  testgeneration_eventcount string,
  testgeneration_generatedlines string,
  testgeneration_generatedtests string,
  transformation_eventcount string,
  transformation_linesgenerated string,
  transformation_linesingested string
)
PARTITIONED BY (account string)
-- OpenCSVSerde strips the surrounding double-quotes that the source CSV wraps each
-- field in (e.g. "52c514f4-..."). LazySimpleSerDe would keep them as literal chars
-- and break the UUID match. OpenCSVSerde treats every column as string.
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
  'storage.location.template' = 's3://test-kiro-logs/logs/logs/AWSLogs/${account}/KiroLogs/by_user_analytic'
);
