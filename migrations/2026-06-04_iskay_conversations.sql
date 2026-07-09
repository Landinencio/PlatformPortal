-- Iskay (FinOps chat) conversational memory.
-- Persists each turn so the agent can recall prior context across page reloads and the
-- user can continue a previous conversation. Tech debt #15.

CREATE TABLE IF NOT EXISTS iskay_conversations (
  id              SERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL,          -- stable id per chat thread (client-generated)
  user_email      TEXT NOT NULL,          -- owner (domain-normalized at write time)
  role            TEXT NOT NULL,          -- 'user' | 'assistant'
  content         TEXT NOT NULL,          -- message text
  tools_used      JSONB DEFAULT '[]',     -- tool names invoked for an assistant turn
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fetch a thread in order, and list a user's recent threads.
CREATE INDEX IF NOT EXISTS idx_iskay_conv_thread ON iskay_conversations (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_iskay_conv_user ON iskay_conversations (user_email, created_at DESC);
