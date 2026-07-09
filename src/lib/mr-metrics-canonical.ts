/**
 * Canonical MR-metrics aggregation helpers.
 *
 * The `gitlab_mr_analytics` table stores ONE ROW PER MR PER DAY (the
 * `mr-metrics-snapshot` cron re-upserts every MR of the last 90 days on every
 * run). Any metric that counts rows over a `snapshot_date` window therefore
 * multiplies each MR by the number of snapshots it appears in, and any metric
 * that filters by `snapshot_date` (instead of when the MR actually merged)
 * silently widens a "one week" window to the whole 90-day backlog.
 *
 * The canonical semantics — identical to `latestMrCte` in metrics-dashboard.ts —
 * are:
 *   1. Deduplicate to the most recent snapshot row per (project_id, mr_iid).
 *   2. Derive `reference_at` = merged_at when merged, else created_at.
 *   3. Window merged activity by `reference_at`, not `snapshot_date`.
 *
 * This module isolates that logic as pure functions so it can be unit-tested
 * (counting 9 MRs present in N snapshots yields 9, never 9 × N).
 */

export interface CanonicalMrRow {
  projectId: number;
  mrIid: number;
  team: string | null;
  title: string | null;
  state: string | null;
  authorUsername: string | null;
  authorName: string | null;
  authorAvatarUrl: string | null;
  projectName: string | null;
  webUrl: string | null;
  createdAt: Date | string | null;
  mergedAt: Date | string | null;
  snapshotDate: Date | string;
  lifetimeHours: number | null;
  reviewTimeHours: number | null;
  reviewers: unknown;
}

export interface TeamActivityRecentMr {
  title: string;
  projectName: string;
  mergedAt: string;
  lifetimeHours: number;
  webUrl: string | null;
}

export interface TeamActivityContributor {
  username: string;
  name: string;
  avatarUrl: string | null;
  teams: string[];
  mrsMerged: number;
  mrsOpen: number;
  reviewsGiven: number;
  avgTimeToMergeHours: number;
  avgReviewTimeHours: number;
  lastMergedAt: string | null;
  recentMRs: TeamActivityRecentMr[];
}

export interface TeamActivitySummary {
  totalMRsMerged: number;
  totalMRsOpen: number;
  totalReviews: number;
  activeContributors: number;
  avgTimeToMergeHours: number;
}

export interface TeamActivityResult {
  summary: TeamActivitySummary;
  contributors: TeamActivityContributor[];
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isDraft(title: string | null): boolean {
  if (!title) return false;
  const normalized = title.toLowerCase();
  return normalized.startsWith("draft:") || normalized.startsWith("wip:");
}

/** reference_at = merged_at when the MR is merged, otherwise created_at. */
export function referenceAt(row: CanonicalMrRow): Date | null {
  if (row.state === "merged") {
    const merged = toDate(row.mergedAt);
    if (merged) return merged;
  }
  return toDate(row.createdAt);
}

/**
 * Deduplicate to the most recent snapshot per (project_id, mr_iid).
 * Mirrors `SELECT DISTINCT ON (project_id, mr_iid) ... ORDER BY snapshot_date DESC`.
 */
export function dedupeLatestByMr(rows: CanonicalMrRow[]): CanonicalMrRow[] {
  const latest = new Map<string, CanonicalMrRow>();
  for (const row of rows) {
    const key = `${row.projectId}:${row.mrIid}`;
    const current = latest.get(key);
    if (!current) {
      latest.set(key, row);
      continue;
    }
    const candidate = toDate(row.snapshotDate)?.getTime() ?? -Infinity;
    const incumbent = toDate(current.snapshotDate)?.getTime() ?? -Infinity;
    if (candidate >= incumbent) latest.set(key, row);
  }
  return [...latest.values()];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function extractReviewerUsernames(reviewers: unknown): string[] {
  if (!Array.isArray(reviewers)) return [];
  const usernames: string[] = [];
  for (const entry of reviewers) {
    if (entry && typeof entry === "object" && "username" in entry) {
      const username = (entry as { username?: unknown }).username;
      if (typeof username === "string" && username) usernames.push(username);
    }
  }
  return usernames;
}

/**
 * Aggregate team activity using canonical semantics.
 *
 * - Merged counts/averages are windowed by `reference_at` ∈ [windowStart, windowEnd].
 * - Open counts reflect the CURRENT open set (latest snapshot state === 'opened'),
 *   independent of the window — matching the manager dashboard.
 * - Every count deduplicates by (project_id, mr_iid) first, so an MR present in
 *   N snapshots is counted once.
 */
export function aggregateTeamActivity(
  rows: CanonicalMrRow[],
  windowStart: Date,
  windowEnd: Date
): TeamActivityResult {
  const latest = dedupeLatestByMr(rows);
  const startMs = windowStart.getTime();
  const endMs = windowEnd.getTime();

  type Acc = {
    username: string;
    name: string;
    avatarUrl: string | null;
    teams: Set<string>;
    mrsMerged: number;
    mrsOpen: number;
    reviewsGiven: number;
    lifetimeSum: number;
    lifetimeCount: number;
    reviewTimeSum: number;
    reviewTimeCount: number;
    lastMergedAt: Date | null;
    recentMRs: Array<{ row: CanonicalMrRow; mergedAt: Date }>;
  };

  const byAuthor = new Map<string, Acc>();
  const ensure = (username: string): Acc => {
    let acc = byAuthor.get(username);
    if (!acc) {
      acc = {
        username,
        name: "",
        avatarUrl: null,
        teams: new Set(),
        mrsMerged: 0,
        mrsOpen: 0,
        reviewsGiven: 0,
        lifetimeSum: 0,
        lifetimeCount: 0,
        reviewTimeSum: 0,
        reviewTimeCount: 0,
        lastMergedAt: null,
        recentMRs: [],
      };
      byAuthor.set(username, acc);
    }
    return acc;
  };

  for (const row of latest) {
    const author = row.authorUsername || "";

    // Open MRs: current open set, not windowed.
    if (row.state === "opened" && author) {
      ensure(author).mrsOpen += 1;
    }

    if (row.state !== "merged") continue;

    const ref = referenceAt(row);
    if (!ref) continue;
    const refMs = ref.getTime();
    if (refMs < startMs || refMs > endMs) continue;

    // Merged within window — count once (already deduped).
    if (author) {
      const acc = ensure(author);
      acc.mrsMerged += 1;
      if (row.authorName) acc.name = row.authorName;
      if (row.authorAvatarUrl) acc.avatarUrl = row.authorAvatarUrl;
      if (row.team) acc.teams.add(row.team);

      const merged = toDate(row.mergedAt);
      if (merged && (!acc.lastMergedAt || merged > acc.lastMergedAt)) {
        acc.lastMergedAt = merged;
      }
      if (merged) {
        acc.recentMRs.push({ row, mergedAt: merged });
      }

      if (!isDraft(row.title)) {
        if (row.lifetimeHours != null && Number.isFinite(row.lifetimeHours)) {
          acc.lifetimeSum += row.lifetimeHours;
          acc.lifetimeCount += 1;
        }
        if (row.reviewTimeHours != null && Number.isFinite(row.reviewTimeHours)) {
          acc.reviewTimeSum += row.reviewTimeHours;
          acc.reviewTimeCount += 1;
        }
      }
    }

    // Reviews given: one per merged MR per distinct reviewer (excluding self).
    const reviewers = new Set(extractReviewerUsernames(row.reviewers));
    for (const reviewer of reviewers) {
      if (reviewer === author) continue;
      ensure(reviewer).reviewsGiven += 1;
    }
  }

  const contributors: TeamActivityContributor[] = [...byAuthor.values()]
    .filter((acc) => acc.username)
    .map((acc) => {
      const recentMRs = acc.recentMRs
        .sort((a, b) => b.mergedAt.getTime() - a.mergedAt.getTime())
        .slice(0, 5)
        .map(({ row, mergedAt }) => ({
          title: row.title || "",
          projectName: row.projectName || "",
          mergedAt: mergedAt.toISOString(),
          lifetimeHours: Number(row.lifetimeHours) || 0,
          webUrl: row.webUrl || null,
        }));

      return {
        username: acc.username,
        name: acc.name,
        avatarUrl: acc.avatarUrl || null,
        teams: [...acc.teams],
        mrsMerged: acc.mrsMerged,
        mrsOpen: acc.mrsOpen,
        reviewsGiven: acc.reviewsGiven,
        avgTimeToMergeHours: acc.lifetimeCount > 0 ? round1(acc.lifetimeSum / acc.lifetimeCount) : 0,
        avgReviewTimeHours: acc.reviewTimeCount > 0 ? round1(acc.reviewTimeSum / acc.reviewTimeCount) : 0,
        lastMergedAt: acc.lastMergedAt ? acc.lastMergedAt.toISOString() : null,
        recentMRs,
      };
    })
    .sort((a, b) => b.mrsMerged - a.mrsMerged);

  const totalMRsMerged = contributors.reduce((sum, c) => sum + c.mrsMerged, 0);
  const totalMRsOpen = contributors.reduce((sum, c) => sum + c.mrsOpen, 0);
  const totalReviews = contributors.reduce((sum, c) => sum + c.reviewsGiven, 0);
  const activeContributors = contributors.filter((c) => c.mrsMerged > 0 || c.reviewsGiven > 0).length;
  const mergedContributors = contributors.filter((c) => c.mrsMerged > 0);
  const avgTimeToMergeHours =
    mergedContributors.length > 0
      ? round1(mergedContributors.reduce((sum, c) => sum + c.avgTimeToMergeHours, 0) / mergedContributors.length)
      : 0;

  return {
    summary: {
      totalMRsMerged,
      totalMRsOpen,
      totalReviews,
      activeContributors,
      avgTimeToMergeHours,
    },
    contributors,
  };
}
