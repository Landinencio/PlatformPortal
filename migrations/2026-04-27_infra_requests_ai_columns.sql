-- Extend infra_requests table for AI Infrastructure Assistant
-- Adds AI conversation/preview columns, execution tracking columns,
-- and tightens the status CHECK constraint to include 'execute_failed'.
-- All statements are idempotent.

-- 1. New columns
ALTER TABLE infra_requests
  ADD COLUMN IF NOT EXISTS ai_conversation   JSONB,
  ADD COLUMN IF NOT EXISTS terraform_preview JSONB,
  ADD COLUMN IF NOT EXISTS gitlab_mr_url     TEXT,
  ADD COLUMN IF NOT EXISTS gitlab_branch     TEXT,
  ADD COLUMN IF NOT EXISTS jira_key          TEXT,
  ADD COLUMN IF NOT EXISTS executed_at       TIMESTAMPTZ;

-- 2. Status CHECK constraint
--    Drop the old constraint (if it exists under any name) and recreate it
--    with the full set of allowed values including 'execute_failed'.
--    We use a DO block so the DROP is a no-op when the constraint is absent.
DO $$
BEGIN
  -- Drop by the conventional name if present
  IF EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conrelid = 'infra_requests'::regclass
    AND    contype  = 'c'
    AND    conname  = 'infra_requests_status_check'
  ) THEN
    ALTER TABLE infra_requests DROP CONSTRAINT infra_requests_status_check;
  END IF;
END;
$$;

ALTER TABLE infra_requests
  ADD CONSTRAINT infra_requests_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'execute_failed'));
