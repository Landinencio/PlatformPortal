-- Kiro Analytics — compatibility view over user_activity_multi.
--
-- Renames userid->user_id and date->report_date so the portal queries
-- (src/lib/kiro-analytics.ts) read from a clean, multi-account, single-schema
-- source with the same column names they already expect. Keeps the portal SQL
-- almost unchanged (just the table name) and lets the UUID filter stay as a
-- harmless safety belt.
--
-- Apply (idempotent — CREATE OR REPLACE):
--   aws athena start-query-execution \
--     --query-string "$(cat ops/kiro-user-activity-view.sql)" \
--     --work-group kiro-analytics \
--     --query-execution-context Database=kiro_analytics \
--     --region eu-central-1 --profile sys-eks-tooling

CREATE OR REPLACE VIEW kiro_analytics.user_activity_view AS
SELECT
  userid AS user_id,
  "date" AS report_date,
  account,
  chat_aicodelines,
  chat_messagesinteracted,
  chat_messagessent,
  codefix_acceptanceeventcount,
  codefix_acceptedlines,
  codefix_generatedlines,
  codefix_generationeventcount,
  codereview_failedeventcount,
  codereview_findingscount,
  codereview_succeededeventcount,
  dev_acceptanceeventcount,
  dev_acceptedlines,
  dev_generatedlines,
  dev_generationeventcount,
  docgeneration_eventcount,
  inlinechat_totaleventcount,
  inline_aicodelines,
  inline_acceptancecount,
  inline_suggestionscount,
  testgeneration_acceptedlines,
  testgeneration_acceptedtests,
  testgeneration_eventcount,
  transformation_eventcount
FROM kiro_analytics.user_activity_multi;
