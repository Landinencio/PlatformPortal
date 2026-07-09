-- Infra request improvements: reminder tracking + cancelled status support
ALTER TABLE infra_requests ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

-- Partial index for efficient reminder query (only pending requests without reminders)
CREATE INDEX IF NOT EXISTS idx_infra_requests_pending_reminder
  ON infra_requests (status, created_at)
  WHERE status = 'pending' AND reminder_sent_at IS NULL;
