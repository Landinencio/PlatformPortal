-- AWS Health events cache (ingested via EventBridge `aws.health` -> SQS)
--
-- The org is on Basic Support, so the paid AWS Health API is NOT used. Instead,
-- `aws.health` events are fanned-in cross-account to a central EventBridge bus in
-- dp-tooling and routed to the `portal-aws-health-events` SQS queue, which the
-- portal polls (lib/aws-health.ts -> syncAwsHealthEvents) and upserts here.
--
-- `arn` as PRIMARY KEY allows per-event upsert (idempotent against SQS at-least-once
-- redelivery): an event that changes state updates the existing row. `first_seen`
-- distinguishes brand-new events (for the digest's "last 24h" novelty) and is
-- preserved across upserts; `synced_at` records the last time the event was seen
-- in the queue.

CREATE TABLE IF NOT EXISTS aws_health_events (
  arn             TEXT PRIMARY KEY,            -- event ARN (stable from AWS Health)
  service         TEXT NOT NULL,
  region          TEXT,
  event_type_code TEXT,
  category        TEXT NOT NULL,               -- issue | scheduledChange | accountNotification
  status_code     TEXT NOT NULL,               -- open | upcoming | closed
  severity        TEXT NOT NULL DEFAULT 'low', -- alta | media | baja (inferred)
  start_time      TIMESTAMPTZ,
  end_time        TIMESTAMPTZ,
  last_updated    TIMESTAMPTZ,
  affected_accounts JSONB NOT NULL DEFAULT '[]', -- [{ accountId, accountName }]
  description     TEXT,
  raw             JSONB,                        -- full normalized payload
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aws_health_status ON aws_health_events (status_code, last_updated DESC);
CREATE INDEX IF NOT EXISTS idx_aws_health_updated ON aws_health_events (last_updated DESC);
