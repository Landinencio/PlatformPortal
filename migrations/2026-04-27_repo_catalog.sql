-- Repo catalog: maps team names to GitLab project IDs and infra repo metadata.
-- Replaces the hardcoded teamMap in n8n and TEAM_REPO_MAPPING in the form.

CREATE TABLE IF NOT EXISTS repo_catalog (
  id                SERIAL PRIMARY KEY,
  team              TEXT NOT NULL UNIQUE,
  gitlab_project_id INTEGER NOT NULL,
  default_branch    TEXT NOT NULL DEFAULT 'main',
  infra_root_path   TEXT NOT NULL DEFAULT 'iac/',
  description       TEXT,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at on row changes
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER repo_catalog_set_updated_at
  BEFORE UPDATE ON repo_catalog
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Seed with current known teams
INSERT INTO repo_catalog (team, gitlab_project_id, default_branch, infra_root_path) VALUES
  ('Digital',  45379727, 'main',   'iac/'),
  ('Helios',   71456629, 'main',   'iac/'),
  ('Retail',   45383610, 'main',   'iac/'),
  ('Commerce', 45379518, 'main',   'iac/'),
  ('Clusters', 45379816, 'main',   'iac/'),
  ('Tooling',  45950137, 'master', 'iac/')
ON CONFLICT (team) DO NOTHING;
