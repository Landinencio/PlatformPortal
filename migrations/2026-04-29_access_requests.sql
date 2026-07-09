-- Access management request system
CREATE TABLE IF NOT EXISTS access_requests (
  id              SERIAL PRIMARY KEY,
  requestor_email TEXT NOT NULL,
  target_user_email TEXT NOT NULL,
  platform        TEXT NOT NULL,          -- aws, argocd, sonarqube, gitlab
  request_type    TEXT NOT NULL DEFAULT 'grant', -- grant, revoke
  group_id        TEXT,                   -- Azure AD group ID or GitLab group ID
  group_name      TEXT,                   -- Display name of the group
  role            TEXT,                   -- GitLab access level (guest, reporter, developer, maintainer)
  approver_email  TEXT NOT NULL,          -- Selected approver
  status          TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected, executed, execute_failed
  reviewer_email  TEXT,
  reviewer_name   TEXT,
  review_comment  TEXT,
  reviewed_at     TIMESTAMPTZ,
  executed_at     TIMESTAMPTZ,
  jira_key        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_requests_requestor ON access_requests (requestor_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_requests_target ON access_requests (target_user_email, created_at DESC);
