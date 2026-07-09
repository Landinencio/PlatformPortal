"use client";

import { Server, Shield, Tag, DollarSign, AlertTriangle } from "lucide-react";
import { MiniStat } from "@/components/metrics/shared";
import type { InventoryResponse } from "@/types/inventory";
import { useI18n } from "@/lib/i18n";

export function InventoryKpiBar({ data }: { data: InventoryResponse }) {
  const { t } = useI18n();
  const totalResources = data.totalResources || 0;
  const totalAccounts = data.accounts?.length || 0;
  const totalServices = data.byService?.length || 0;

  // Calculate Terraform coverage
  let terraformManaged = 0;
  let terraformNotManaged = 0;
  let terraformUnknown = 0;

  for (const account of data.accounts || []) {
    for (const service of account.services || []) {
      for (const detail of service.details || []) {
        if (detail.terraform === true) terraformManaged++;
        else if (detail.terraform === false) terraformNotManaged++;
        else terraformUnknown++;
      }
    }
  }

  const terraformPct = totalResources > 0
    ? ((terraformManaged / totalResources) * 100).toFixed(1)
    : "0.0";

  // Count resources with tags
  let taggedResources = 0;
  for (const account of data.accounts || []) {
    for (const service of account.services || []) {
      for (const detail of service.details || []) {
        const tags = detail.tags || (detail.metadata?.tags as Record<string, string> | undefined);
        if (tags && typeof tags === "object" && Object.keys(tags).length > 0) {
          taggedResources++;
        }
      }
    }
  }

  const tagCoveragePct = totalResources > 0
    ? ((taggedResources / totalResources) * 100).toFixed(1)
    : "0.0";

  // Count regions
  const regions = new Set<string>();
  for (const service of data.byService || []) {
    for (const region of service.regions || []) {
      regions.add(region);
    }
  }

  // Estimate monthly cost from resource types
  let estimatedMonthlyCost = 0;
  for (const account of data.accounts || []) {
    for (const service of account.services || []) {
      for (const detail of service.details || []) {
        const cost = detail.metadata?.estimatedMonthlyCost;
        if (typeof cost === "number" && Number.isFinite(cost)) {
          estimatedMonthlyCost += cost;
        }
      }
    }
  }

  return (
    <div className="grid gap-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
      <MiniStat
        label={t("inventory.resources")}
        value={totalResources.toLocaleString()}
        tone="info"
      />
      <MiniStat
        label={t("common.accounts")}
        value={String(totalAccounts)}
        tone="default"
      />
      <MiniStat
        label={t("inventory.service")}
        value={String(totalServices)}
        tone="default"
      />
      <MiniStat
        label="Coste est./mes"
        value={estimatedMonthlyCost > 0 ? `$${(estimatedMonthlyCost / 1000).toFixed(1)}k` : "—"}
        tone={estimatedMonthlyCost > 0 ? "warning" : "default"}
      />
      <MiniStat
        label="Terraform"
        value={`${terraformPct}%`}
        tone={parseFloat(terraformPct) >= 70 ? "success" : parseFloat(terraformPct) >= 40 ? "warning" : "danger"}
      />
      <MiniStat
        label="Tags"
        value={`${tagCoveragePct}%`}
        tone={parseFloat(tagCoveragePct) >= 70 ? "success" : parseFloat(tagCoveragePct) >= 40 ? "warning" : "danger"}
      />
    </div>
  );
}
