/**
 * DORA author-scoping — pure functions.
 *
 * Concentrates all the DORA author-attribution logic that is testable by
 * properties, with NO database dependencies: it receives rows already read
 * from `deployment_changes` (joined to `production_deployments`) and returns
 * pure structures. Follows the pattern of `mr-metrics-canonical.ts` (dedup /
 * identity logic isolated as pure, property-testable functions).
 *
 * Author identity is resolved REUSING the very same helpers as the MR side —
 * `resolveAuthorIdentitySeed` (@/lib/dashboard-utils) builds the identity seed
 * and `mergeDevelopersByIdentity` (@/lib/developer-identity) fuses commit-email
 * ↔ gitlab-username variants into a single `canonicalKey`. This guarantees that
 * a developer using different commit emails is not duplicated, consistently
 * with the manager/MR dashboard.
 */

import {
  mergeDevelopersByIdentity,
  type MergedDeveloperIdentity,
} from "@/lib/developer-identity";
import {
  resolveAuthorIdentitySeed,
  sanitizeDeveloperEmail,
} from "@/lib/dashboard-utils";

/**
 * The sentinel seed produced by `resolveAuthorIdentitySeed` when neither a
 * commit-email nor a username is available. Rows resolving to this seed have
 * unresolvable authorship and are excluded from author grouping / matching.
 */
const UNRESOLVED_SEED = "unknown@unknown.local";

/** Raw deployment-change row (subset of `deployment_changes` + join). */
export interface DeploymentChangeRow {
  deploymentId: number;
  /** DATE(pd.deploy_completed_at) as YYYY-MM-DD (the correct deploy date). */
  deployDate: string;
  commitSha: string | null;
  commitCreatedAt: Date | string | null;
  mrFirstCommitAt: Date | string | null;
  deployCompletedAt: Date | string | null;
  authorEmail: string | null;
  /** Optional username if the MR join provides it; usually null in deployment_changes. */
  authorUsername: string | null;
}

/** A deployment with its canonical authorship resolved and deduplicated. */
export interface DeploymentAuthorship {
  deploymentId: number;
  deployDate: string;
  /** Distinct canonical keys of the deployment's resolvable authors. */
  authorKeys: Set<string>;
  /** true if the deployment has no change with a resolvable identity. */
  unresolved: boolean;
}

/** Normalized canonical key of an author (for Author_Filter and dedup). */
export type CanonicalAuthorKey = string;

/**
 * Build a deterministic map from identity seed (sanitized email) to the
 * canonical key of the merged identity it belongs to.
 *
 * The seeds fed to `mergeDevelopersByIdentity` are deduplicated and sorted so
 * the merge result is independent of the input row order.
 */
function buildSeedToCanonicalKey(
  rows: DeploymentChangeRow[]
): Map<string, CanonicalAuthorKey> {
  const seeds = new Set<string>();
  for (const row of rows) {
    seeds.add(resolveAuthorIdentitySeed(row.authorEmail, row.authorUsername));
  }
  const merged = mergeDevelopersByIdentity(
    [...seeds].sort().map((email) => ({ email }))
  );
  const seedToKey = new Map<string, CanonicalAuthorKey>();
  for (const identity of merged) {
    for (const email of identity.allEmails) {
      seedToKey.set(sanitizeDeveloperEmail(email), identity.canonicalKey);
    }
  }
  return seedToKey;
}

/**
 * Resolve the canonical identity of each row using the seed shared with MR and
 * the identity fusion. Deterministic and independent of the input order. Rows
 * without a resolvable email/username are mapped to `null` (unresolvable
 * authorship).
 */
export function resolveChangeAuthorKeys(
  rows: DeploymentChangeRow[]
): Map<DeploymentChangeRow, CanonicalAuthorKey | null> {
  const seedToKey = buildSeedToCanonicalKey(rows);
  const result = new Map<DeploymentChangeRow, CanonicalAuthorKey | null>();
  for (const row of rows) {
    const seed = resolveAuthorIdentitySeed(row.authorEmail, row.authorUsername);
    if (seed === UNRESOLVED_SEED) {
      result.set(row, null);
      continue;
    }
    result.set(row, seedToKey.get(seed) ?? seed);
  }
  return result;
}

/**
 * Group changes by `deploymentId` and deduplicate authors by canonical key.
 * N equivalent rows (same deployment, same identity) collapse to a single
 * author. A deployment is marked `unresolved` when none of its changes resolve.
 * The result is deterministically ordered by `(deploymentId, deployDate)`.
 */
export function buildDeploymentAuthorship(
  rows: DeploymentChangeRow[]
): DeploymentAuthorship[] {
  const keyByRow = resolveChangeAuthorKeys(rows);
  const byDeployment = new Map<
    number,
    { deployDate: string; authorKeys: Set<CanonicalAuthorKey> }
  >();

  for (const row of rows) {
    let entry = byDeployment.get(row.deploymentId);
    if (!entry) {
      entry = { deployDate: row.deployDate, authorKeys: new Set() };
      byDeployment.set(row.deploymentId, entry);
    }
    const key = keyByRow.get(row);
    if (key !== null && key !== undefined) {
      entry.authorKeys.add(key);
    }
  }

  return [...byDeployment.entries()]
    .map(([deploymentId, entry]) => ({
      deploymentId,
      deployDate: entry.deployDate,
      authorKeys: entry.authorKeys,
      unresolved: entry.authorKeys.size === 0,
    }))
    .sort(
      (a, b) =>
        a.deploymentId - b.deploymentId ||
        a.deployDate.localeCompare(b.deployDate)
    );
}

/**
 * Normalize an Author_Filter to its set of canonical keys (order-insensitive,
 * no duplicates). Empty input ⇒ empty Set.
 */
export function normalizeAuthorFilter(
  authors: string[]
): Set<CanonicalAuthorKey> {
  const filter = new Set<CanonicalAuthorKey>();
  for (const author of authors ?? []) {
    const trimmed = (author ?? "").trim();
    if (trimmed) filter.add(trimmed);
  }
  return filter;
}

/**
 * Selectable canonical authors derived from the changes' authorship: the merged
 * `MergedDeveloperIdentity` list, without duplicates by `canonicalKey` and in a
 * deterministic order. Unresolvable rows are excluded.
 */
export function listSelectableAuthors(
  rows: DeploymentChangeRow[]
): MergedDeveloperIdentity[] {
  const seeds = new Set<string>();
  for (const row of rows) {
    const seed = resolveAuthorIdentitySeed(row.authorEmail, row.authorUsername);
    if (seed !== UNRESOLVED_SEED) seeds.add(seed);
  }
  const merged = mergeDevelopersByIdentity(
    [...seeds].sort().map((email) => ({ email }))
  );
  const byKey = new Map<CanonicalAuthorKey, MergedDeveloperIdentity>();
  for (const identity of merged) {
    if (identity.email === UNRESOLVED_SEED) continue;
    if (!byKey.has(identity.canonicalKey)) {
      byKey.set(identity.canonicalKey, identity);
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.canonicalKey.localeCompare(b.canonicalKey) ||
      a.email.localeCompare(b.email)
  );
}

// ---------------------------------------------------------------------------
// Task 1.2 (predicate, attributed DF, author lead times, median, coverage,
// cache-key helpers) appends below this line.
// ---------------------------------------------------------------------------

/**
 * Membership predicate: does the change's canonical identity belong to the
 * filter? Returns true iff `authorKey` is non-null and matches at least one
 * canonical key in `filter`. An empty filter or a `null` key ⇒ false.
 */
export function changeBelongsToAuthorFilter(
  authorKey: CanonicalAuthorKey | null,
  filter: Set<CanonicalAuthorKey>
): boolean {
  if (authorKey === null || authorKey === undefined) return false;
  return filter.has(authorKey);
}

/**
 * Attributed Deployment Frequency: counts each deployment EXACTLY ONCE when it
 * includes at least one change whose canonical identity belongs to the filter,
 * regardless of how many matching changes it contains. Because authorship is
 * already deduplicated per deployment by canonical key, the count is invariant
 * to duplicating equivalent rows in `deployment_changes`. An empty filter ⇒ 0.
 */
export function countAttributedDeployments(
  authorship: DeploymentAuthorship[],
  filter: Set<CanonicalAuthorKey>
): number {
  if (filter.size === 0) return 0;
  let count = 0;
  for (const deployment of authorship) {
    for (const key of deployment.authorKeys) {
      if (filter.has(key)) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

/** Parse a Date|string|null into epoch milliseconds, or null if unparseable. */
function toEpochMs(value: Date | string | null): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * `first_commit` lead time (in hours) of a single change: the elapsed time
 * between `mrFirstCommitAt` and `deployCompletedAt`. Returns null when either
 * timestamp is missing/unparseable, mirroring the SQL semantics
 * (`EXTRACT(EPOCH FROM (deploy_completed_at - mr_first_commit_at)) / 3600.0`).
 */
function firstCommitLeadHours(row: DeploymentChangeRow): number | null {
  const first = toEpochMs(row.mrFirstCommitAt);
  const deploy = toEpochMs(row.deployCompletedAt);
  if (first === null || deploy === null) return null;
  return (deploy - first) / 3_600_000;
}

/**
 * Select the `first_commit` Lead Times (in hours) of the changes whose
 * canonical identity belongs to the filter. Excludes non-selected authors and
 * unresolvable rows, and applies the outlier guard rail: only values in the
 * closed range `[0, guardHours]` are kept (same rule as the existing SQL guard
 * `>= 0 AND <= LEAD_TIME_GUARD_HOURS`). An empty filter ⇒ `[]`.
 */
export function selectAuthorLeadTimes(
  rows: DeploymentChangeRow[],
  authorKeyByRow: Map<DeploymentChangeRow, CanonicalAuthorKey | null>,
  filter: Set<CanonicalAuthorKey>,
  guardHours: number
): number[] {
  if (filter.size === 0) return [];
  const leadTimes: number[] = [];
  for (const row of rows) {
    const key = authorKeyByRow.get(row) ?? null;
    if (!changeBelongsToAuthorFilter(key, filter)) continue;
    const hours = firstCommitLeadHours(row);
    if (hours === null) continue;
    if (!Number.isFinite(hours)) continue;
    if (hours < 0 || hours > guardHours) continue;
    leadTimes.push(hours);
  }
  return leadTimes;
}

/**
 * Median of a list of values: the central value when the count is odd, the
 * arithmetic mean of the two central values when even. Empty input ⇒ null.
 * Does not mutate the input array.
 */
export function median(values: number[]): number | null {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Author_Attribution_Coverage: percentage of deployments in scope with
 * resolvable authorship, computed as
 * `(resolvable deployments / total deployments) * 100`, rounded to 1 decimal
 * and clamped to `[0.0, 100.0]`. A deployment is non-resolvable when it has no
 * changes or none of its changes resolve to a canonical identity
 * (`unresolved === true`). Returns null when there are zero deployments.
 */
export function authorAttributionCoverage(
  authorship: DeploymentAuthorship[]
): number | null {
  if (!authorship || authorship.length === 0) return null;
  const resolvable = authorship.filter((d) => !d.unresolved).length;
  const pct = (resolvable / authorship.length) * 100;
  const rounded = Math.round(pct * 10) / 10;
  return Math.min(100, Math.max(0, rounded));
}

/**
 * Pure cache-key part for the author dimension: the sorted list of canonical
 * keys produced by `normalizeAuthorFilter`. Order-insensitive and duplicate-free
 * (entries resolving to the same canonical key collapse). An empty filter ⇒
 * `[]`, which yields a constant sub-key and therefore the same cache entry as a
 * query without the author dimension (zero-regression path).
 */
export function authorsCacheKeyPart(authors: string[]): CanonicalAuthorKey[] {
  return [...normalizeAuthorFilter(authors)].sort();
}

/**
 * Pure predicate: is author scoping active? False for an empty filter, which
 * selects the zero-regression path (no author scoping applied). True when the
 * filter contains at least one canonical key.
 */
export function authorScopeActive(filter: Set<CanonicalAuthorKey>): boolean {
  return filter.size > 0;
}
