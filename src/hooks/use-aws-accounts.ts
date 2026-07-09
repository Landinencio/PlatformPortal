"use client";

import { useEffect, useState } from "react";
import { AWS_ACCOUNTS } from "@/lib/aws-accounts";
import { filterLiveAwsAccounts, type AwsAccountCatalogEntry } from "@/lib/aws-account-catalog";

interface UseAwsAccountsResult {
  accounts: AwsAccountCatalogEntry[];
  loading: boolean;
  error: string | null;
}

interface UseAwsAccountsOptions {
  includeHistoric?: boolean;
}

function getStaticAccounts(): AwsAccountCatalogEntry[] {
  return AWS_ACCOUNTS.map((account) => ({
    ...account,
    status: "STATIC",
    source: "static" as const,
  }));
}

function filterAccounts(accounts: AwsAccountCatalogEntry[], includeHistoric: boolean) {
  return includeHistoric ? accounts : filterLiveAwsAccounts(accounts);
}

export function useAwsAccounts(options?: UseAwsAccountsOptions): UseAwsAccountsResult {
  const includeHistoric = options?.includeHistoric ?? true;
  const [accounts, setAccounts] = useState<AwsAccountCatalogEntry[]>(filterAccounts(getStaticAccounts(), includeHistoric));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadAccounts = async () => {
      try {
        const response = await fetch("/api/finops/accounts", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Account catalog returned ${response.status}`);
        }

        const payload = await response.json();
        const items = Array.isArray(payload?.accounts) ? payload.accounts : [];
        const normalized = items
          .map((item: any) => ({
            id: String(item?.id || item?.accountId || "").trim(),
            name: String(item?.name || item?.accountName || "").trim(),
            status: item?.status ? String(item.status) : null,
            email: item?.email ? String(item.email) : undefined,
            source: item?.source === "organizations" || item?.source === "cur" || item?.source === "static"
              ? item.source
              : undefined,
          }))
          .filter((item: AwsAccountCatalogEntry) => item.id.length > 0 && item.name.length > 0);

        if (!cancelled && normalized.length > 0) {
          setAccounts(filterAccounts(normalized, includeHistoric));
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "No se pudo cargar el catalogo de cuentas");
          setAccounts(filterAccounts(getStaticAccounts(), includeHistoric));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadAccounts();

    return () => {
      cancelled = true;
    };
  }, [includeHistoric]);

  return { accounts, loading, error };
}
