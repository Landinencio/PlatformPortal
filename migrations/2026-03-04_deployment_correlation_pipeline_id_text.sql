-- Allow deployment correlation to store deployment IDs coming from deployment_traces.
-- deployment_traces.deploy_id is VARCHAR(64), so the correlation table must not force INTEGER.

ALTER TABLE deployment_correlation
ALTER COLUMN gitlab_pipeline_id TYPE VARCHAR(64)
USING gitlab_pipeline_id::VARCHAR(64);
