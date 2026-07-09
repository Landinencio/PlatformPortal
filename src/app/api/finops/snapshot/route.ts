import { NextResponse } from "next/server";
import { requireInternalAuth } from "@/lib/api-auth";
import pool from "@/lib/db";
import { fetchInventory } from "@/lib/aws-inventory";
import { collectMetricsForAccount } from "@/lib/aws-cloudwatch-metrics";
import { fetchAwsAccountCatalog, buildAwsAccountNameMap, filterLiveAwsAccounts } from "@/lib/aws-account-catalog";
import { AWS_ACCOUNT_NAMES } from "@/lib/aws-accounts";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min

const FINOPS_ATHENA_LAMBDA_URL = process.env.FINOPS_ATHENA_LAMBDA_URL || "https://jzcrsycqa2plblvxdeck37r6am0kxeqw.lambda-url.eu-north-1.on.aws/";

function parseAthenaPayload(payload: unknown): any {
  if (typeof payload !== "object" || payload === null) return {};
  const w = payload as { body?: unknown };
  if (typeof w.body === "string") { try { return JSON.parse(w.body); } catch { return {}; } }
  if (typeof w.body === "object" && w.body !== null) return w.body;
  return payload;
}

export async function POST(request: Request) {
  const auth = requireInternalAuth(request);
  if (auth.error) return auth.error;

  const today = new Date().toISOString().split("T")[0];
  console.log(`[finops-snapshot] Starting for ${today}`);

  try {
    // 1. Fetch account catalog
    const catalog = await fetchAwsAccountCatalog();
    const nameMap = buildAwsAccountNameMap(catalog);
    const liveAccounts = filterLiveAwsAccounts(catalog);
    const accountIds = liveAccounts.map((a) => a.id);

    // 2. Fetch inventory
    console.log(`[finops-snapshot] Fetching inventory for ${accountIds.length} accounts...`);
    const inventory = await fetchInventory(accountIds, { accountNameMap: nameMap });

    const inventorySummary: Record<string, any> = {
      byService: inventory.byService.map((s) => ({ service: s.service, count: s.resourceCount })),
      ec2Running: inventory.byService.find((s) => s.service === "EC2 - Instances")?.details.filter((d) => d.state === "running").length || 0,
      ec2Stopped: inventory.byService.find((s) => s.service === "EC2 - Instances")?.details.filter((d) => d.state === "stopped").length || 0,
      rdsCount: (inventory.byService.find((s) => s.service === "RDS - DB Instances")?.resourceCount || 0),
      s3Count: (inventory.byService.find((s) => s.service === "S3 - Buckets")?.resourceCount || 0),
      lambdaCount: (inventory.byService.find((s) => s.service === "Lambda - Functions")?.resourceCount || 0),
      ebsTotal: (inventory.byService.find((s) => s.service === "EC2 - EBS Volumes")?.resourceCount || 0),
      ebsUnattached: inventory.byService.find((s) => s.service === "EC2 - EBS Volumes")?.details.filter((d) => d.state === "available").length || 0,
    };

    // 3. Collect metrics (quick sample — 7 days, batch of 3)
    console.log(`[finops-snapshot] Collecting CloudWatch metrics...`);
    let allMetrics: any[] = [];
    const BATCH = 3;
    for (let i = 0; i < inventory.accounts.length; i += BATCH) {
      const batch = inventory.accounts.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map((a) => collectMetricsForAccount(a.accountId, a.services, 7))
      );
      for (const r of results) {
        if (r.status === "fulfilled") allMetrics.push(...r.value);
      }
    }

    const metricsSummary = {
      totalMetrics: allMetrics.length,
      ec2IdleCount: allMetrics.filter((m) => m.service === "EC2" && m.metrics.cpuAvg !== null && m.metrics.cpuAvg < 5).length,
      ec2LowCount: allMetrics.filter((m) => m.service === "EC2" && m.metrics.cpuAvg !== null && m.metrics.cpuAvg >= 5 && m.metrics.cpuAvg < 25).length,
      rdsLowCount: allMetrics.filter((m) => m.service === "RDS" && m.metrics.cpuAvg !== null && m.metrics.cpuAvg < 10).length,
    };

    // 4. Fetch costs from Athena
    console.log(`[finops-snapshot] Fetching CUR costs...`);
    let costSummary: Record<string, any> = {};
    try {
      const now = new Date();
      const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const endDate = today;

      const res = await fetch(FINOPS_ATHENA_LAMBDA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: { accountIds: accountIds.join(","), startDate, endDate, includeTrends: false, includeResourceCosts: true, resourceCostLimit: 100 } }),
        cache: "no-store",
      });

      if (res.ok) {
        const raw = await res.json();
        const payload = parseAthenaPayload(raw);
        const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];

        costSummary = {
          totalCost: Number(payload?.summary?.totalCost || 0),
          window: { startDate, endDate },
          byAccount: accounts.map((a: any) => ({
            accountId: String(a.accountId || ""),
            accountName: String(a.accountName || nameMap[String(a.accountId)] || AWS_ACCOUNT_NAMES[String(a.accountId)] || "Unknown"),
            cost: Number(a.totalCost || 0),
          })).sort((a: any, b: any) => b.cost - a.cost).slice(0, 20),
          byService: (() => {
            const map = new Map<string, number>();
            for (const a of accounts) {
              for (const s of (a.services || [])) {
                map.set(String(s.name), (map.get(String(s.name)) || 0) + Number(s.cost || 0));
              }
            }
            return [...map.entries()].map(([service, cost]) => ({ service, cost })).sort((a, b) => b.cost - a.cost).slice(0, 20);
          })(),
          executive: payload.executive || null,
        };
      }
    } catch (err) {
      console.warn("[finops-snapshot] Could not fetch CUR costs:", err);
    }

    // 5. Build opportunities
    const opportunities = [];
    if (inventorySummary.ec2Stopped > 0) {
      opportunities.push({ type: "ec2_stopped", count: inventorySummary.ec2Stopped, estimatedSavings: inventorySummary.ec2Stopped * 20 });
    }
    if (inventorySummary.ebsUnattached > 0) {
      opportunities.push({ type: "ebs_unattached", count: inventorySummary.ebsUnattached, estimatedSavings: inventorySummary.ebsUnattached * 5 });
    }
    if (metricsSummary.ec2IdleCount > 0) {
      opportunities.push({ type: "ec2_idle", count: metricsSummary.ec2IdleCount, estimatedSavings: metricsSummary.ec2IdleCount * 40 });
    }
    if (metricsSummary.rdsLowCount > 0) {
      opportunities.push({ type: "rds_underutilized", count: metricsSummary.rdsLowCount, estimatedSavings: metricsSummary.rdsLowCount * 50 });
    }

    // 6. Persist
    await pool.query(`
      INSERT INTO finops_daily_context (snapshot_date, total_accounts, total_resources, total_services, cost_summary, inventory_summary, opportunities, metrics_summary)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (snapshot_date) DO UPDATE SET
        total_accounts = EXCLUDED.total_accounts,
        total_resources = EXCLUDED.total_resources,
        total_services = EXCLUDED.total_services,
        cost_summary = EXCLUDED.cost_summary,
        inventory_summary = EXCLUDED.inventory_summary,
        opportunities = EXCLUDED.opportunities,
        metrics_summary = EXCLUDED.metrics_summary,
        created_at = NOW()
    `, [
      today,
      accountIds.length,
      inventory.totalResources,
      inventory.byService.length,
      JSON.stringify(costSummary),
      JSON.stringify(inventorySummary),
      JSON.stringify(opportunities),
      JSON.stringify(metricsSummary),
    ]);

    console.log(`[finops-snapshot] Done. ${inventory.totalResources} resources, ${allMetrics.length} metrics, cost: ${costSummary.totalCost || 0}`);

    return NextResponse.json({
      success: true,
      date: today,
      accounts: accountIds.length,
      resources: inventory.totalResources,
      metrics: allMetrics.length,
      cost: costSummary.totalCost || 0,
      opportunities: opportunities.length,
    });
  } catch (err) {
    console.error("[finops-snapshot] Error:", err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
