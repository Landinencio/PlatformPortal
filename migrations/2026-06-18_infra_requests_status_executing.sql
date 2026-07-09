-- 2026-06-18 — Fix infra_requests status CHECK constraint.
--
-- The v2 approve→execute flow introduced a transient 'executing' status
-- (atomic claim `approved → executing`) and a 'cancelled' status (self-service
-- cancel flow), but the original CHECK constraint only allowed
-- pending/approved/rejected/executed/execute_failed. As a result, the claim
-- UPDATE threw `violates check constraint "infra_requests_status_check"`,
-- the execute endpoint returned 500, and every approved request stayed stuck
-- in 'approved' (no branch / MR / Jira ever created).
--
-- This widens the allowed set (additive, non-destructive, reversible) to
-- include 'executing' and 'cancelled'.

ALTER TABLE infra_requests DROP CONSTRAINT IF EXISTS infra_requests_status_check;

ALTER TABLE infra_requests ADD CONSTRAINT infra_requests_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text,
    'approved'::text,
    'rejected'::text,
    'executing'::text,
    'executed'::text,
    'execute_failed'::text,
    'cancelled'::text
  ]));
