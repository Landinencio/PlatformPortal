-- User activity tracking for Admin dashboard
-- Safe to run multiple times

CREATE TABLE IF NOT EXISTS portal_user_activity (
    id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_type TEXT NOT NULL,
    user_email TEXT NOT NULL,
    user_name TEXT,
    user_role TEXT NOT NULL,
    auth_sub TEXT,
    portal_session_id TEXT,
    path TEXT,
    action TEXT,
    duration_seconds INTEGER,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address TEXT,
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_portal_user_activity_occurred_at
    ON portal_user_activity (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_portal_user_activity_user_email
    ON portal_user_activity (user_email, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_portal_user_activity_session
    ON portal_user_activity (portal_session_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_portal_user_activity_event_type
    ON portal_user_activity (event_type, occurred_at DESC);
