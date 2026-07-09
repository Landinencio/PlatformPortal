-- Squad self-service infrastructure automation
--
-- Squad day-to-day resources (SQS, SecretsManager, DynamoDB, EventBridge, SNS)
-- are generated from DETERMINISTIC templates (no AI) and committed to each
-- squad's own infra repo. They reuse the SAME approval flow as SRE-critical
-- infra: they are stored in the existing `infra_requests` table (resource_type
-- in the squad set), reviewed via /api/infra-requests/[id]/review with the same
-- per-team approvers, and executed via the squad branch of the execute endpoint.
--
-- This migration only adds the catalog of squad infra repos. No new request
-- table — squad requests live in `infra_requests` for a single unified flow.

CREATE TABLE IF NOT EXISTS squad_repo_catalog (
  id                 SERIAL PRIMARY KEY,
  squad              TEXT NOT NULL UNIQUE,          -- canonical squad key (oms, marketplace, ...)
  display_name       TEXT NOT NULL,                 -- human label (OMS, Marketplace, ...)
  business_team      TEXT NOT NULL,                 -- approver routing: digital|marktech|retail|data
  gitlab_project_id  INTEGER NOT NULL,
  default_branch     TEXT NOT NULL DEFAULT 'main',
  infra_root_path    TEXT NOT NULL DEFAULT 'iac/services',
  aws_account_dev    TEXT,
  aws_account_uat    TEXT,
  aws_account_pro    TEXT,
  account_id_var     TEXT NOT NULL DEFAULT 'oms_account_id',
  domain_tag         TEXT NOT NULL,
  project_tag        TEXT NOT NULL,
  environments       TEXT[] NOT NULL DEFAULT ARRAY['dev','pro'],
  active             BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed from ops/infra-squads-automation-report.md
INSERT INTO squad_repo_catalog
  (squad, display_name, business_team, gitlab_project_id, default_branch, infra_root_path,
   aws_account_dev, aws_account_uat, aws_account_pro, account_id_var, domain_tag, project_tag, environments)
VALUES
  ('oms',                 'OMS',                 'digital', 47360191, 'main', 'iac/services', '999900001111','000011112222','111222333444','oms_account_id','dh','oms',                ARRAY['dev','uat','pro']),
  ('animalis-takeover',   'Animalis (Takeover)', 'digital', 47996140, 'main', 'iac/services', '777888999000',NULL,'888999000111','animalis_account_id','dh','animalis',          ARRAY['dev','pro']),
  ('products',            'Products',            'digital', 53647843, 'main', 'iac/services', '999900001111','000011112222','111222333444','oms_account_id','dh','products',           ARRAY['dev','uat','pro']),
  ('marketplace',         'Marketplace',         'digital', 55103906, 'main', 'iac/services', '999900001111','000011112222','111222333444','oms_account_id','dh','marketplace',        ARRAY['dev','uat','pro']),
  ('shipping',            'Shipping',            'digital', 55815553, 'main', 'iac/services', '999900001111','000011112222','111222333444','oms_account_id','dh','shipping',           ARRAY['dev','uat','pro']),
  ('stores',              'Stores',              'digital', 56914141, 'main', 'iac/services', '999900001111','000011112222','111222333444','oms_account_id','dh','stores',             ARRAY['dev','uat','pro']),
  ('pricing',             'Pricing',             'digital', 57834894, 'main', 'iac/services', '999900001111','000011112222','111222333444','oms_account_id','dh','pricing',            ARRAY['dev','uat','pro']),
  ('websites',            'Websites',            'digital', 58137344, 'main', 'iac/services', '999900001111','000011112222','111222333444','oms_account_id','dh','websites',           ARRAY['dev','uat','pro']),
  ('loyalty',             'Loyalty',             'digital', 58272907, 'main', 'iac/services', '999900001111','000011112222','111222333444','oms_account_id','dh','loyalty',            ARRAY['dev','uat','pro']),
  ('payments',            'Payments',            'digital', 58720638, 'main', 'iac/services', '999900001111','000011112222','111222333444','oms_account_id','dh','payments',           ARRAY['dev','uat','pro']),
  ('business-monitoring', 'Business Monitoring', 'digital', 59123186, 'main', 'iac/services', '999900001111','000011112222','111222333444','oms_account_id','dh','business-monitoring',ARRAY['dev','uat','pro']),
  ('retail-comerzzia',    'Retail/Comerzzia',    'retail',  66404361, 'main', 'iac/services', '444555666777','555666777888','666777888999','retail_account_id','dh','retail',          ARRAY['dev','uat','pro']),
  ('mobile',              'Mobile',              'digital', 68533182, 'main', 'iac/services', '999900001111','000011112222','111222333444','oms_account_id','dh','mobile',             ARRAY['dev','uat','pro']),
  ('identity-providers',  'Identity Providers',  'digital', 70892055, 'main', 'iac/services', '999900001111','000011112222','111222333444','oms_account_id','dh','auth',               ARRAY['dev','uat','pro']),
  ('helios',              'Helios',              'marktech',71455105, 'main', 'iac/services', '555566667777','666677778888','777788889999','helios_account_id','dh','helios',           ARRAY['dev','uat','pro']),
  ('customers',           'Customers',           'digital', 75679703, 'main', 'iac/services', '999900001111','000011112222','111222333444','oms_account_id','dh','customers',          ARRAY['dev','uat','pro']),
  ('core',                'Core',                'digital', 80605987, 'main', 'iac/services', '999900001111','000011112222','111222333444','oms_account_id','dh','core',               ARRAY['dev','uat','pro'])
ON CONFLICT (squad) DO NOTHING;
