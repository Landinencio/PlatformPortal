/**
 * Kiro license cost analysis.
 *
 * Pulls Kiro line items from CUR (line_item_product_code = 'Kiro'),
 * resolves the SSO identitystore UUID to email/name/groups via Identity Store API,
 * and builds a per-user view: plan, account, monthly cost, group memberships.
 */

import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import {
  IdentitystoreClient,
  DescribeUserCommand,
  ListGroupMembershipsForMemberCommand,
  DescribeGroupCommand,
} from "@aws-sdk/client-identitystore";
import { executeAthenaQuery } from "@/lib/athena-cur";
import { fetchAwsAccountCatalog, buildAwsAccountNameMap } from "@/lib/aws-account-catalog";

const IDENTITY_STORE_ID = "d-93670801b4";
const IDENTITY_STORE_REGION = "eu-west-1";
// Identity Store lives in the SSO master account (root-iskaypet)
const IDENTITY_STORE_ROLE_ARN =
  process.env.IDENTITY_STORE_ROLE_ARN?.trim() ||
  "arn:aws:iam::600700800900:role/Cur-AWSS3CURLambdaExecutor-Y5pT9wqNQaur";

interface KiroCharge {
  userId: string | null;
  accountId: string;
  plan: string;
  cost: number;
}

interface KiroUser {
  userId: string;
  email: string | null;
  displayName: string | null;
  groups: string[];
}

export interface KiroUsageRow {
  userId: string;
  email: string | null;
  displayName: string | null;
  groups: string[];
  plan: string;
  account: string;
  cost: number;
}

export interface KiroSummary {
  window: { startDate: string; endDate: string };
  totalCost: number;
  totalCredits: number;
  netCost: number;
  byPlan: Array<{ plan: string; users: number; cost: number }>;
  unattributedCost: number;
  users: KiroUsageRow[];
  unresolvedUserIds: string[];
}

let cachedClient: IdentitystoreClient | null = null;
let credsExpiresAt = 0;

async function getIdentitystoreClient(): Promise<IdentitystoreClient> {
  if (cachedClient && Date.now() < credsExpiresAt - 60_000) return cachedClient;
  const sts = new STSClient({ region: IDENTITY_STORE_REGION });
  const assumed = await sts.send(
    new AssumeRoleCommand({
      RoleArn: IDENTITY_STORE_ROLE_ARN,
      RoleSessionName: "portal-identity-store",
      DurationSeconds: 900,
    }),
  );
  cachedClient = new IdentitystoreClient({
    region: IDENTITY_STORE_REGION,
    credentials: {
      accessKeyId: assumed.Credentials!.AccessKeyId!,
      secretAccessKey: assumed.Credentials!.SecretAccessKey!,
      sessionToken: assumed.Credentials!.SessionToken!,
    },
  });
  credsExpiresAt = assumed.Credentials!.Expiration!.getTime();
  return cachedClient;
}

const userCache = new Map<string, KiroUser>();
const groupNameCache = new Map<string, string>();

async function resolveUser(userId: string): Promise<KiroUser> {
  const existing = userCache.get(userId);
  if (existing) return existing;

  const client = await getIdentitystoreClient();
  let email: string | null = null;
  let displayName: string | null = null;
  let groups: string[] = [];

  try {
    const desc = await client.send(
      new DescribeUserCommand({ IdentityStoreId: IDENTITY_STORE_ID, UserId: userId }),
    );
    email = desc.UserName || desc.Emails?.[0]?.Value || null;
    displayName = desc.DisplayName || (desc.Name?.GivenName ? `${desc.Name.GivenName} ${desc.Name.FamilyName || ""}`.trim() : null);
  } catch (err: any) {
    console.warn(`[kiro] DescribeUser ${userId} failed:`, err?.name, err?.message);
  }

  try {
    let nextToken: string | undefined;
    do {
      const memberships = await client.send(
        new ListGroupMembershipsForMemberCommand({
          IdentityStoreId: IDENTITY_STORE_ID,
          MemberId: { UserId: userId },
          NextToken: nextToken,
        }),
      );
      for (const m of memberships.GroupMemberships || []) {
        if (m.GroupId) {
          let name = groupNameCache.get(m.GroupId);
          if (!name) {
            try {
              const g = await client.send(
                new DescribeGroupCommand({ IdentityStoreId: IDENTITY_STORE_ID, GroupId: m.GroupId }),
              );
              name = g.DisplayName || m.GroupId;
              groupNameCache.set(m.GroupId, name);
            } catch {
              name = m.GroupId;
            }
          }
          if (name) groups.push(name);
        }
      }
      nextToken = memberships.NextToken;
    } while (nextToken);
  } catch {
    // group resolution best-effort
  }

  const user: KiroUser = { userId, email, displayName, groups };
  userCache.set(userId, user);
  return user;
}

function planFromUsageType(usageType: string): string {
  if (usageType.includes("Power")) return "Power";
  if (usageType.includes("ProPlus")) return "Pro+";
  if (usageType.includes("Pro")) return "Pro";
  if (usageType.includes("Credits")) return "Credits";
  return usageType;
}

export async function fetchKiroSummary(
  startDate: string,
  endDate: string,
  accountIds?: string[],
): Promise<KiroSummary> {
  const accountFilter = accountIds && accountIds.length > 0
    ? `AND line_item_usage_account_id IN (${accountIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`
    : "";
  const sql = `
    SELECT
      line_item_resource_id AS user_arn,
      line_item_usage_account_id AS account_id,
      line_item_usage_type AS usage_type,
      line_item_line_item_type AS item_type,
      SUM(line_item_unblended_cost) AS cost
    FROM athenacurcfn_finnops.data
    WHERE line_item_usage_start_date >= DATE '${startDate}'
      AND line_item_usage_start_date < DATE '${nextDay(endDate)}'
      AND line_item_product_code = 'Kiro'
      AND line_item_line_item_type IN ('Usage','Fee','Credit','SppDiscount','FlatRateSubscription','RIFee','SavingsPlanRecurringFee')
      ${accountFilter}
    GROUP BY 1, 2, 3, 4
    ORDER BY cost DESC
  `;
  const rows = await executeAthenaQuery(sql);

  const charges: KiroCharge[] = rows
    .map((r) => {
      const arn = String(r.user_arn || "");
      const userId = arn.startsWith("arn:aws:identitystore")
        ? arn.split("/").pop() || null
        : null;
      const usageType = String(r.usage_type || "");
      return {
        userId,
        accountId: String(r.account_id || ""),
        plan: planFromUsageType(usageType),
        cost: Number(r.cost) || 0,
      };
    })
    // Keep all (including 0 cost) so we can show users without spending,
    // but skip Tax rows that have no resource id
    .filter((c) => c.userId !== null);

  // Aggregate per (user, account, plan) so credits net out
  type Bucket = { userId: string | null; accountId: string; plan: string; cost: number };
  const bucketMap = new Map<string, Bucket>();
  for (const c of charges) {
    const key = `${c.userId || "no-user"}::${c.accountId}::${c.plan}`;
    const b = bucketMap.get(key);
    if (b) b.cost += c.cost;
    else bucketMap.set(key, { ...c });
  }
  // Drop credits-only rows with $0 (they pollute the view when a user pays a plan elsewhere).
  // Keep credits rows ONLY if the user has NO paying plan anywhere (truly using credits-only).
  const usersWithPaidPlan = new Set<string>();
  for (const b of bucketMap.values()) {
    if (b.userId && b.plan !== "Credits" && b.cost > 0) usersWithPaidPlan.add(b.userId);
  }
  const buckets = [...bucketMap.values()].filter((b) => {
    // drop the $0 / negligible credits row if user has a real paid plan
    if (b.plan === "Credits" && Math.abs(b.cost) < 0.01 && b.userId && usersWithPaidPlan.has(b.userId)) {
      return false;
    }
    return true;
  });

  // Resolve all unique userIds in parallel (limited concurrency)
  const uniqueIds = [...new Set(buckets.map((b) => b.userId).filter(Boolean) as string[])];
  const concurrency = 8;
  const userMap = new Map<string, KiroUser>();
  const unresolved: string[] = [];
  for (let i = 0; i < uniqueIds.length; i += concurrency) {
    const batch = uniqueIds.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map((id) => resolveUser(id)));
    for (let j = 0; j < settled.length; j++) {
      const id = batch[j];
      if (settled[j].status === "fulfilled") userMap.set(id, (settled[j] as any).value);
      else unresolved.push(id);
    }
  }

  // Account name map
  const catalog = await fetchAwsAccountCatalog().catch(() => []);
  const accountNameMap = buildAwsAccountNameMap(catalog);

  // Build per-row output
  const userRows: KiroUsageRow[] = [];
  let unattributedCost = 0;
  let totalCredits = 0;
  let totalCharges = 0;

  for (const b of buckets) {
    if (b.cost < 0) totalCredits += b.cost;
    else totalCharges += b.cost;

    if (!b.userId) {
      unattributedCost += b.cost;
      continue;
    }
    const u = userMap.get(b.userId);
    userRows.push({
      userId: b.userId,
      email: u?.email || null,
      displayName: u?.displayName || null,
      groups: u?.groups || [],
      plan: b.plan,
      account: accountNameMap[b.accountId] || b.accountId,
      cost: Math.round(b.cost * 100) / 100,
    });
  }

  // Sort by cost desc
  userRows.sort((a, b) => b.cost - a.cost);

  // By plan summary
  const planMap = new Map<string, { plan: string; users: Set<string>; cost: number }>();
  for (const row of userRows) {
    const p = planMap.get(row.plan) || { plan: row.plan, users: new Set(), cost: 0 };
    p.users.add(row.userId);
    p.cost += row.cost;
    planMap.set(row.plan, p);
  }
  const byPlan = [...planMap.values()]
    .map((p) => ({ plan: p.plan, users: p.users.size, cost: Math.round(p.cost * 100) / 100 }))
    .sort((a, b) => b.cost - a.cost);

  return {
    window: { startDate, endDate },
    totalCost: Math.round(totalCharges * 100) / 100,
    totalCredits: Math.round(totalCredits * 100) / 100,
    netCost: Math.round((totalCharges + totalCredits) * 100) / 100,
    byPlan,
    unattributedCost: Math.round(unattributedCost * 100) / 100,
    users: userRows,
    unresolvedUserIds: unresolved,
  };
}

function nextDay(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}
