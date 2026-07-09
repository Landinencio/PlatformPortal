-- Track whether the requestor has been notified that their infra is LIVE in AWS
-- (apply pipeline succeeded), so the GitLab pipeline webhook notifies only once.
ALTER TABLE infra_requests
  ADD COLUMN IF NOT EXISTS infra_live_notified BOOLEAN NOT NULL DEFAULT false;
