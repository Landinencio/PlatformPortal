/**
 * finops-scope.ts — Pure account-scoping helpers for CurFullSnapshot.
 *
 * Feature: finops-cost-comparison-explorer (PARTE A — account scoping)
 *
 * These functions guarantee that everything rendered in the FinOps "Costes" tab
 * is strictly limited to the account set selected in the global account filter
 * (`selectedAccountIds`). The fix is applied at the data source (athena-cur.ts +
 * /api/finops/cur-direct) and reinforced here with a pure, defensive client-side
 * filter that drops any row whose account is outside the selected set.
 *
 * Design principle: "fix at the source, defend in the client". This module is the
 * defence layer + the source-of-truth predicate, with no React or network deps.
 */

import type { CurFullSnapshot } from "./athena-cur";

/**
 * A row that may carry an account dimension. CUR sections use either `accountId`
 * (byAccount, topResources, ec2Fleet, aiCostDaily.byAccount) or `account`
 * (hiddenCosts.* details, anomalyAttribution.topResources).
 */
export type AccountScoped = { accountId?: string; account?: string };

/** Extract the account identifier from a row, regardless of which field it uses. */
function rowAccountId(row: AccountScoped): string | undefined {
  const id = row.accountId ?? row.account;
  return id == null || id === "" ? undefined : id;
}

/**
 * Returns `true` if the row belongs to the selected account set.
 *
 * A row with no associable account is conservatively considered in scope at the
 * primitive level (we have no information to exclude it). Section-level scoping
 * (see `scopeSnapshotToAccounts`) decides whether account-identifiable sections
 * should additionally hide rows that lack an account.
 */
export function rowInScope(row: AccountScoped, accountIds: ReadonlySet<string>): boolean {
  const id = rowAccountId(row);
  if (id === undefined) return true;
  return accountIds.has(id);
}

/**
 * Strict variant used for sections that ARE account-identifiable: a row must
 * carry an account AND that account must be in the selected set. Rows lacking an
 * identifiable account are hidden (conservative — never assumed in-scope). This
 * also covers `ec2Fleet` rows that predate the account dimension being added to
 * the query (stale cache / older data): such rows are hidden rather than leaked.
 */
function strictRowInScope(row: AccountScoped, accountIds: ReadonlySet<string>): boolean {
  const id = rowAccountId(row);
  if (id === undefined) return false;
  return accountIds.has(id);
}

/**
 * Filters a CurFullSnapshot, section by section, so that every row carrying an
 * account dimension belongs to `accountIds`. Sections that have no intersection
 * with the selected set are left empty (cardinality 0) — never populated with
 * data from other accounts. Sections that are NOT identifiable by account
 * (byService, dailyCosts, byDomain, byEnvironment, pricingModel, discounts,
 * marketplace, tagCompliance, scalar aggregates, etc.) are conserved as-is.
 *
 * Pure: does not mutate the input snapshot. Idempotent and order-independent —
 * `scope(scope(s, A), B)` keeps exactly the rows whose account is in `A ∩ B`.
 */
export function scopeSnapshotToAccounts(
  snapshot: CurFullSnapshot,
  accountIds: string[],
): CurFullSnapshot {
  const set = new Set(accountIds);
  const inScope = (row: AccountScoped) => strictRowInScope(row, set);

  return {
    ...snapshot,

    // ── Account-identifiable sections: filter to the selected set ──────────
    byAccount: snapshot.byAccount.filter((r) => inScope(r)),
    topResources: snapshot.topResources.filter((r) => inScope(r)),
    // ec2Fleet gains accountId/accountName (task 4.1). Defensive cast covers
    // both the new shape and stale rows without an account (hidden conservatively).
    ec2Fleet: snapshot.ec2Fleet.filter((r) => inScope(r as AccountScoped)),

    hiddenCosts: {
      ...snapshot.hiddenCosts,
      gp2Detail: snapshot.hiddenCosts.gp2Detail.filter((r) => inScope(r)),
      extendedSupportDetail: snapshot.hiddenCosts.extendedSupportDetail.filter((r) => inScope(r)),
      cloudwatchLogs: {
        ...snapshot.hiddenCosts.cloudwatchLogs,
        topGroups: snapshot.hiddenCosts.cloudwatchLogs.topGroups.filter((r) => inScope(r)),
      },
      natGateways: {
        ...snapshot.hiddenCosts.natGateways,
        topConsumers: snapshot.hiddenCosts.natGateways.topConsumers.filter((r) => inScope(r)),
      },
      bedrock: {
        ...snapshot.hiddenCosts.bedrock,
        byModel: snapshot.hiddenCosts.bedrock.byModel.filter((r) => inScope(r)),
      },
    },

    // ── Nested account-identifiable rows inside per-day collections ────────
    anomalyAttribution: snapshot.anomalyAttribution.map((day) => ({
      ...day,
      topResources: day.topResources.filter((r) => inScope(r)),
    })),
    aiCostDaily: {
      ...snapshot.aiCostDaily,
      days: snapshot.aiCostDaily.days.map((day) => ({
        ...day,
        byAccount: day.byAccount.filter((r) => inScope(r)),
      })),
    },
  };
}

/** A single out-of-scope finding (section path + offending account id). */
interface ScopeViolation {
  section: string;
  accountId: string;
}

/** Collects every row whose account is present but outside the selected set. */
function collectViolations(snapshot: CurFullSnapshot, set: ReadonlySet<string>): ScopeViolation[] {
  const violations: ScopeViolation[] = [];
  const check = (section: string, rows: AccountScoped[]) => {
    for (const row of rows) {
      const id = rowAccountId(row);
      if (id !== undefined && !set.has(id)) violations.push({ section, accountId: id });
    }
  };

  check("byAccount", snapshot.byAccount);
  check("topResources", snapshot.topResources);
  check("ec2Fleet", snapshot.ec2Fleet as unknown as AccountScoped[]);
  check("hiddenCosts.gp2Detail", snapshot.hiddenCosts.gp2Detail);
  check("hiddenCosts.extendedSupportDetail", snapshot.hiddenCosts.extendedSupportDetail);
  check("hiddenCosts.cloudwatchLogs.topGroups", snapshot.hiddenCosts.cloudwatchLogs.topGroups);
  check("hiddenCosts.natGateways.topConsumers", snapshot.hiddenCosts.natGateways.topConsumers);
  check("hiddenCosts.bedrock.byModel", snapshot.hiddenCosts.bedrock.byModel);
  for (const day of snapshot.anomalyAttribution) {
    check(`anomalyAttribution[${day.day}].topResources`, day.topResources);
  }
  for (const day of snapshot.aiCostDaily.days) {
    check(`aiCostDaily[${day.date}].byAccount`, day.byAccount);
  }

  return violations;
}

/**
 * Asserts that a snapshot contains no rows from accounts outside `accountIds`.
 * Used to catch query regressions where a sub-query forgets its
 * `line_item_usage_account_id IN (...)` filter.
 *
 * Throws in dev/test (NODE_ENV !== "production"); logs a warning in production
 * so a regression never crashes the live dashboard but is still observable.
 */
export function assertSnapshotScoped(snapshot: CurFullSnapshot, accountIds: string[]): void {
  const set = new Set(accountIds);
  const violations = collectViolations(snapshot, set);
  if (violations.length === 0) return;

  const sample = violations
    .slice(0, 10)
    .map((v) => `${v.section}=${v.accountId}`)
    .join(", ");
  const message =
    `[finops-scope] snapshot contains ${violations.length} row(s) outside the selected ` +
    `account set {${accountIds.join(", ")}}: ${sample}`;

  if (process.env.NODE_ENV === "production") {
    console.warn(message);
    return;
  }
  throw new Error(message);
}
