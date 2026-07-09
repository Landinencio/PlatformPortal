#!/usr/bin/env node
/**
 * MR Review Metrics Snapshot
 * 
 * Runs nightly. Fetches merged MRs from the last 2 days from GitLab,
 * calculates per-MR metrics, and stores them in PostgreSQL.
 *
 * Env vars:
 *   DATABASE_URL — PostgreSQL connection string
 *   GITLAB_TOKEN — GitLab personal access token
 *   GITLAB_URL — GitLab base URL (default: https://gitlab.com)
 */

const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_URL = process.env.GITLAB_URL || "https://gitlab.com";

const LOOKBACK_DAYS = 1; // Daily run
const PER_PAGE = 100;
const RATE_LIMIT_DELAY = 200; // ms between GitLab API calls
const DAY_MS = 24 * 60 * 60 * 1000;

// Backfill page walk — bounded exponential backoff for long bursts. `gitlabFetch`
// already honours 429 `Retry-After` internally; this is the extra safety net for
// repeated transient failures (null responses) over a massive one-off run
// (971 repos x multiple calls per MR). We retry the SAME page up to
// BACKFILL_MAX_RETRIES times with backoff = BASE * 2^(n-1) capped at CAP, then
// give up on that project and continue (never abort the whole backfill).
const BACKFILL_MAX_RETRIES = 5;
const BACKFILL_BACKOFF_BASE_MS = 500;
const BACKFILL_BACKOFF_CAP_MS = 30000;

// The DB pool is created lazily so that importing this module for unit/property
// tests (which only exercise the pure helpers below) never opens a connection.
let pool = null;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: DATABASE_URL });
  return pool;
}

/**
 * Compute `B` — the coverage limit of the per-MR detail history: the oldest
 * `merged_at` already present in `mr_review_metrics`. Backfill windows are
 * capped at `B` (see `resolveWindow`) so they never invade the range the daily
 * incremental cron already serves, which preserves the recent-range behaviour
 * by construction.
 *
 * Empty-table fallback: when the table holds no rows yet (`MIN` returns null)
 * there is no covered range to protect, so we fall back to the current date —
 * the backfill is then free to fetch everything from `BACKFILL_FROM` up to now.
 * When `BACKFILL_TO` is set it takes precedence over this value (resolveWindow
 * prefers `BACKFILL_TO`), so the fallback only matters for an open-ended
 * backfill against a still-empty table.
 *
 * @returns {Promise<Date>} the oldest stored merged_at, or today if the table is empty
 */
async function getCoverageStart() {
  const { rows } = await getPool().query(
    "SELECT MIN(merged_at)::date AS coverage_start FROM mr_review_metrics"
  );
  const value = rows[0] ? rows[0].coverage_start : null;
  return value ? new Date(value) : new Date();
}

/* ------------------------------------------------------------------ */
/* Pure helpers (exported, testable).                                 */
/* ------------------------------------------------------------------ */

/**
 * Resolve the time window the snapshot must cover for a given environment.
 *
 * - Backfill mode (one-off job): when `env.BACKFILL_FROM` (YYYY-MM-DD) is set,
 *   cover `[BACKFILL_FROM, BACKFILL_TO ?? coverageStart)`. `coverageStart` is
 *   `B` — the oldest `merged_at` already present in `mr_review_metrics` — so the
 *   backfill never invades the range already served (until <= B), preserving the
 *   behaviour of recent ranges by construction.
 * - Incremental mode (daily cron, default): cover the last `LOOKBACK_DAYS` days
 *   with `until = null`. Identical to today's behaviour — the daily cron is
 *   untouched when `BACKFILL_FROM` is absent.
 *
 * @param {Record<string, string|undefined>} env
 * @param {Date} [coverageStart] oldest merged_at currently stored (B)
 * @returns {{ since: (string|Date), until: (string|Date|null), mode: ('backfill'|'incremental') }}
 */
function resolveWindow(env, coverageStart) {
  env = env || {};
  if (env.BACKFILL_FROM) {
    return {
      since: env.BACKFILL_FROM,
      until: env.BACKFILL_TO != null ? env.BACKFILL_TO : coverageStart,
      mode: "backfill",
    };
  }
  return {
    since: new Date(Date.now() - LOOKBACK_DAYS * DAY_MS),
    until: null,
    mode: "incremental",
  };
}

/**
 * Plan the page walk needed to cover exactly `total` rows in pages of `limit`.
 *
 * Returns `totalPages = ceil(total / limit)` and one descriptor per page with
 * its 1-based `page`, zero-based `offset` and `count` (rows on that page). The
 * pages tile `[0, total)` with no gaps and no overlaps; the last page holds the
 * remainder. `total = 0` yields `totalPages = 0` and an empty plan.
 *
 * @param {number} total non-negative row count
 * @param {number} limit page size (> 0)
 * @returns {{ totalPages: number, pages: Array<{ page: number, offset: number, count: number }> }}
 */
function planPagination(total, limit) {
  const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
  const totalPages = Math.ceil(safeTotal / safeLimit);
  const pages = [];
  for (let page = 1; page <= totalPages; page++) {
    const offset = (page - 1) * safeLimit;
    const count = Math.min(safeLimit, safeTotal - offset);
    pages.push({ page, offset, count });
  }
  return { totalPages, pages };
}

/**
 * Coerce a window bound (a `Date` or a `"YYYY-MM-DD"` string) to a UTC
 * day-start `Date`. Backfill bounds arrive as ISO day strings (`BACKFILL_FROM`,
 * `BACKFILL_TO`) or as a `Date` (`coverageStart` = `B`); both must compare on
 * the same day-start basis.
 *
 * @param {Date|string} value
 * @returns {Date}
 */
function asDayStart(value) {
  if (value instanceof Date) return value;
  return new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
}

/**
 * Whether a GitLab MR's `merged_at` falls in the resolved window `[since, until)`.
 * `until = null` (incremental) means "no upper bound". GitLab exposes no
 * `merged_after`, so the backfill must filter `merged_at` client-side; this is
 * the predicate task 3.3's page walk applies to every fetched page.
 *
 * @param {{ merged_at: (string|null) }} mr
 * @param {{ since: (Date|string), until: (Date|string|null) }} timeWindow
 * @returns {boolean}
 */
function isMergedInWindow(mr, timeWindow) {
  if (!mr || !mr.merged_at) return false;
  const merged = new Date(mr.merged_at).getTime();
  const since = asDayStart(timeWindow.since).getTime();
  const until = timeWindow.until == null ? Infinity : asDayStart(timeWindow.until).getTime();
  return merged >= since && merged < until;
}

// Team mapping from project path
const TEAM_MAP = {
  "oms": "oms",
  "basket": "basket",
  "checkout": "checkout",
  "payments": "payments",
  "loyalty": "loyalty",
  "customers": "customers",
  "products": "products",
  "pricing": "pricing",
  "shipping": "shipping",
  "returns": "returns",
  "marketplace": "marketplace",
  "websites": "websites",
  "mobile": "mobile",
  "helios": "helios",
  "comerzzia": "comerzzia",
  "animalis": "animalis",
  "auth": "auth",
  "identifiers": "identifiers",
  "stores": "stores",
  "front-vue": "frontend",
  "sre-infra": "sre",
  "platform": "sre",
};

function detectTeam(projectPath) {
  const lower = projectPath.toLowerCase();
  // Resolve squad by walking the path segments left-to-right (parent groups first).
  // The team is owned by the parent group, not the leaf project name. Example:
  //   iskaypetcom/digital/marketplace/marketplace-products-api -> marketplace (NOT products)
  const segments = lower.split("/").filter(Boolean);
  for (const segment of segments) {
    if (TEAM_MAP[segment]) return TEAM_MAP[segment];
  }
  // Fallback: substring match on the full path (legacy behavior, last resort)
  for (const [key, team] of Object.entries(TEAM_MAP)) {
    if (lower.includes(key)) return team;
  }
  return "other";
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gitlabFetch(endpoint) {
  const url = `${GITLAB_URL}/api/v4${endpoint}`;
  const res = await fetch(url, {
    headers: { "PRIVATE-TOKEN": GITLAB_TOKEN },
  });
  if (!res.ok) {
    if (res.status === 429) {
      // Rate limited — wait and retry
      const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
      console.log(`  Rate limited, waiting ${retryAfter}s...`);
      await sleep(retryAfter * 1000);
      return gitlabFetch(endpoint);
    }
    return null;
  }
  await sleep(RATE_LIMIT_DELAY);
  return res.json();
}

async function getActiveProjects() {
  // Get ALL projects from GitLab group (not just those with DORA data)
  const projects = [];
  let page = 1;
  const GROUP_ID = "iskaypetcom"; // Top-level group

  while (true) {
    const batch = await gitlabFetch(
      `/groups/${GROUP_ID}/projects?include_subgroups=true&per_page=100&page=${page}&order_by=last_activity_at&sort=desc&with_merge_requests_enabled=true`
    );
    if (!batch || batch.length === 0) break;

    for (const p of batch) {
      // Skip archived or empty repos
      if (p.archived) continue;
      projects.push({
        project_id: p.id,
        project_path: p.path_with_namespace,
        team: detectTeam(p.path_with_namespace),
      });
    }

    if (batch.length < 100) break;
    page++;
  }

  console.log(`Found ${projects.length} active GitLab projects`);
  return projects;
}

async function getMergedMRs(projectId, timeWindow) {
  // Backfill mode (one-off job): delegate to the paginated fetch path.
  if (timeWindow && timeWindow.mode === "backfill") {
    return getMergedMRsBackfill(projectId, timeWindow);
  }
  // Incremental mode (daily cron, default) — UNCHANGED behaviour. The window is
  // the last LOOKBACK_DAYS days; a single page of recently-updated merged MRs.
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const mrs = await gitlabFetch(
    `/projects/${projectId}/merge_requests?state=merged&updated_after=${since}&per_page=${PER_PAGE}&order_by=updated_at&sort=desc`
  );
  return mrs || [];
}

/**
 * Backfill fetch path (one-off job) — walk EVERY page of merged MRs and filter
 * client-side by `merged_at ∈ [since, until)`.
 *
 * Pagination: reuses the page-loop pattern from `getActiveProjects` — increment
 * `page` until a batch comes back empty or shorter than `PER_PAGE` (the last
 * page). The query is bounded server-side by `updated_after=<since>`, and the
 * results are ordered `updated_at desc`.
 *
 * Client-side filter: GitLab exposes no `merged_after`, so `isMergedInWindow`
 * keeps only MRs whose `merged_at` falls in `[since, until)`. This is required
 * because `updated_after` filters on `updated_at`, NOT `merged_at`: an MR merged
 * before `since` can still be returned if it was updated later (e.g. a comment).
 *
 * NO early-stop: because the query is already bounded by `updated_after=since`,
 * there is no "older than since" tail of pages to skip; and `merged_at` is NOT
 * monotonic with the `updated_at desc` ordering (a late-updated MR can have an
 * old `merged_at`), so no page-level `merged_at` early-stop is provably safe.
 * We therefore walk all pages.
 *
 * Resilience: `gitlabFetch` already retries 429s honouring `Retry-After`. On
 * other transient failures (null response / thrown error) we apply a bounded
 * exponential backoff and retry the same page up to `BACKFILL_MAX_RETRIES`
 * times; past that we log, give up on this project and return what we collected
 * so a single project failure never aborts the whole backfill. The upsert in
 * `storeMR` (`ON CONFLICT (project_id, mr_iid) DO UPDATE`) makes a re-run
 * idempotent, so resuming from scratch never duplicates rows.
 *
 * @param {number} projectId
 * @param {{ since: (Date|string), until: (Date|string|null), mode: string }} timeWindow
 * @returns {Promise<Array>}
 */
async function getMergedMRsBackfill(projectId, timeWindow) {
  const since = asDayStart(timeWindow.since).toISOString();
  const collected = [];
  let page = 1;
  let consecutiveFailures = 0;

  while (true) {
    let batch;
    try {
      batch = await gitlabFetch(
        `/projects/${projectId}/merge_requests?state=merged&updated_after=${since}&per_page=${PER_PAGE}&page=${page}&order_by=updated_at&sort=desc`
      );
    } catch (err) {
      // Network/transport error — treat like a transient failure (backoff below).
      console.error(
        `  Backfill fetch error (project ${projectId}, page ${page}): ${err.message?.slice(0, 100)}`
      );
      batch = null;
    }

    if (batch == null) {
      // `gitlabFetch` returns null on non-429 HTTP errors (429s are retried
      // inside it). Bounded exponential backoff for long bursts, then give up on
      // this project and continue with what we have.
      consecutiveFailures++;
      if (consecutiveFailures > BACKFILL_MAX_RETRIES) {
        console.error(
          `  Backfill: giving up on project ${projectId} at page ${page} after ${BACKFILL_MAX_RETRIES} retries`
        );
        break;
      }
      const backoff = Math.min(
        BACKFILL_BACKOFF_CAP_MS,
        BACKFILL_BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1)
      );
      console.log(
        `  Backfill: transient failure on project ${projectId} page ${page}, backing off ${backoff}ms (retry ${consecutiveFailures}/${BACKFILL_MAX_RETRIES})`
      );
      await sleep(backoff);
      continue; // retry the SAME page
    }

    consecutiveFailures = 0; // reset the backoff streak on any successful fetch

    if (batch.length === 0) break;

    for (const mr of batch) {
      if (isMergedInWindow(mr, timeWindow)) collected.push(mr);
    }

    // Last page reached when GitLab returns fewer than a full page.
    if (batch.length < PER_PAGE) break;
    page++;
  }

  return collected;
}

async function getMRCommits(projectId, mrIid) {
  const commits = await gitlabFetch(
    `/projects/${projectId}/merge_requests/${mrIid}/commits?per_page=100`
  );
  return commits || [];
}

async function getMRNotes(projectId, mrIid) {
  const notes = await gitlabFetch(
    `/projects/${projectId}/merge_requests/${mrIid}/notes?per_page=100`
  );
  if (!notes) return [];
  // Filter to only human comments (not system notes)
  return notes.filter((n) => !n.system);
}

async function processMR(project, mr) {
  // Get commits for time-to-PR
  const commits = await getMRCommits(project.project_id, mr.iid);
  const firstCommitAt = commits.length > 0
    ? commits[commits.length - 1].created_at // Last in array = oldest
    : null;

  // Get notes for comment count
  const notes = await getMRNotes(project.project_id, mr.iid);

  // Get MR detail for lines added/removed (not available in list endpoint)
  const mrDetail = await gitlabFetch(
    `/projects/${project.project_id}/merge_requests/${mr.iid}?include_diverged_commits_count=false`
  );

  // Calculate metrics
  const createdAt = new Date(mr.created_at);
  const mergedAt = mr.merged_at ? new Date(mr.merged_at) : null;
  const firstCommit = firstCommitAt ? new Date(firstCommitAt) : null;

  const timeToPrHours = firstCommit
    ? Math.max(0, (createdAt.getTime() - firstCommit.getTime()) / (1000 * 60 * 60))
    : null;

  const reviewTimeHours = mergedAt
    ? Math.max(0, (mergedAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60))
    : null;

  // Reviewers count from the MR data
  const reviewerCount = (mr.reviewers || []).length;

  // Lines from detail endpoint
  const linesAdded = mrDetail?.changes_count 
    ? parseInt(mrDetail.changes_count, 10) 
    : (mrDetail?.diff_stats?.additions || 0);
  const linesRemoved = mrDetail?.diff_stats?.deletions || 0;

  return {
    project_id: project.project_id,
    project_path: project.project_path,
    team: project.team || detectTeam(project.project_path),
    mr_iid: mr.iid,
    mr_title: (mr.title || "").slice(0, 500),
    mr_url: mr.web_url,
    author_username: mr.author?.username || "unknown",
    author_name: mr.author?.name || mr.author?.username || "unknown",
    target_branch: mr.target_branch || "main",
    created_at: mr.created_at,
    merged_at: mr.merged_at,
    first_commit_at: firstCommitAt,
    time_to_pr_hours: timeToPrHours !== null ? Math.round(timeToPrHours * 100) / 100 : null,
    review_time_hours: reviewTimeHours !== null ? Math.round(reviewTimeHours * 100) / 100 : null,
    commit_count: commits.length,
    comment_count: notes.length,
    reviewer_count: reviewerCount,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
  };
}

async function storeMR(metrics) {
  try {
    await getPool().query(`
      INSERT INTO mr_review_metrics 
        (project_id, project_path, team, mr_iid, mr_title, mr_url,
         author_username, author_name, target_branch, created_at, merged_at,
         first_commit_at, time_to_pr_hours, review_time_hours,
         commit_count, comment_count, reviewer_count, lines_added, lines_removed, snapshot_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, CURRENT_DATE)
      ON CONFLICT (project_id, mr_iid) DO UPDATE SET
        mr_title = EXCLUDED.mr_title,
        merged_at = EXCLUDED.merged_at,
        first_commit_at = EXCLUDED.first_commit_at,
        time_to_pr_hours = EXCLUDED.time_to_pr_hours,
        review_time_hours = EXCLUDED.review_time_hours,
        commit_count = EXCLUDED.commit_count,
        comment_count = EXCLUDED.comment_count,
        reviewer_count = EXCLUDED.reviewer_count,
        lines_added = EXCLUDED.lines_added,
        lines_removed = EXCLUDED.lines_removed,
        snapshot_date = CURRENT_DATE
    `, [
      metrics.project_id, metrics.project_path, metrics.team,
      metrics.mr_iid, metrics.mr_title, metrics.mr_url,
      metrics.author_username, metrics.author_name, metrics.target_branch,
      metrics.created_at, metrics.merged_at, metrics.first_commit_at,
      metrics.time_to_pr_hours, metrics.review_time_hours,
      metrics.commit_count, metrics.comment_count, metrics.reviewer_count,
      metrics.lines_added, metrics.lines_removed,
    ]);
    return true;
  } catch (err) {
    console.error(`  DB error for MR !${metrics.mr_iid}: ${err.message?.slice(0, 100)}`);
    return false;
  }
}

async function main() {
  if (!DATABASE_URL || !GITLAB_TOKEN) {
    console.error("DATABASE_URL and GITLAB_TOKEN are required");
    process.exit(1);
  }

  console.log(`MR Review Metrics Snapshot — ${new Date().toISOString().slice(0, 10)}`);
  console.log("=".repeat(50));

  // Resolve the time window. Compute B (coverageStart) ONLY in backfill mode so
  // the daily incremental run issues no extra query and stays byte-for-byte
  // equivalent to today.
  const isBackfill = !!process.env.BACKFILL_FROM;
  const coverageStart = isBackfill ? await getCoverageStart() : null;
  const timeWindow = resolveWindow(process.env, coverageStart);

  if (timeWindow.mode === "backfill") {
    const sinceLabel = asDayStart(timeWindow.since).toISOString().slice(0, 10);
    const untilLabel =
      timeWindow.until == null ? "now" : asDayStart(timeWindow.until).toISOString().slice(0, 10);
    console.log(`Mode: backfill — window [${sinceLabel}, ${untilLabel}) (B=${untilLabel})`);
  } else {
    console.log(`Mode: incremental — lookback ${LOOKBACK_DAYS}d`);
  }

  const projects = await getActiveProjects();
  console.log(`Active projects: ${projects.length}`);

  let totalMRs = 0;
  let totalStored = 0;

  for (const project of projects) {
    let mrs;
    try {
      mrs = await getMergedMRs(project.project_id, timeWindow);
    } catch (err) {
      // A single project must never abort the whole run (matters most for the
      // massive backfill). Log and move on.
      console.error(
        `  Project error for ${project.project_path}: ${err.message?.slice(0, 100)}`
      );
      continue;
    }
    if (mrs.length === 0) continue;

    console.log(`\n${project.project_path}: ${mrs.length} merged MRs`);

    for (const mr of mrs) {
      try {
        // Skip if already processed and not recently updated
        const metrics = await processMR(project, mr);
        const stored = await storeMR(metrics);
        if (stored) totalStored++;
        totalMRs++;
      } catch (err) {
        // Per-MR failure (e.g. a transient fetch error inside processMR) must
        // not abort the project or the backfill — capture and continue.
        console.error(
          `  MR error for ${project.project_path} !${mr.iid}: ${err.message?.slice(0, 100)}`
        );
      }
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Done. Processed ${totalMRs} MRs, stored ${totalStored}.`);
  await getPool().end();
}

// Only run the snapshot when invoked directly (e.g. `node mr-metrics-snapshot.js`).
// When the module is imported (unit/property tests via the `src/lib/__tests__`
// glob), the pure helpers are exported without triggering `main()`.
if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = {
  resolveWindow,
  planPagination,
  detectTeam,
  LOOKBACK_DAYS,
};
