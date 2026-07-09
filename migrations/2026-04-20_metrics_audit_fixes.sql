-- Metrics Audit Fixes — 2026-04-20
-- Fixes identified during comprehensive metrics audit

-- 1. Add missing username to developer_name_map
INSERT INTO developer_name_map (gitlab_username, canonical_name, gitlab_display_name)
VALUES ('renzo.daccorso-old', 'Renzo D''Accorso', 'renzo.daccorso@intersoftware.global')
ON CONFLICT (gitlab_username) DO UPDATE SET
  canonical_name = EXCLUDED.canonical_name,
  gitlab_display_name = EXCLUDED.gitlab_display_name,
  updated_at = NOW();

-- 2. Reclassify historical hotfixes that used fix/ prefix (removed from detection)
UPDATE deployment_traces
SET deploy_type = 'feature', deploy_type_reason = 'reclassified:was-' || deploy_type_reason
WHERE deploy_type = 'hotfix' AND deploy_type_reason LIKE 'branch:fix/%';

-- 3. Fix gonzalo.aguila incorrectly named as 'Facundo Arenas'
UPDATE developer_activity_daily
SET developer_name = 'Gonzalo Águila'
WHERE developer_email LIKE '%gonzalo.aguila%' AND developer_name = 'Facundo Arenas';

-- 4. Fix ruben.landin typo (iskatpet -> iskaypet) — merge into correct rows
UPDATE developer_activity_daily correct
SET 
  commits_count = correct.commits_count + typo.commits_count,
  lines_added = correct.lines_added + typo.lines_added,
  lines_removed = correct.lines_removed + typo.lines_removed,
  mrs_opened = correct.mrs_opened + typo.mrs_opened,
  mrs_merged = correct.mrs_merged + typo.mrs_merged,
  reviews_given = correct.reviews_given + typo.reviews_given
FROM developer_activity_daily typo
WHERE typo.developer_email = 'ruben.landin@iskatpet.com'
  AND correct.developer_email = 'ruben.landin@iskaypet.com'
  AND correct.snapshot_date = typo.snapshot_date
  AND correct.project_id = typo.project_id;

DELETE FROM developer_activity_daily
WHERE developer_email = 'ruben.landin@iskatpet.com'
  AND (snapshot_date, project_id) IN (
    SELECT snapshot_date, project_id FROM developer_activity_daily
    WHERE developer_email = 'ruben.landin@iskaypet.com'
  );

UPDATE developer_activity_daily
SET developer_email = 'ruben.landin@iskaypet.com', developer_name = 'Rubén Landín'
WHERE developer_email = 'ruben.landin@iskatpet.com';

-- 5. Fix email-as-name using developer_name_map
UPDATE developer_activity_daily dad
SET developer_name = dnm.canonical_name
FROM developer_name_map dnm
WHERE dad.developer_name LIKE '%@%'
AND (
  dnm.gitlab_username = SPLIT_PART(dad.developer_email, '@', 1)
  OR dnm.gitlab_display_name = dad.developer_name
);

-- 6. Normalize Rubén Landín name across all rows
UPDATE developer_activity_daily
SET developer_name = 'Rubén Landín'
WHERE developer_email LIKE '%ruben.landin%';

-- 7. Reclassify product-dev as non-production (false positive)
UPDATE production_deployments
SET environment = 'product-dev-reclassified'
WHERE environment = 'product-dev';
