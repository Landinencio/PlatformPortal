#!/usr/bin/env node
/**
 * Lighthouse targets refresher — discovers URLs from each brand's sitemap.xml,
 * classifies them by URL pattern (home / plp / pdp / brand / blog / search /
 * cart / checkout / account / login / help / legal / other) and upserts them
 * into the `lighthouse_targets` table.
 *
 * The per-brand `lighthouse-scan` cron then reads from that table.
 *
 * Sampling strategy:
 *   - Always include home, login, cart, checkout, account, help, legal (1 each).
 *   - Sample N per type for plp, pdp, brand, blog, search using a stable hash
 *     so the same URLs are picked across weeks (predictable trends).
 *
 * Env vars:
 *   DATABASE_URL — PostgreSQL connection string
 *   MAX_PER_TYPE — quota per page_type per brand (default 8)
 *   MAX_TOTAL_PER_BRAND — hard cap per brand (default 50)
 *   ONLY_MONITOR_ID — restrict to a single monitor for testing
 */

const { Pool } = require("pg");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const MAX_PER_TYPE = Number(process.env.MAX_PER_TYPE || "8");
const MAX_TOTAL_PER_BRAND = Number(process.env.MAX_TOTAL_PER_BRAND || "50");
const ONLY_MONITOR_ID = process.env.ONLY_MONITOR_ID
  ? Number(process.env.ONLY_MONITOR_ID)
  : null;

const pool = new Pool({ connectionString: DATABASE_URL });

// ──────────────────────────────────────────────────────────────────────────
// URL classifier — patterns shared across brands. Order matters: more
// specific rules first.
// ──────────────────────────────────────────────────────────────────────────

const CLASSIFIERS = [
  // Account / auth
  { type: "login", patterns: [/\/login\b/i, /\/iniciar-sesion\b/i, /\/sign-in\b/i, /\/signin\b/i] },
  { type: "account", patterns: [/\/(mi-cuenta|account|mon-compte|conta|minha-conta)\b/i] },
  { type: "cart", patterns: [/\/(carrito|carro|cart|panier|cesto)\b/i] },
  { type: "checkout", patterns: [/\/(checkout|comprar|finalizar|paiement)\b/i] },
  // Search
  { type: "search", patterns: [/\/(buscar|search|recherche|pesquisa|busqueda)\b/i, /[?&]q=/i, /[?&]search=/i] },
  // Help / contact
  { type: "help", patterns: [/\/(ayuda|help|aide|ajuda|faq|contact|contacto|consultorio)\b/i] },
  // Legal
  { type: "legal", patterns: [/\/(privacidad|privacy|terminos|terms|cookies|aviso-legal|legal|condiciones|conditions)\b/i] },
  // Blog / content
  { type: "blog", patterns: [/\/(blog|articulos|artigos|conseils|consejos|noticias|news)\b/i] },
  // Brand-specific landing
  { type: "brand", patterns: [/\/(marcas|brand|brands|marca)\b/i] },
  // Promo / black friday / specials = treat as plp
  { type: "plp", patterns: [/\/(ofertas|sales|promo|black-friday|cyber|outlet|especial|rebajas|saldos)\b/i] },
];

// PDP detection: paths ending in something that LOOKS like a SKU or has
// .html / .htm at the end, or has digits in the last segment after a
// dash. We treat that as PDP for retail-style sites.
const PDP_REGEX = /(\.html?|-\d{3,}|\/p\/\d+)$/i;

// PLP detection (default fallback for anything in a category-like path).
// Most retail sitemaps put categories under a flat segment without a
// terminal dot/sku, so anything that doesn't match other rules and has at
// least one slash beyond the host counts as PLP.
function classifyUrl(pathname) {
  if (pathname === "/" || pathname === "") return "home";

  for (const c of CLASSIFIERS) {
    for (const p of c.patterns) {
      if (p.test(pathname)) return c.type;
    }
  }

  if (PDP_REGEX.test(pathname)) return "pdp";

  // Anything else with a meaningful path is a category-ish PLP
  if (pathname.split("/").filter(Boolean).length >= 1) return "plp";

  return "other";
}

// ──────────────────────────────────────────────────────────────────────────
// Sitemap fetching (handles sitemap index files recursively)
// ──────────────────────────────────────────────────────────────────────────

function fetchText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.get(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; IskayPet-Lighthouse-Targets/1.0)" },
        timeout: 30_000,
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          fetchText(next, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
    } catch (err) {
      reject(err);
    }
  });
}

function extractTagValues(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

// Recursively follow sitemap index files; return a flat list of URLs.
async function fetchAllUrls(rootSitemap, hardCap = 5000) {
  const seen = new Set();
  const urls = [];
  const queue = [rootSitemap];

  while (queue.length > 0 && urls.length < hardCap) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);

    let xml;
    try {
      xml = await fetchText(sm);
    } catch (err) {
      console.error(`  ! Could not fetch ${sm}: ${err.message}`);
      continue;
    }

    // Sitemap index? Then enqueue children.
    if (xml.includes("<sitemapindex")) {
      const childSitemaps = extractTagValues(xml, "loc");
      for (const child of childSitemaps) {
        if (!seen.has(child)) queue.push(child);
      }
      continue;
    }

    // Plain urlset
    const locs = extractTagValues(xml, "loc");
    for (const loc of locs) {
      urls.push(loc);
      if (urls.length >= hardCap) break;
    }
  }

  return urls;
}

// ──────────────────────────────────────────────────────────────────────────
// Sampling — pick N urls per page_type with a stable hash so the same URLs
// are chosen across weeks (so trends are meaningful).
// ──────────────────────────────────────────────────────────────────────────

function stableHash(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);
}

function sampleByType(urls, baseUrl) {
  // Group by page_type
  const byType = new Map();
  for (const fullUrl of urls) {
    let pathname;
    try {
      pathname = new URL(fullUrl).pathname || "/";
    } catch {
      continue;
    }
    const type = classifyUrl(pathname);
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(pathname);
  }

  const out = [];

  // For unique-per-brand types, keep all (caps at 1-2 anyway by nature).
  const SINGLETON_TYPES = ["home", "login", "cart", "checkout", "account", "search", "help", "legal"];
  for (const t of SINGLETON_TYPES) {
    const list = byType.get(t) || [];
    const picked = list.slice(0, 2);
    for (const p of picked) out.push({ pathname: p, page_type: t, priority: t === "home" ? 1 : 3 });
  }

  // For sampled types, pick MAX_PER_TYPE using stable hash
  const SAMPLED_TYPES = ["plp", "pdp", "brand", "blog"];
  for (const t of SAMPLED_TYPES) {
    const list = byType.get(t) || [];
    if (list.length === 0) continue;
    // Stable sort by hash so the same items always come first
    const sorted = list
      .map((p) => ({ p, h: stableHash(p) }))
      .sort((a, b) => a.h.localeCompare(b.h))
      .map((x) => x.p);
    for (const p of sorted.slice(0, MAX_PER_TYPE)) {
      out.push({ pathname: p, page_type: t, priority: t === "plp" || t === "pdp" ? 2 : 3 });
    }
  }

  // Hard cap per brand
  return out.slice(0, MAX_TOTAL_PER_BRAND);
}

// ──────────────────────────────────────────────────────────────────────────
// Per-brand workflow
// ──────────────────────────────────────────────────────────────────────────

async function getMonitors() {
  if (ONLY_MONITOR_ID !== null) {
    const { rows } = await pool.query(
      `SELECT id, name, url FROM synthetic_monitors WHERE id = $1`,
      [ONLY_MONITOR_ID],
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT id, name, url FROM synthetic_monitors WHERE id IN (1,2,3,4,5) ORDER BY id`,
  );
  return rows;
}

function siteRoot(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

async function refreshMonitor(monitor) {
  const baseUrl = siteRoot(monitor.url);
  console.log(`\n=== ${monitor.name} (${baseUrl}) ===`);

  // Discover sitemap entrypoints from /robots.txt — most brands declare
  // multiple sitemaps (main catalog + blog + services).
  const sitemapUrls = await discoverSitemaps(baseUrl);
  if (sitemapUrls.length === 0) {
    console.log("  ! robots.txt has no Sitemap: directives, skipping");
    return { monitor: monitor.id, discovered: 0, upserted: 0 };
  }
  console.log(`  Sitemaps from robots.txt: ${sitemapUrls.length}`);
  for (const sm of sitemapUrls) console.log(`    - ${sm}`);

  // Fetch every sitemap (and recursively follow indexes) and unify URLs
  let urls = [];
  for (const sm of sitemapUrls) {
    try {
      const found = await fetchAllUrls(sm, 5000);
      urls = urls.concat(found);
    } catch (err) {
      console.error(`  ! ${sm} failed: ${err.message}`);
    }
  }
  // De-duplicate
  urls = Array.from(new Set(urls));
  console.log(`  Found ${urls.length} unique URLs across all sitemaps`);

  if (urls.length === 0) {
    console.log("  Skipping; no URLs to upsert");
    return { monitor: monitor.id, discovered: 0, upserted: 0 };
  }

  const sampled = sampleByType(urls, baseUrl);
  console.log(`  Sampled ${sampled.length} URLs across ${new Set(sampled.map((s) => s.page_type)).size} page types`);

  // Upsert into DB
  let upserted = 0;
  for (const item of sampled) {
    try {
      await pool.query(
        `INSERT INTO lighthouse_targets (monitor_id, route, page_type, priority, source, last_seen_at)
         VALUES ($1, $2, $3, $4, 'sitemap', NOW())
         ON CONFLICT (monitor_id, route) DO UPDATE SET
           page_type = EXCLUDED.page_type,
           priority = LEAST(lighthouse_targets.priority, EXCLUDED.priority),
           last_seen_at = NOW(),
           enabled = TRUE`,
        [monitor.id, item.pathname, item.page_type, item.priority],
      );
      upserted++;
    } catch (err) {
      console.error(`  ! Upsert failed for ${item.pathname}: ${err.message}`);
    }
  }

  // Soft-disable URLs we did NOT see in this run AND that came from sitemap
  // (we keep manual ones intact).
  await pool.query(
    `UPDATE lighthouse_targets
       SET enabled = FALSE
     WHERE monitor_id = $1
       AND source = 'sitemap'
       AND last_seen_at < NOW() - INTERVAL '14 days'`,
    [monitor.id],
  );

  return { monitor: monitor.id, discovered: urls.length, upserted };
}

/**
 * Read /robots.txt and extract all `Sitemap:` directives. Falls back to a
 * couple of common defaults (sitemap_index.xml, sitemap.xml) if robots.txt
 * is unreachable or has none.
 */
async function discoverSitemaps(baseUrl) {
  let robotsTxt = "";
  try {
    robotsTxt = await fetchText(`${baseUrl}/robots.txt`);
  } catch (err) {
    console.error(`  ! robots.txt fetch failed: ${err.message}`);
  }

  const declared = [];
  for (const line of robotsTxt.split(/\r?\n/)) {
    const m = line.match(/^\s*Sitemap:\s*(\S+)/i);
    if (m) declared.push(m[1]);
  }
  if (declared.length > 0) return declared;

  // Fallback: try the two most common locations
  const fallback = [
    `${baseUrl}/sitemap_index.xml`,
    `${baseUrl}/sitemap.xml`,
  ];
  for (const candidate of fallback) {
    try {
      await fetchText(candidate);
      return [candidate];
    } catch {
      /* try next */
    }
  }
  return [];
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Lighthouse Targets Refresher — ${new Date().toISOString()}`);
  console.log("=".repeat(60));

  const monitors = await getMonitors();
  console.log(`Monitors: ${monitors.map((m) => m.name).join(", ")}`);

  const results = [];
  for (const m of monitors) {
    const r = await refreshMonitor(m);
    results.push(r);
  }

  console.log("\n" + "=".repeat(60));
  console.log("Summary:");
  for (const r of results) {
    console.log(`  monitor_id=${r.monitor}  discovered=${r.discovered}  upserted=${r.upserted}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
