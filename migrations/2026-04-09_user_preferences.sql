-- User preferences (presets, settings, etc.)
CREATE TABLE IF NOT EXISTS user_preferences (
  id          SERIAL PRIMARY KEY,
  user_email  TEXT NOT NULL,
  pref_key    TEXT NOT NULL,
  pref_value  JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_email, pref_key)
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_email ON user_preferences (user_email);
