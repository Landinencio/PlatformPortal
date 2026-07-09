/**
 * GET /api/finops/cur-direct — Direct CUR query via Athena (bypasses Lambda)
 *
 * Returns the full CUR snapshot including new dimensions:
 * - byDomain (user_domain tag)
 * - byEnvironment (user_environment tag)
 * - tagCoverage (% of cost that is tagged)
 * - spDetails (Savings Plan ARNs, types, expiration dates)
 *
 * Uses the portal's IRSA → AssumeRole → CUR role chain.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";
import { fetchCurFullSnapshot } from "@/lib/athena-cur";
import { buildAwsAccountNameMap, fetchAwsAccountCatalog, filterLiveAwsAccounts } from "@/lib/aws-account-catalog";
import { cached, cacheKey } from "@/lib/cache";
import { scopeSnapshotToAccounts } from "@/lib/finops-scope";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Cache for 10 minutes */
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const role = getSessionRole(session);
  if (!hasMinimumRole(role, "desarrolladores")) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  const accountIdsParam = searchParams.get("accountIds");

  if (!startDate || !endDate) {
    return NextResponse.json({ error: "startDate and endDate required" }, { status: 400 });
  }

  // Two clearly separated scoping paths (no silent org-wide leak):
  //  - Explicit scope: the caller passed a real CSV of account ids. The response
  //    MUST only contain those accounts.
  //  - Org-wide fallback: accountIds is absent/empty/"all". This intentionally
  //    maps to every live account. It is a deliberate, documented org-wide view,
  //    never a side effect of a missing filter.
  const isExplicitScope = Boolean(accountIdsParam && accountIdsParam !== "all");

  try {
    // Cache key reflects the requested scope so explicit-account requests never
    // reuse an org-wide entry (and vice versa). Task 10.2 cache reuse relies on
    // the same {startDate, endDate, accountIds} producing the same key.
    const key = cacheKey("cur-direct", { startDate, endDate, accountIds: accountIdsParam || "all" });

    const result = await cached(key, async () => {
      // Resolve accounts
      const catalog = await fetchAwsAccountCatalog();
      const nameMap = buildAwsAccountNameMap(catalog);
      const liveAccounts = filterLiveAwsAccounts(catalog);

      // `accountIds` is the actual set used in the Athena WHERE filter: either the
      // explicit caller-provided set, or the resolved live-account set (org-wide).
      const accountIds = isExplicitScope
        ? accountIdsParam!.split(",").map((id) => id.trim()).filter(Boolean)
        : liveAccounts.map((a) => a.id);

      const snapshot = await fetchCurFullSnapshot(accountIds, startDate, endDate, nameMap);

      // Defence-in-depth: the query already filters by `accountIds`, but applying
      // scopeSnapshotToAccounts is a cheap, idempotent guarantee that the response
      // only carries the accounts actually queried — even if a future query forgot
      // its WHERE filter. Applied in BOTH paths (scoped to the resolved live set in
      // the org-wide case) so no out-of-scope row can ever leak through. Cached
      // value is the already-scoped snapshot.
      return scopeSnapshotToAccounts(snapshot, accountIds);
    }, CACHE_TTL_MS);

    return NextResponse.json(result);
  } catch (err) {
    console.error("[cur-direct] Error:", err);
    return NextResponse.json(
      { error: "Failed to query CUR", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
