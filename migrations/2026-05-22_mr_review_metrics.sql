-- MR Review Metrics — per-MR detail for engineering management
CREATE TABLE IF NOT EXISTS mr_review_metrics (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL,
    project_path TEXT NOT NULL,
    team TEXT,
    
    -- MR identity
    mr_iid INTEGER NOT NULL,
    mr_title TEXT,
    mr_url TEXT,
    author_username TEXT,
    author_name TEXT,
    target_branch TEXT DEFAULT 'main',
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL,
    merged_at TIMESTAMPTZ,
    first_commit_at TIMESTAMPTZ,
    
    -- Calculated metrics
    time_to_pr_hours NUMERIC(10,2),       -- first_commit → MR created
    review_time_hours NUMERIC(10,2),      -- MR created → merged
    
    -- Counts
    commit_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    reviewer_count INTEGER DEFAULT 0,
    lines_added INTEGER DEFAULT 0,
    lines_removed INTEGER DEFAULT 0,
    
    -- Metadata
    snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
    
    UNIQUE(project_id, mr_iid)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_mr_review_project_date 
    ON mr_review_metrics(project_id, merged_at DESC);
CREATE INDEX IF NOT EXISTS idx_mr_review_team_date 
    ON mr_review_metrics(team, merged_at DESC);
CREATE INDEX IF NOT EXISTS idx_mr_review_author 
    ON mr_review_metrics(author_username, merged_at DESC);
CREATE INDEX IF NOT EXISTS idx_mr_review_snapshot 
    ON mr_review_metrics(snapshot_date DESC);
