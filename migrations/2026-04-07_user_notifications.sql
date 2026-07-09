-- User notifications system
CREATE TABLE IF NOT EXISTS user_notifications (
  id            SERIAL PRIMARY KEY,
  user_email    TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'info',        -- info, approval_request, approval_result, system
  title         TEXT NOT NULL,
  message       TEXT NOT NULL,
  link          TEXT,                                 -- optional deep link within the portal
  metadata      JSONB DEFAULT '{}',                   -- flexible payload (request_id, resource_type, etc.)
  read          BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_email ON user_notifications (user_email, read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_notifications_type ON user_notifications (type, created_at DESC);
