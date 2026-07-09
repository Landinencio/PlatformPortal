import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { fetchInventory } from "@/lib/aws-inventory";
import { buildAwsAccountNameMap, fetchAwsAccountCatalog, filterLiveAwsAccounts } from "@/lib/aws-account-catalog";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";
import { cached, cacheKey } from "@/lib/cache";
import { loadLatestInventorySnapshot, saveInventorySnapshot } from "@/lib/aws-inventory-persistence";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Cache inventory for 15 minutes (resources don't change that fast) */
const INVENTORY_CACHE_TTL_MS = 15 * 60 * 1000;

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const role = getSessionRole(session);
    if (!hasMinimumRole(role, "desarrolladores")) {
      return NextResponse.json({ error: "Editor access required for inventory" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const accountIdsParam = searchParams.get("accountIds") || "all";
    const forceRefresh = searchParams.get("refresh") === "true";

    const key = cacheKey("inventory", { accountIds: accountIdsParam });

    const data = await cached(
      key,
      async () => {
        const accountCatalog = await fetchAwsAccountCatalog();
        const liveAccountCatalog = filterLiveAwsAccounts(accountCatalog);
        const accountNameMap = buildAwsAccountNameMap(accountCatalog);

        const accountIds = accountIdsParam === "all"
          ? liveAccountCatalog.map((account) => account.id)
          : accountIdsParam.split(",").map((id) => id.trim());

        // Try loading from DB first (unless force refresh requested)
        if (!forceRefresh) {
          try {
            const cached = await loadLatestInventorySnapshot(accountIds);
            if (cached && !cached.meta.isStale) {
              return { ...cached.data, _meta: { fromCache: true, snapshotMeta: cached.meta } };
            }
          } catch (dbError) {
            console.warn("[inventory] Failed to load from DB, falling back to live fetch:", dbError);
          }
        }

        // Fetch live from AWS
        const freshData = await fetchInventory(accountIds, { accountNameMap });

        // Persist to DB asynchronously (don't block the response)
        saveInventorySnapshot(accountIds, freshData).catch((err) => {
          console.error("[inventory] Failed to persist snapshot:", err);
        });

        return { ...freshData, _meta: { fromCache: false } };
      },
      INVENTORY_CACHE_TTL_MS
    );

    return NextResponse.json(data);
  } catch (error) {
    console.error("Error fetching inventory:", error);
    return NextResponse.json(
      { error: "Failed to fetch inventory data" },
      { status: 500 }
    );
  }
}
