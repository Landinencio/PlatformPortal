-- Portal tickets index: tracks Jira tickets created from the portal
-- Used to show ticket history per user (since Jira reporter is always the service account)

CREATE TABLE IF NOT EXISTS portal_tickets (
  id SERIAL PRIMARY KEY,
  jira_key VARCHAR(20) NOT NULL UNIQUE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('incident', 'request')),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  priority VARCHAR(10) NOT NULL DEFAULT 'media',
  business_team VARCHAR(50),
  requestor_email VARCHAR(255) NOT NULL,
  requestor_name VARCHAR(255),
  status VARCHAR(30) NOT NULL DEFAULT 'open',
  has_attachments BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX idx_portal_tickets_requestor ON portal_tickets (requestor_email);
CREATE INDEX idx_portal_tickets_status ON portal_tickets (status);
CREATE INDEX idx_portal_tickets_type ON portal_tickets (type);
CREATE INDEX idx_portal_tickets_created ON portal_tickets (created_at DESC);
