-- Webhook Events Raw — Event Store for GitLab webhooks
CREATE TABLE IF NOT EXISTS webhook_events_raw (
    id SERIAL PRIMARY KEY,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    gitlab_event_type TEXT NOT NULL,
    gitlab_project_id INTEGER,
    gitlab_group_id INTEGER,
    project_path TEXT,
    group_name TEXT,
    payload JSONB NOT NULL,
    processing_status TEXT NOT NULL DEFAULT 'pending',
    processed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    source_ip TEXT,
    CONSTRAINT valid_status CHECK (processing_status IN ('pending', 'processing', 'processed', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events_raw(processing_status, received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_events_project ON webhook_events_raw(gitlab_project_id, received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_events_type ON webhook_events_raw(gitlab_event_type, received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_events_group ON webhook_events_raw(gitlab_group_id, received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events_raw(received_at);

-- Processing log — tracks every processing attempt
CREATE TABLE IF NOT EXISTS webhook_processing_log (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES webhook_events_raw(id),
    attempt_number INTEGER NOT NULL DEFAULT 1,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    status TEXT NOT NULL,
    error_message TEXT,
    metrics_affected JSONB
);

CREATE INDEX IF NOT EXISTS idx_processing_log_event ON webhook_processing_log(event_id);
