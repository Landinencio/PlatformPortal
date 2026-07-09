-- AI Portal Explorer — schema for autonomous functional QA runs (PostgreSQL 16).
--
-- The Explorer crawls the dev portal under each synthetic role, records what it
-- observed per route+role, flags anomalies (deterministic + RBAC detectors) and
-- runs an LLM triage on top. Screenshots and the full Markdown report live in S3;
-- PostgreSQL keeps metadata, structured evidence (JSONB) and S3 references.
--
-- Tables:
--   exploration_runs  — one row per run (history is preserved, Req 7.7)
--   visit_results     — one Visit per (run, scenario, role) (Req 4.4)
--   anomalies         — deterministic/RBAC findings, keyed by equivalence (Req 8.4)
--   triage_results    — LLM triage per anomaly, with regression flag (Req 8.1/8.2)
--   explorer_run_lock — singleton lock for the atomic single-run claim (Req 9.5)
--
-- Requirements: 7.1, 7.7, 9.5, 10.2

-- ---------------------------------------------------------------------------
-- exploration_runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exploration_runs (
  run_id              UUID PRIMARY KEY,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at         TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'running',  -- running|completed|completed-with-errors|aborted
  abort_reason        TEXT,
  base_url            TEXT NOT NULL,
  roles_covered       JSONB NOT NULL DEFAULT '[]',      -- AppRole[]
  trigger_source      TEXT NOT NULL DEFAULT 'cron',     -- cron|on-demand
  routes_visited      INTEGER NOT NULL DEFAULT 0,
  anomalies_total     INTEGER NOT NULL DEFAULT 0,
  bedrock_calls       INTEGER NOT NULL DEFAULT 0,
  report_markdown_ref TEXT,                             -- s3://...
  summary             JSONB                             -- ReportSummary
);

CREATE INDEX IF NOT EXISTS idx_exploration_runs_started ON exploration_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_exploration_runs_status  ON exploration_runs (status, started_at DESC);

-- ---------------------------------------------------------------------------
-- visit_results
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS visit_results (
  id                BIGSERIAL PRIMARY KEY,
  run_id            UUID NOT NULL REFERENCES exploration_runs(run_id) ON DELETE CASCADE,
  scenario_id       TEXT NOT NULL,
  route_path        TEXT NOT NULL,
  route_kind        TEXT NOT NULL,                     -- ui|api
  section           TEXT NOT NULL,
  role              TEXT NOT NULL,
  params            JSONB NOT NULL DEFAULT '{}',
  http_status       INTEGER,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  timed_out         BOOLEAN NOT NULL DEFAULT FALSE,
  access_observed   TEXT NOT NULL,                     -- granted|denied
  console_errors    JSONB NOT NULL DEFAULT '[]',
  failed_requests   JSONB NOT NULL DEFAULT '[]',
  dom_error_states  JSONB NOT NULL DEFAULT '[]',
  data_signal       JSONB,                             -- DataSignal
  screenshot_ref    TEXT,                              -- s3://...
  uncaught_error    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, scenario_id, role)                   -- una Visit por scenario+role (Req 4.4)
);

CREATE INDEX IF NOT EXISTS idx_visit_results_run ON visit_results (run_id);
CREATE INDEX IF NOT EXISTS idx_visit_results_route_role ON visit_results (route_path, role);

-- ---------------------------------------------------------------------------
-- anomalies
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS anomalies (
  anomaly_id        TEXT NOT NULL,
  run_id            UUID NOT NULL REFERENCES exploration_runs(run_id) ON DELETE CASCADE,
  scenario_id       TEXT NOT NULL,
  route_path        TEXT NOT NULL,
  role              TEXT NOT NULL,
  category          TEXT NOT NULL,                     -- AnomalyCategory
  detector          TEXT NOT NULL,                     -- deterministic|rbac
  equivalence_key   TEXT NOT NULL,                     -- route+role+category (Req 8.4)
  evidence          JSONB NOT NULL,                    -- AnomalyEvidence
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, anomaly_id)
);

CREATE INDEX IF NOT EXISTS idx_anomalies_run ON anomalies (run_id);
CREATE INDEX IF NOT EXISTS idx_anomalies_equiv ON anomalies (equivalence_key);

-- ---------------------------------------------------------------------------
-- triage_results
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS triage_results (
  id                TEXT NOT NULL,                     -- == anomaly_id
  run_id            UUID NOT NULL REFERENCES exploration_runs(run_id) ON DELETE CASCADE,
  route_path        TEXT NOT NULL,
  role              TEXT NOT NULL,
  severity          TEXT NOT NULL,                     -- critical|high|medium|low|info
  category          TEXT NOT NULL,
  probable_cause    TEXT NOT NULL,
  suggested_fix     TEXT NOT NULL,
  evidence          JSONB NOT NULL,
  status            TEXT NOT NULL,                     -- triaged|triage-unavailable|triage-skipped-budget
  is_regression     BOOLEAN NOT NULL DEFAULT FALSE,    -- (Req 8.1, 8.2)
  equivalence_key   TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, id)
);

CREATE INDEX IF NOT EXISTS idx_triage_run_sev ON triage_results (run_id, severity);
CREATE INDEX IF NOT EXISTS idx_triage_equiv ON triage_results (equivalence_key, created_at DESC);

-- ---------------------------------------------------------------------------
-- explorer_run_lock (single-run claim)
-- ---------------------------------------------------------------------------
-- Single-run lock: one singleton row. The atomic claim prevents concurrent runs
-- (Req 9.5), analogous to the deploy_notifications pattern. The claim uses
--   UPDATE explorer_run_lock SET active_run_id = $1, acquired_at = NOW()
--     WHERE id = 1 AND active_run_id IS NULL
-- and checks rowCount; the run is released by setting active_run_id = NULL.
-- Run history is never deleted (Req 7.7).
CREATE TABLE IF NOT EXISTS explorer_run_lock (
  id                INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  active_run_id     UUID,
  acquired_at       TIMESTAMPTZ,
  CONSTRAINT explorer_run_lock_singleton CHECK (id = 1)
);

-- Materialize the singleton row so the claim UPDATE always has a row to target.
INSERT INTO explorer_run_lock (id, active_run_id, acquired_at)
VALUES (1, NULL, NULL)
ON CONFLICT (id) DO NOTHING;
