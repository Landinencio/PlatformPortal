-- MR Review Metrics — standalone index on merged_at (performance only, no correctness change).
--
-- The "Detalle por MR" tab (src/app/api/metrics/mr-details/route.ts) filters and orders
-- mr_review_metrics by `merged_at` (range query + ORDER BY merged_at DESC). The existing
-- indexes all lead by project_id / team / author_username, so the default tab case — a date
-- range WITHOUT a team/project/author filter — has no optimal index. Once the historical
-- backfill (BACKFILL_FROM/BACKFILL_TO in ops/mr-metrics-snapshot.js) grows the table with rows
-- where merged_at < B, this leading-column index on merged_at accelerates that default range
-- query. Idempotent (IF NOT EXISTS); does not alter any query result.
--
-- NOTE: on a large table, consider building this CONCURRENTLY (outside a transaction) to avoid
-- locking writes, e.g.:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mr_review_merged_at
--       ON mr_review_metrics(merged_at DESC);
-- The active statement below uses the plain idempotent form (the design's chosen statement).

CREATE INDEX IF NOT EXISTS idx_mr_review_merged_at
    ON mr_review_metrics(merged_at DESC);
