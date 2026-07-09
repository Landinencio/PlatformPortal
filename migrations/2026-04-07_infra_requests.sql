-- Infrastructure request approval system
CREATE TABLE IF NOT EXISTS infra_requests (
  id              SERIAL PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending, approved, rejected
  resource_type   TEXT NOT NULL,                     -- s3, rds, lambda, iam_role
  team            TEXT NOT NULL,
  requestor_email TEXT NOT NULL,
  requestor_name  TEXT,
  payload         JSONB NOT NULL,                    -- full request body for the n8n webhook
  reviewer_email  TEXT,
  reviewer_name   TEXT,
  review_comment  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_infra_requests_status ON infra_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_infra_requests_requestor ON infra_requests (requestor_email, created_at DESC);
