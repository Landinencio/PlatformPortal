import { AWS_ACCOUNTS, type AwsAccount } from "@/lib/aws-accounts";

const FINOPS_ATHENA_LAMBDA_URL =
  process.env.FINOPS_ATHENA_LAMBDA_URL ||
  "https://jzcrsycqa2plblvxdeck37r6am0kxeqw.lambda-url.eu-north-1.on.aws/";

const ACCOUNT_CATALOG_TTL_MS = 5 * 60 * 1000;

export interface AwsAccountCatalogEntry extends AwsAccount {
  status?: string | null;
  source?: "organizations" | "cur" | "static";
}

let cachedAccounts: AwsAccountCatalogEntry[] | null = null;
let cachedAt = 0;

function parseLambdaPayload(payload: unknown): any {
  if (typeof payload !== "object" || payload === null) {
    return {};
  }

  const wrapped = payload as { body?: unknown };
  if (typeof wrapped.body === "string") {
    try {
      return JSON.parse(wrapped.body);
    } catch {
      return {};
    }
  }

  if (typeof wrapped.body === "object" && wrapped.body !== null) {
    return wrapped.body;
  }

  return payload;
}

function mergeAccounts(primary: AwsAccountCatalogEntry[], fallback: AwsAccountCatalogEntry[]) {
  const merged = new Map<string, AwsAccountCatalogEntry>();

  for (const account of fallback) {
    merged.set(account.id, account);
  }

  for (const account of primary) {
    if (!account.id) continue;
    const existing = merged.get(account.id);
    const name = account.name && account.name !== account.id
      ? account.name
      : existing?.name || account.id;

    merged.set(account.id, {
      ...existing,
      ...account,
      name,
      email: account.email || existing?.email,
    });
  }

  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function getStaticFallbackAccounts(): AwsAccountCatalogEntry[] {
  return AWS_ACCOUNTS.map((account) => ({
    ...account,
    status: "STATIC",
    source: "static" as const,
  }));
}

function normalizeCatalogAccounts(payload: unknown): AwsAccountCatalogEntry[] {
  const body = parseLambdaPayload(payload);
  const items = Array.isArray(body?.accounts) ? body.accounts : [];

  return items
    .map((item: any) => ({
      id: String(item?.id || item?.accountId || "").trim(),
      name: String(item?.name || item?.accountName || item?.id || item?.accountId || "").trim(),
      status: item?.status ? String(item.status) : null,
      email: item?.email ? String(item.email) : undefined,
      source: item?.source === "organizations" || item?.source === "cur" || item?.source === "static"
        ? item.source
        : undefined,
    }))
    .filter((account: AwsAccountCatalogEntry) => account.id.length > 0 && account.name.length > 0);
}

export async function fetchAwsAccountCatalog(forceRefresh = false): Promise<AwsAccountCatalogEntry[]> {
  const now = Date.now();
  if (!forceRefresh && cachedAccounts && now - cachedAt < ACCOUNT_CATALOG_TTL_MS) {
    return cachedAccounts;
  }

  const fallbackAccounts = getStaticFallbackAccounts();

  try {
    const response = await fetch(FINOPS_ATHENA_LAMBDA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "accounts" }),
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Account catalog lambda returned ${response.status}`);
    }

    const payload = await response.json();
    const remoteAccounts = normalizeCatalogAccounts(payload);
    if (remoteAccounts.length === 0) {
      throw new Error("Account catalog lambda returned no accounts");
    }

    cachedAccounts = mergeAccounts(remoteAccounts, fallbackAccounts);
    cachedAt = now;
    return cachedAccounts;
  } catch (error) {
    console.warn("Falling back to static AWS account catalog:", error);
    cachedAccounts = fallbackAccounts;
    cachedAt = now;
    return cachedAccounts;
  }
}

export function filterLiveAwsAccounts(accounts: AwsAccountCatalogEntry[]) {
  return accounts.filter((account) => {
    const status = String(account.status || "").toUpperCase();
    return status === "ACTIVE" || status === "STATIC" || status === "";
  });
}

export function buildAwsAccountNameMap(accounts: Array<Pick<AwsAccountCatalogEntry, "id" | "name">>) {
  return accounts.reduce<Record<string, string>>((acc, account) => {
    acc[account.id] = account.name;
    return acc;
  }, {});
}
