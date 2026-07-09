CREATE TABLE IF NOT EXISTS cybersecurity_runs (
    id BIGSERIAL PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'azure_ad',
    report_type TEXT NOT NULL CHECK (
        report_type IN ('vpn_groups', 'inactive_users_90d', 'users_without_mfa_group')
    ),
    status TEXT NOT NULL DEFAULT 'completed' CHECK (
        status IN ('completed', 'partial', 'failed')
    ),
    schema_version TEXT NOT NULL DEFAULT '1',
    source_run_id TEXT,
    generated_at TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    records_count INTEGER NOT NULL DEFAULT 0,
    summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    raw_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_cybersecurity_runs_type_generated
ON cybersecurity_runs (report_type, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_cybersecurity_runs_source_run_id
ON cybersecurity_runs (source_run_id)
WHERE source_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cyber_azure_inactive_users (
    run_id BIGINT NOT NULL REFERENCES cybersecurity_runs(id) ON DELETE CASCADE,
    user_id TEXT,
    display_name TEXT,
    mail TEXT,
    user_principal_name TEXT NOT NULL,
    department TEXT,
    company TEXT,
    created_at_azure TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    last_non_interactive_at TIMESTAMPTZ,
    days_inactive INTEGER,
    never_logged_in BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (run_id, user_principal_name)
);

CREATE INDEX IF NOT EXISTS idx_cyber_inactive_users_run
ON cyber_azure_inactive_users (run_id);

CREATE INDEX IF NOT EXISTS idx_cyber_inactive_users_department
ON cyber_azure_inactive_users (department);

CREATE TABLE IF NOT EXISTS cyber_azure_mfa_gaps (
    run_id BIGINT NOT NULL REFERENCES cybersecurity_runs(id) ON DELETE CASCADE,
    user_id TEXT,
    display_name TEXT,
    mail TEXT,
    user_principal_name TEXT NOT NULL,
    department TEXT,
    job_title TEXT,
    company TEXT,
    created_at_azure TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    last_non_interactive_at TIMESTAMPTZ,
    days_since_login INTEGER,
    never_logged_in BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (run_id, user_principal_name)
);

CREATE INDEX IF NOT EXISTS idx_cyber_mfa_gaps_run
ON cyber_azure_mfa_gaps (run_id);

CREATE INDEX IF NOT EXISTS idx_cyber_mfa_gaps_department
ON cyber_azure_mfa_gaps (department);

CREATE TABLE IF NOT EXISTS cyber_azure_vpn_groups (
    run_id BIGINT NOT NULL REFERENCES cybersecurity_runs(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL,
    group_name TEXT NOT NULL,
    description TEXT,
    member_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_cyber_vpn_groups_run
ON cyber_azure_vpn_groups (run_id);

CREATE TABLE IF NOT EXISTS cyber_azure_vpn_group_members (
    run_id BIGINT NOT NULL REFERENCES cybersecurity_runs(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL,
    user_id TEXT,
    display_name TEXT,
    mail TEXT,
    user_principal_name TEXT NOT NULL,
    department TEXT,
    created_at_azure TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    last_non_interactive_at TIMESTAMPTZ,
    never_logged_in BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (run_id, group_id, user_principal_name)
);

CREATE INDEX IF NOT EXISTS idx_cyber_vpn_members_run
ON cyber_azure_vpn_group_members (run_id);

CREATE INDEX IF NOT EXISTS idx_cyber_vpn_members_group
ON cyber_azure_vpn_group_members (run_id, group_id);
