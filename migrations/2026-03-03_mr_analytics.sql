-- GitLab MR Analytics Table
-- Stores detailed MR lifecycle metrics for analysis

CREATE TABLE IF NOT EXISTS gitlab_mr_analytics (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    
    -- Project info
    project_id INTEGER NOT NULL,
    project_name VARCHAR(255),
    team VARCHAR(100),
    
    -- MR identification
    mr_id INTEGER NOT NULL,
    mr_iid INTEGER NOT NULL,
    
    -- Basic info
    title TEXT,
    state VARCHAR(32), -- opened, merged, closed, locked
    web_url TEXT,
    
    -- Author info
    author_name VARCHAR(255),
    author_username VARCHAR(255),
    author_email VARCHAR(255),
    author_avatar_url TEXT,
    
    -- Timestamps
    created_at TIMESTAMP NOT NULL,
    merged_at TIMESTAMP,
    updated_at TIMESTAMP,
    first_comment_at TIMESTAMP, -- first human comment (not author, not system)
    
    -- Metrics (in hours for consistency with DORA)
    lifetime_hours DECIMAL(10,2), -- created → merged (or now if open)
    lead_time_hours DECIMAL(10,2), -- created → first comment
    review_time_hours DECIMAL(10,2), -- first comment → merged
    
    -- Activity metrics
    commit_count INTEGER DEFAULT 0,
    review_count INTEGER DEFAULT 0, -- human comments (not author, not system)
    reviewer_count INTEGER DEFAULT 0, -- unique reviewers
    changes_count INTEGER DEFAULT 0, -- additions + deletions
    
    -- Metadata
    reviewers JSONB, -- [{name, username, avatar_url, comments}]
    labels TEXT[],
    source_branch VARCHAR(255),
    target_branch VARCHAR(255),
    
    -- Calculated at
    calculated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(snapshot_date, project_id, mr_iid)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_mr_analytics_date ON gitlab_mr_analytics(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_mr_analytics_project ON gitlab_mr_analytics(project_id);
CREATE INDEX IF NOT EXISTS idx_mr_analytics_team ON gitlab_mr_analytics(team);
CREATE INDEX IF NOT EXISTS idx_mr_analytics_author ON gitlab_mr_analytics(author_username);
CREATE INDEX IF NOT EXISTS idx_mr_analytics_state ON gitlab_mr_analytics(state);
CREATE INDEX IF NOT EXISTS idx_mr_analytics_merged_at ON gitlab_mr_analytics(merged_at);

-- Comments
COMMENT ON TABLE gitlab_mr_analytics IS 'GitLab MR lifecycle metrics for detailed analysis';
COMMENT ON COLUMN gitlab_mr_analytics.lifetime_hours IS 'Total time from creation to merge (or now if open)';
COMMENT ON COLUMN gitlab_mr_analytics.lead_time_hours IS 'Time from creation to first human review comment';
COMMENT ON COLUMN gitlab_mr_analytics.review_time_hours IS 'Time from first review to merge';
COMMENT ON COLUMN gitlab_mr_analytics.first_comment_at IS 'Timestamp of first human comment (excludes author and system notes)';
COMMENT ON COLUMN gitlab_mr_analytics.reviewers IS 'JSON array of reviewers with their comment counts';
