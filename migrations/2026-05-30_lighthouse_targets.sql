-- Lighthouse audit targets — populated by the weekly sitemap-refresh cron and
-- consumed by the per-brand lighthouse-scan crons.
--
-- Each row represents a single URL we want Lighthouse to audit, classified by
-- page_type so the UI and reports can group "all PDPs" or "all category pages".
--
-- The same table also stores manually pinned URLs (priority=1, source='manual')
-- which always get audited regardless of the sitemap classification.

CREATE TABLE IF NOT EXISTS lighthouse_targets (
    id BIGSERIAL PRIMARY KEY,
    monitor_id INT NOT NULL REFERENCES synthetic_monitors(id) ON DELETE CASCADE,
    -- Path relative to the brand's base URL, e.g. "/perro/comida/marca-x/"
    route TEXT NOT NULL,
    -- Logical bucket: home / plp / pdp / brand / blog / search / cart / checkout /
    --                 account / login / help / legal / other
    page_type TEXT NOT NULL,
    -- 1 = always audit, 5 = audit only if quota allows. Manual pins are 1.
    priority SMALLINT NOT NULL DEFAULT 3,
    -- "sitemap", "manual", "ga4_top", "search_console_top"
    source TEXT NOT NULL DEFAULT 'sitemap',
    -- Optional metadata, e.g. estimated GA pageviews / search impressions
    extra JSONB,
    -- Whether to include this URL in the next scan
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_audit_date DATE,
    UNIQUE (monitor_id, route)
);

CREATE INDEX IF NOT EXISTS idx_lighthouse_targets_monitor_priority
    ON lighthouse_targets(monitor_id, enabled, priority, page_type);
CREATE INDEX IF NOT EXISTS idx_lighthouse_targets_page_type
    ON lighthouse_targets(monitor_id, page_type) WHERE enabled = TRUE;

-- Backfill: populate targets table with the URLs that the legacy script had
-- hardcoded so the new scanner picks them up on the first run.
-- (We let the sitemap refresher add the rest; these are the manual seeds.)
INSERT INTO lighthouse_targets (monitor_id, route, page_type, priority, source)
VALUES
    -- Animalis (FR) — monitor_id=1
    (1, '/', 'home', 1, 'manual'),
    (1, '/chiens/', 'plp', 2, 'manual'),
    (1, '/chats/', 'plp', 2, 'manual'),
    (1, '/aquariophilie/', 'plp', 2, 'manual'),
    (1, '/conseils', 'blog', 3, 'manual'),
    (1, '/contact', 'help', 3, 'manual'),
    -- Kiwoko ES — monitor_id=2
    (2, '/', 'home', 1, 'manual'),
    (2, '/ofertas/', 'plp', 2, 'manual'),
    (2, '/black-friday/', 'plp', 3, 'manual'),
    -- Kiwoko PT — monitor_id=3
    (3, '/', 'home', 1, 'manual'),
    (3, '/ofertas/', 'plp', 2, 'manual'),
    -- Tiendanimal ES — monitor_id=4
    (4, '/', 'home', 1, 'manual'),
    (4, '/articulos/', 'blog', 3, 'manual'),
    (4, '/contacto', 'help', 3, 'manual'),
    (4, '/ofertas-black-friday/', 'plp', 3, 'manual'),
    (4, '/consultorio-veterinario.html', 'help', 4, 'manual'),
    (4, '/especial/bienvenida/', 'plp', 4, 'manual'),
    -- Tiendanimal PT — monitor_id=5
    (5, '/', 'home', 1, 'manual'),
    (5, '/artigos/', 'blog', 3, 'manual'),
    (5, '/contacto', 'help', 3, 'manual')
ON CONFLICT (monitor_id, route) DO NOTHING;

-- Add page_type column to the audits table so we can pre-aggregate by bucket
-- without re-classifying on every UI render. The sitemap refresher writes the
-- type to lighthouse_targets and the scanner copies it into lighthouse_audits.
ALTER TABLE lighthouse_audits
    ADD COLUMN IF NOT EXISTS page_type TEXT;

CREATE INDEX IF NOT EXISTS idx_lighthouse_audits_page_type
    ON lighthouse_audits(monitor_id, page_type, scan_date DESC) WHERE page_type IS NOT NULL;

-- Update the summary view to expose grouped scores per page_type as well.
-- (We keep the existing per-monitor/scan_date grouping intact; the page_type
-- aggregation is a separate view to avoid breaking existing consumers.)
CREATE OR REPLACE VIEW lighthouse_summary_by_type AS
SELECT
    monitor_id,
    scan_date,
    COALESCE(page_type, 'other') AS page_type,
    COUNT(*) AS routes,
    ROUND(AVG(score_performance))::INT AS avg_performance,
    ROUND(AVG(score_accessibility))::INT AS avg_accessibility,
    ROUND(AVG(score_best_practices))::INT AS avg_best_practices,
    ROUND(AVG(score_seo))::INT AS avg_seo,
    ROUND(AVG(lcp_ms))::INT AS avg_lcp_ms,
    ROUND(AVG(cls)::numeric, 3) AS avg_cls,
    ROUND(AVG(tbt_ms))::INT AS avg_tbt_ms
FROM lighthouse_audits
WHERE score_performance IS NOT NULL
GROUP BY monitor_id, scan_date, COALESCE(page_type, 'other');
