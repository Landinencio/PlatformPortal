"use client";

import { useState } from "react";
import { Home, Brain } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AccountMultiSelect } from "@/components/finops/AccountMultiSelect";
import { FinOpsAdvisor } from "@/components/inventory/finops-advisor";
import { useAwsAccounts } from "@/hooks/use-aws-accounts";
import { useI18n } from "@/lib/i18n";

interface FinOpsAdvisorPageProps {
  embedded?: boolean;
}

export function FinOpsAdvisorPage({ embedded = false }: FinOpsAdvisorPageProps) {
  const { accounts: availableAccounts, loading: accountsLoading } = useAwsAccounts({ includeHistoric: false });
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      {/* Header */}
      {!embedded && (
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button variant="ghost" size="sm" className="gap-2">
                <Home className="w-4 h-4" />
                {t("nav.home")}
              </Button>
            </Link>
            <span className="text-muted-foreground">/</span>
            <Link href="/finops">
              <Button variant="ghost" size="sm" className="gap-2">
                FinOps
              </Button>
            </Link>
            <span className="text-muted-foreground">/</span>
            <div className="flex items-center gap-2">
              <Brain className="w-5 h-5 text-violet-500" />
              <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("advisor.title")}</h1>
            </div>
          </div>
          <p className="text-muted-foreground">{t("advisor.pageDescription")}</p>
        </div>
      )}

      {/* Account selector */}
      <Card className="border-border/70 bg-card">
        <CardContent className="pt-6">
          <div className="flex flex-col md:flex-row gap-4 items-end">
            <div className="flex-1">
              <label className="text-sm font-medium text-foreground mb-2 block">{t("advisor.awsAccounts")}</label>
              <AccountMultiSelect
                accounts={availableAccounts}
                selectedIds={selectedAccountIds}
                onChange={setSelectedAccountIds}
                placeholder={accountsLoading ? t("advisor.loadingAccounts") : t("advisor.selectAccounts")}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Advisor */}
      <FinOpsAdvisor selectedAccountIds={selectedAccountIds} defaultIncludeCosts defaultIncludeMetrics />
    </div>
  );
}
