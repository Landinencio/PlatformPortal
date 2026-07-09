#!/usr/bin/env node
/**
 * Lighthouse Scanner — runs Google Lighthouse against configured sites
 * and stores results in PostgreSQL.
 *
 * Scans the homepage + key routes of each site.
 * Uses lighthouse CLI directly (faster and more reliable than unlighthouse full crawl).
 *
 * Env vars:
 *   DATABASE_URL — PostgreSQL connection string
 *   MONITOR_ID — scan only this monitor (optional, scans all if not set)
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });
const SCAN_DATE = new Date().toISOString().slice(0, 10);
const EXCLUDE_MONITOR_IDS = [6]; // Comerzzia (internal)
const MAX_ROUTES_PER_BRAND = Number(process.env.MAX_ROUTES_PER_BRAND || "50");

// Legacy hardcoded fallback — used only if lighthouse_targets is empty for a
// given monitor (so the migration to DB-driven targets is fail-safe).
const LEGACY_ROUTES = {
  1: ["/", "/chiens/", "/chats/", "/aquariophilie/", "/conseils", "/contact"],
  2: ["/", "/ofertas/", "/black-friday/"],
  3: ["/", "/ofertas/"],
  4: ["/", "/articulos/", "/contacto", "/ofertas-black-friday/", "/consultorio-veterinario.html", "/especial/bienvenida/"],
  5: ["/", "/artigos/", "/contacto"],
};

async function getSites() {
  const monitorId = process.env.MONITOR_ID;
  if (monitorId) {
    const { rows } = await pool.query(
      `SELECT id, name, url FROM synthetic_monitors WHERE id = $1`,
      [parseInt(monitorId, 10)]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT id, name, url FROM synthetic_monitors WHERE id NOT IN (${EXCLUDE_MONITOR_IDS.join(",")}) ORDER BY id`
  );
  return rows;
}

/**
 * Returns the list of routes to audit for a site, ordered by priority.
 * Reads from `lighthouse_targets` if any rows exist for the monitor; otherwise
 * falls back to the legacy hardcoded list (so the rollout is fail-safe).
 */
async function getRoutesForSite(monitorId) {
  const { rows } = await pool.query(
    `SELECT route, page_type, priority
       FROM lighthouse_targets
      WHERE monitor_id = $1 AND enabled = TRUE
      ORDER BY priority ASC, page_type ASC, route ASC
      LIMIT $2`,
    [monitorId, MAX_ROUTES_PER_BRAND],
  );
  if (rows.length > 0) {
    return rows.map((r) => ({ route: r.route, page_type: r.page_type, priority: r.priority }));
  }
  // Fallback — should rarely trigger after the seed migration runs
  console.log(`  ! No lighthouse_targets rows for monitor ${monitorId}, using legacy hardcoded list`);
  const legacy = LEGACY_ROUTES[monitorId] || ["/"];
  return legacy.map((route) => ({ route, page_type: route === "/" ? "home" : "other", priority: 3 }));
}

function runLighthouse(url) {
  const outputFile = `/tmp/lh-${Date.now()}.json`;
  
  try {
    execSync(
      `npx lighthouse "${url}" --output=json --output-path="${outputFile}" --chrome-flags="--headless --no-sandbox --disable-gpu --disable-dev-shm-usage" --only-categories=performance,accessibility,best-practices,seo --quiet`,
      {
        stdio: "pipe",
        timeout: 120_000, // 2 min per page max
        env: { ...process.env, CHROME_PATH: process.env.CHROME_PATH || "/usr/bin/chromium" },
      }
    );

    if (fs.existsSync(outputFile)) {
      const data = JSON.parse(fs.readFileSync(outputFile, "utf-8"));
      fs.unlinkSync(outputFile);
      return data;
    }
  } catch (err) {
    console.error(`    Error: ${err.message?.slice(0, 100)}`);
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
  }
  return null;
}

function extractMetrics(lhr, route) {
  const categories = lhr.categories || {};
  const audits = lhr.audits || {};

  const getScore = (cat) => {
    const c = categories[cat];
    return c ? Math.round((c.score || 0) * 100) : null;
  };

  const getMs = (key) => {
    const a = audits[key];
    return a?.numericValue ? Math.round(a.numericValue) : null;
  };

  // Extract top opportunities (things that can improve performance)
  const opportunities = [];
  const opportunityKeys = [
    "render-blocking-resources",
    "unused-javascript",
    "unused-css-rules",
    "modern-image-formats",
    "uses-optimized-images",
    "uses-responsive-images",
    "offscreen-images",
    "unminified-javascript",
    "unminified-css",
    "efficient-animated-content",
    "duplicated-javascript",
    "legacy-javascript",
    "uses-text-compression",
    "uses-rel-preconnect",
    "server-response-time",
    "redirects",
    "uses-http2",
    "dom-size",
    "critical-request-chains",
    "font-display",
  ];

  for (const key of opportunityKeys) {
    const audit = audits[key];
    if (audit && audit.score !== null && audit.score < 1) {
      opportunities.push({
        id: key,
        title: audit.title || key,
        description: (audit.description || "").slice(0, 200),
        savingsMs: audit.numericValue ? Math.round(audit.numericValue) : null,
        savingsBytes: audit.details?.overallSavingsBytes ? Math.round(audit.details.overallSavingsBytes / 1024) : null,
        score: audit.score !== undefined ? Math.round(audit.score * 100) : null,
      });
    }
  }

  // Extract key diagnostics
  const diagnostics = [];
  const diagnosticKeys = [
    "dom-size",
    "total-byte-weight",
    "mainthread-work-breakdown",
    "bootup-time",
    "network-requests",
    "third-party-summary",
    "largest-contentful-paint-element",
    "layout-shift-elements",
    "long-tasks",
  ];

  for (const key of diagnosticKeys) {
    const audit = audits[key];
    if (audit && audit.details) {
      const diag = {
        id: key,
        title: audit.title || key,
        displayValue: audit.displayValue || null,
      };
      // Add specific details for dom-size
      if (key === "dom-size" && audit.numericValue) {
        diag.value = Math.round(audit.numericValue);
      }
      if (key === "total-byte-weight" && audit.numericValue) {
        diag.value = Math.round(audit.numericValue / 1024); // KB
      }
      if (key === "network-requests" && audit.details?.items) {
        diag.value = audit.details.items.length;
      }
      diagnostics.push(diag);
    }
  }

  return {
    route,
    score_performance: getScore("performance"),
    score_accessibility: getScore("accessibility"),
    score_best_practices: getScore("best-practices"),
    score_seo: getScore("seo"),
    lcp_ms: getMs("largest-contentful-paint"),
    fid_ms: getMs("max-potential-fid"),
    cls: audits["cumulative-layout-shift"]?.numericValue ?? null,
    ttfb_ms: getMs("server-response-time"),
    si_ms: getMs("speed-index"),
    tbt_ms: getMs("total-blocking-time"),
    fcp_ms: getMs("first-contentful-paint"),
    page_title: lhr.finalDisplayedUrl || null,
    page_size_kb: audits["total-byte-weight"]?.numericValue
      ? Math.round(audits["total-byte-weight"].numericValue / 1024)
      : null,
    request_count: audits["network-requests"]?.details?.items?.length || null,
    opportunities: opportunities.length > 0 ? opportunities : null,
    diagnostics: diagnostics.length > 0 ? diagnostics : null,
  };
}

async function storeMetrics(monitorId, metrics) {
  try {
    await pool.query(
      `INSERT INTO lighthouse_audits 
       (monitor_id, scan_date, route, page_type, score_performance, score_accessibility, 
        score_best_practices, score_seo, lcp_ms, fid_ms, cls, ttfb_ms, si_ms, 
        tbt_ms, fcp_ms, page_title, page_size_kb, request_count, opportunities, diagnostics)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       ON CONFLICT (monitor_id, scan_date, route) DO UPDATE SET
         page_type = EXCLUDED.page_type,
         score_performance = EXCLUDED.score_performance,
         score_accessibility = EXCLUDED.score_accessibility,
         score_best_practices = EXCLUDED.score_best_practices,
         score_seo = EXCLUDED.score_seo,
         lcp_ms = EXCLUDED.lcp_ms,
         fid_ms = EXCLUDED.fid_ms,
         cls = EXCLUDED.cls,
         ttfb_ms = EXCLUDED.ttfb_ms,
         si_ms = EXCLUDED.si_ms,
         tbt_ms = EXCLUDED.tbt_ms,
         fcp_ms = EXCLUDED.fcp_ms,
         page_title = EXCLUDED.page_title,
         page_size_kb = EXCLUDED.page_size_kb,
         request_count = EXCLUDED.request_count,
         opportunities = EXCLUDED.opportunities,
         diagnostics = EXCLUDED.diagnostics`,
      [
        monitorId, SCAN_DATE, metrics.route, metrics.page_type || null,
        metrics.score_performance, metrics.score_accessibility,
        metrics.score_best_practices, metrics.score_seo,
        metrics.lcp_ms, metrics.fid_ms, metrics.cls,
        metrics.ttfb_ms, metrics.si_ms, metrics.tbt_ms, metrics.fcp_ms,
        metrics.page_title, metrics.page_size_kb, metrics.request_count,
        metrics.opportunities ? JSON.stringify(metrics.opportunities) : null,
        metrics.diagnostics ? JSON.stringify(metrics.diagnostics) : null,
      ]
    );
    // Mark the target as audited
    await pool.query(
      `UPDATE lighthouse_targets SET last_audit_date = $1 WHERE monitor_id = $2 AND route = $3`,
      [SCAN_DATE, monitorId, metrics.route],
    );
    return true;
  } catch (err) {
    console.error(`    DB error: ${err.message?.slice(0, 100)}`);
    return false;
  }
}

async function main() {
  console.log(`Lighthouse Scanner — ${SCAN_DATE}`);
  console.log("=".repeat(50));

  const sites = await getSites();
  console.log(`Sites to scan: ${sites.map(s => s.name).join(", ")}`);

  let totalStored = 0;

  for (const site of sites) {
    console.log(`\n=== ${site.name} (${site.url}) ===`);
    const targets = await getRoutesForSite(site.id);
    console.log(`  Routes to scan: ${targets.length}`);

    for (const target of targets) {
      const url = site.url.replace(/\/$/, "") + target.route;
      console.log(`  [${target.page_type}] Scanning ${target.route}...`);

      const lhr = runLighthouse(url);
      if (!lhr) {
        console.log(`    Skipped (no result)`);
        continue;
      }

      const metrics = extractMetrics(lhr, target.route);
      metrics.page_type = target.page_type;
      console.log(`    Perf=${metrics.score_performance} A11y=${metrics.score_accessibility} BP=${metrics.score_best_practices} SEO=${metrics.score_seo}`);

      const stored = await storeMetrics(site.id, metrics);
      if (stored) totalStored++;
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Done. Total routes stored: ${totalStored}`);
  await pool.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
