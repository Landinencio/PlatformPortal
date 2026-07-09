-- Deploy Notifications — dedup store for "prod deploy → Teams" notifications.
--
-- Guarantees exactly-one notification per (pipeline_id, project_id). GitLab fires
-- the `pipeline` webhook multiple times (pending→running→success, plus retries)
-- and the portal runs 2 replicas, so we need a strong uniqueness claim. The
-- claim is done with INSERT ... ON CONFLICT DO NOTHING BEFORE sending the card.
CREATE TABLE IF NOT EXISTS deploy_notifications (
    pipeline_id  BIGINT NOT NULL,
    project_id   BIGINT NOT NULL,
    project_path TEXT,
    notified_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (pipeline_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_deploy_notifications_notified_at
    ON deploy_notifications(notified_at);
