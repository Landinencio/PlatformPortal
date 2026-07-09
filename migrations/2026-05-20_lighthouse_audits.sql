-- Lighthouse audit results from Unlighthouse weekly scans
CREATE TABLE IF NOT EXISTS lighthouse_audits (
    id SERIAL PRIMARY KEY,
    monitor_id INTEGER NOT NULL REFERENCES synthetic_monitors(id),
    scan_date DATE NOT NULL,
    route TEXT NOT NULL DEFAULT '/',
    
    -- Core scores (0-100)
    score_performance INTEGER,
    score_accessibility INTEGER,
    score_best_practices INTEGER,
    score_seo INTEGER,
    
    -- Core Web Vitals
    lcp_ms INTEGER,           -- Largest Contentful Paint (ms)
    fid_ms INTEGER,           -- First Input Delay (ms)
    cls NUMERIC(5,3),         -- Cumulative Layout Shift
    ttfb_ms INTEGER,          -- Time to First Byte (ms)
    si_ms INTEGER,            -- Speed Index (ms)
    tbt_ms INTEGER,           -- Total Blocking Time (ms)
    fcp_ms INTEGER,           -- First Contentful Paint (ms)
    
    -- Page metadata
    page_title TEXT,
    page_size_kb INTEGER,
    request_count INTEGER,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(monitor_id, scan_date, route)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_lighthouse_audits_monitor_date 
    ON lighthouse_audits(monitor_id, scan_date DESC);
CREATE INDEX IF NOT EXISTS idx_lighthouse_audits_scan_date 
    ON lighthouse_audits(scan_date DESC);
CREATE INDEX IF NOT EXISTS idx_lighthouse_audits_route 
    ON lighthouse_audits(monitor_id, route);

-- Summary view for quick dashboard queries
CREATE OR REPLACE VIEW lighthouse_summary AS
SELECT 
    monitor_id,
    scan_date,
    COUNT(*) as total_routes,
    ROUND(AVG(score_performance)) as avg_performance,
    ROUND(AVG(score_accessibility)) as avg_accessibility,
    ROUND(AVG(score_best_practices)) as avg_best_practices,
    ROUND(AVG(score_seo)) as avg_seo,
    ROUND(AVG(lcp_ms)) as avg_lcp_ms,
    ROUND(AVG(cls)::numeric, 3) as avg_cls,
    ROUND(AVG(tbt_ms)) as avg_tbt_ms
FROM lighthouse_audits
GROUP BY monitor_id, scan_date;
