/**
 * Direct Athena CUR client.
 * Queries the Cost and Usage Report directly from the portal,
 * bypassing the Lambda relay.
 *
 * Connection: portal IRSA → AssumeRole → Cur-AWSS3CURLambdaExecutor (600700800900)
 *             → Athena (athenacurcfn_finnops.data) in eu-west-1
 */

import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-athena";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

const ATHENA_REGION = "eu-west-1";
const ATHENA_DATABASE = "athenacurcfn_finnops";
const ATHENA_OUTPUT = "s3://finnops-iskaypet/athena-query-results/";
const CUR_ROLE_ARN = "arn:aws:iam::600700800900:role/Cur-AWSS3CURLambdaExecutor-Y5pT9wqNQaur";
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 120; // 3 min max

async function getAthenaClient(): Promise<AthenaClient> {
  const sts = new STSClient({ region: ATHENA_REGION });
  const assumed = await sts.send(new AssumeRoleCommand({
    RoleArn: CUR_ROLE_ARN,
    RoleSessionName: "portal-athena-cur",
    DurationSeconds: 900,
  }));

  return new AthenaClient({
    region: ATHENA_REGION,
    credentials: {
      accessKeyId: assumed.Credentials!.AccessKeyId!,
      secretAccessKey: assumed.Credentials!.SecretAccessKey!,
      sessionToken: assumed.Credentials!.SessionToken!,
    },
  });
}

export async function executeAthenaQuery(sql: string): Promise<Record<string, string>[]> {
  const client = await getAthenaClient();

  const start = await client.send(new StartQueryExecutionCommand({
    QueryString: sql,
    QueryExecutionContext: { Database: ATHENA_DATABASE },
    ResultConfiguration: { OutputLocation: ATHENA_OUTPUT },
  }));

  const executionId = start.QueryExecutionId!;

  // Poll until complete
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const status = await client.send(new GetQueryExecutionCommand({ QueryExecutionId: executionId }));
    const state = status.QueryExecution?.Status?.State;
    if (state === "SUCCEEDED") break;
    if (state === "FAILED" || state === "CANCELLED") {
      throw new Error(`Athena query ${state}: ${status.QueryExecution?.Status?.StateChangeReason}`);
    }
  }

  // Fetch results — use header row for column names
  const rows: Record<string, string>[] = [];
  let columns: string[] = [];
  let nextToken: string | undefined;
  let isFirst = true;

  do {
    const results = await client.send(new GetQueryResultsCommand({
      QueryExecutionId: executionId,
      MaxResults: 1000,
      ...(nextToken ? { NextToken: nextToken } : {}),
    }));

    const resultRows = results.ResultSet?.Rows || [];

    for (let i = 0; i < resultRows.length; i++) {
      const data = resultRows[i].Data || [];
      if (isFirst && i === 0) {
        // First row is the header
        columns = data.map((d) => d.VarCharValue || `col_${i}`);
        isFirst = false;
        continue;
      }
      const row: Record<string, string> = {};
      for (let j = 0; j < columns.length && j < data.length; j++) {
        row[columns[j]] = data[j].VarCharValue || "";
      }
      rows.push(row);
    }

    if (isFirst) isFirst = false; // no header skip on subsequent pages
    nextToken = results.NextToken;
  } while (nextToken);

  return rows;
}

async function executeQuery(sql: string, columns: string[]): Promise<Record<string, string>[]> {
  const client = await getAthenaClient();

  const start = await client.send(new StartQueryExecutionCommand({
    QueryString: sql,
    QueryExecutionContext: { Database: ATHENA_DATABASE },
    ResultConfiguration: { OutputLocation: ATHENA_OUTPUT },
  }));

  const executionId = start.QueryExecutionId!;

  // Poll until complete
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const status = await client.send(new GetQueryExecutionCommand({ QueryExecutionId: executionId }));
    const state = status.QueryExecution?.Status?.State;

    if (state === "SUCCEEDED") break;
    if (state === "FAILED" || state === "CANCELLED") {
      throw new Error(`Athena query ${state}: ${status.QueryExecution?.Status?.StateChangeReason}`);
    }
  }

  // Fetch results
  const rows: Record<string, string>[] = [];
  let nextToken: string | undefined;

  do {
    const results = await client.send(new GetQueryResultsCommand({
      QueryExecutionId: executionId,
      MaxResults: 1000,
      ...(nextToken ? { NextToken: nextToken } : {}),
    }));

    const resultRows = results.ResultSet?.Rows || [];
    const startIdx = nextToken ? 0 : 1; // Skip header on first page

    for (let i = startIdx; i < resultRows.length; i++) {
      const row: Record<string, string> = {};
      const data = resultRows[i].Data || [];
      for (let j = 0; j < columns.length && j < data.length; j++) {
        row[columns[j]] = data[j].VarCharValue || "";
      }
      rows.push(row);
    }

    nextToken = results.NextToken;
  } while (nextToken);

  return rows;
}

// ─── Public query functions ─────────────────────────────────────────────────

function accountIdsToSql(ids: string[]): string {
  return ids.map((id) => `'${id}'`).join(",");
}

function roundMoney(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Builds the AI cost daily series (Kiro + Bedrock) from the grouped CUR rows
 * (day, account_id, source, cost). Pure aggregation: friendly account names,
 * rounded per-account components, day/period totals, and anomaly days
 * (mean + 2*stddev AND > 1.5*mean; [] with <= 1 day).
 */
function buildAiCostDaily(
  rows: Record<string, string>[],
  accountNameMap: Record<string, string>,
): CurFullSnapshot["aiCostDaily"] {
  // dayMap: date -> (accountId -> { kiro, bedrock })
  const dayMap = new Map<string, Map<string, { kiro: number; bedrock: number }>>();
  for (const r of rows) {
    const date = String(r.day || "");
    if (!date) continue;
    const accountId = String(r.account_id || "");
    const source = String(r.source || "");
    const cost = Number(r.cost) || 0;
    let accounts = dayMap.get(date);
    if (!accounts) {
      accounts = new Map();
      dayMap.set(date, accounts);
    }
    let entry = accounts.get(accountId);
    if (!entry) {
      entry = { kiro: 0, bedrock: 0 };
      accounts.set(accountId, entry);
    }
    if (source === "kiro") entry.kiro += cost;
    else entry.bedrock += cost;
  }

  const days = [...dayMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, accounts]) => {
      let kiroCost = 0;
      let bedrockCost = 0;
      const byAccount = [...accounts.entries()]
        .map(([accountId, c]) => {
          const k = roundMoney(c.kiro);
          const b = roundMoney(c.bedrock);
          kiroCost += k;
          bedrockCost += b;
          return {
            accountId,
            accountName: accountNameMap[accountId] || accountId,
            kiroCost: k,
            bedrockCost: b,
            totalCost: roundMoney(k + b),
          };
        })
        .filter((a) => a.totalCost !== 0)
        .sort((a, b) => b.totalCost - a.totalCost);
      kiroCost = roundMoney(kiroCost);
      bedrockCost = roundMoney(bedrockCost);
      return { date, kiroCost, bedrockCost, totalAiCost: roundMoney(kiroCost + bedrockCost), byAccount };
    });

  // Anomaly detection over the window (mean + 2σ AND > 1.5*mean).
  let anomalyDays: string[] = [];
  if (days.length > 1) {
    const totals = days.map((d) => d.totalAiCost);
    const n = totals.length;
    const mean = totals.reduce((s, v) => s + v, 0) / n;
    const variance = totals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n;
    const stddev = Math.sqrt(variance);
    const upper = mean + 2 * stddev;
    const relative = 1.5 * mean;
    anomalyDays = days.filter((d) => d.totalAiCost > upper && d.totalAiCost > relative).map((d) => d.date);
  }

  const totals = days.reduce(
    (acc, d) => {
      acc.kiro += d.kiroCost;
      acc.bedrock += d.bedrockCost;
      acc.total += d.totalAiCost;
      return acc;
    },
    { kiro: 0, bedrock: 0, total: 0 },
  );

  return {
    days,
    anomalyDays,
    totals: { kiro: roundMoney(totals.kiro), bedrock: roundMoney(totals.bedrock), total: roundMoney(totals.total) },
  };
}

export interface CurCostByAccount {
  accountId: string;
  accountName: string;
  cost: number;
  services: Array<{ service: string; cost: number }>;
}

export interface CurCostByService {
  service: string;
  cost: number;
}

export interface CurDailyCost {
  day: string;
  cost: number;
  netCost: number;
}

export interface CurTopResource {
  accountId: string;
  service: string;
  resourceId: string;
  cost: number;
  instanceType: string;
}

export interface CurPricingModel {
  model: string;
  cost: number;
  onDemandEquivalent: number;
}

export interface CurFullSnapshot {
  window: { startDate: string; endDate: string };
  totalCost: number;
  netCost: number;
  /** Net infrastructure cost (totalCost minus marketplace contracts/SPP/credits/bundle) */
  netInfraCost: number;
  /** Marketplace flexible payment & software usage charges, separated from infra */
  marketplace: {
    cost: number;
    items: Array<{ productCode: string; description: string; cost: number; date: string | null }>;
  };
  /** Reseller and partner discounts (negative), credits, bundle discounts */
  discounts: {
    sppDiscount: number;
    bundledDiscount: number;
    credits: number;
    refunds: number;
    savingsPlanNegation: number;
    tax: number;
  };
  byAccount: CurCostByAccount[];
  byService: CurCostByService[];
  dailyCosts: CurDailyCost[];
  topResources: CurTopResource[];
  pricingModel: CurPricingModel[];
  savingsPlans: {
    coveredCost: number;
    onDemandEquivalent: number;
    savingsAmount: number;
    savingsPct: number;
  };
  onDemandExposure: {
    cost: number;
    pct: number;
  };
  // New dimensions
  byDomain: Array<{ domain: string; cost: number; netCost: number; resources: number }>;
  byEnvironment: Array<{ environment: string; cost: number; resources: number }>;
  tagCoverage: {
    taggedCost: number;
    untaggedCost: number;
    coveragePct: number;
  };
  spDetails: Array<{
    arn: string;
    type: string;
    endTime: string;
    effectiveCost: number;
    onDemandEquivalent: number;
    savingsPct: number;
  }>;
  /** Hidden costs / quick wins detected programmatically */
  hiddenCosts: {
    gp2Volumes: { monthlyCost: number; estimatedSavings: number; resourceCount: number };
    gp2Detail: Array<{ resourceId: string; account: string; gbMonth: number; cost: number }>;
    extendedSupport: Array<{ engine: string; monthlyCost: number; usageType: string }>;
    extendedSupportDetail: Array<{ resourceId: string; account: string; engine: string; cost: number }>;
    cloudwatchLogs: { totalCost: number; topGroups: Array<{ logGroup: string; cost: number; account: string }> };
    natGateways: { totalCost: number; dataProcessedCost: number; hoursCost: number; topConsumers: Array<{ resourceId: string; account: string; cost: number }> };
    bedrock: { totalCost: number; byModel: Array<{ model: string; account: string; accountName?: string; cost: number }>; monthlyTrend: Array<{ month: string; cost: number }> };
    snapshotCost: number;
    interZoneTransfer: number;
  };
  /** EC2 instance type fleet breakdown, scoped per account */
  ec2Fleet: Array<{ instanceType: string; accountId: string; accountName: string; resourceCount: number; cost: number }>;
  /** Tagging compliance per mandatory tag key */
  tagCompliance: Array<{
    tagKey: string;
    taggedCost: number;
    untaggedCost: number;
    coveragePct: number;
    distinctValues: number;
  }>;
  /** For each anomalous day, breakdown of top 5 services that drove the spike */
  anomalyAttribution: Array<{
    day: string;
    cost: number;
    deviation: number;
    topServices: Array<{ service: string; cost: number }>;
    topResources: Array<{ resourceId: string; service: string; cost: number; account: string }>;
  }>;
  /** AI cost (Kiro + Bedrock) daily series for the selected accounts/range, with
   *  per-account breakdown and friendly account names. Drives the AI cost history chart. */
  aiCostDaily: {
    days: Array<{
      date: string;
      kiroCost: number;
      bedrockCost: number;
      totalAiCost: number;
      byAccount: Array<{ accountId: string; accountName: string; kiroCost: number; bedrockCost: number; totalCost: number }>;
    }>;
    anomalyDays: string[];
    totals: { kiro: number; bedrock: number; total: number };
  };
}

export async function fetchCurFullSnapshot(
  accountIds: string[],
  startDate: string,
  endDate: string,
  accountNameMap: Record<string, string> = {}
): Promise<CurFullSnapshot> {
  const idsStr = accountIdsToSql(accountIds);
  const endExclusive = nextDay(endDate);

  // ── Account-scope audit (Req 1.3, 2.2) ──────────────────────────────────────
  // Every sub-query whose rows carry an account dimension MUST filter by the
  // selected account set via `line_item_usage_account_id IN (${idsStr})`. Audited
  // and confirmed present on each of the following (numbers match the query order):
  //   #1  byAccount               ✓ filtered + groups by account_id
  //   #3  topResources            ✓ filtered + projects account_id
  //   #12 ec2Fleet                ✓ filtered + groups/projects account_id (added here)
  //   #15 cloudwatchLogs.topGroups✓ filtered + projects account_id
  //   #16 natGateways.topConsumers✓ filtered + projects account_id
  //   #17 bedrock.byModel         ✓ filtered + projects account_id
  //   #19 gp2Detail               ✓ filtered + projects account_id
  //   #20 extendedSupportDetail   ✓ filtered + projects account_id
  //   #23 aiCostDaily.byAccount   ✓ filtered + projects account_id
  // Account-agnostic aggregates (#2 daily, #4 pricing, #11 discounts, etc.) carry
  // the same WHERE filter so their totals are also scoped, even without a per-row account.

  // Run all queries in parallel
  const [costRows, dailyRows, resourceRows, pricingRows, spRows, domainRows, envRows, tagCoverageRows, spDetailRows,
    marketplaceRows, discountRows, ec2FleetRows, gp2Rows, extSupportRows, cwlogsRows, natGwRows, bedrockRows, snapInterzoneRows,
    gp2DetailRows, extSupportDetailRows, bedrockTrendRows, tagComplianceRows, aiCostDailyRows] = await Promise.all([
    // 1. Cost by account + service
    executeQuery(`
      SELECT
        line_item_usage_account_id AS account_id,
        line_item_product_code AS service,
        SUM(line_item_unblended_cost) AS cost
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_line_item_type IN ('Usage','Tax','Fee')
        AND line_item_usage_account_id IN (${idsStr})
      GROUP BY 1, 2
      ORDER BY 1, cost DESC
    `, ["account_id", "service", "cost"]),

    // 2. Daily costs
    executeQuery(`
      SELECT
        date_format(line_item_usage_start_date, '%Y-%m-%d') AS day,
        SUM(line_item_unblended_cost) AS cost,
        SUM(line_item_net_unblended_cost) AS net_cost
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_line_item_type IN ('Usage','Tax','Fee')
        AND line_item_usage_account_id IN (${idsStr})
      GROUP BY 1
      ORDER BY 1
    `, ["day", "cost", "net_cost"]),

    // 3. Top resources
    executeQuery(`
      SELECT
        line_item_usage_account_id AS account_id,
        line_item_product_code AS service,
        line_item_resource_id AS resource_id,
        SUM(line_item_unblended_cost) AS cost,
        MAX(product_instance_type) AS instance_type
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_line_item_type IN ('Usage','Tax','Fee')
        AND line_item_usage_account_id IN (${idsStr})
        AND line_item_resource_id IS NOT NULL
        AND TRIM(line_item_resource_id) != ''
      GROUP BY 1, 2, 3
      HAVING SUM(line_item_unblended_cost) > 0
      ORDER BY cost DESC
      LIMIT 200
    `, ["account_id", "service", "resource_id", "cost", "instance_type"]),

    // 4. Pricing model breakdown
    executeQuery(`
      SELECT
        CASE
          WHEN savings_plan_savings_plan_a_r_n IS NOT NULL THEN 'SavingsPlan'
          WHEN reservation_reservation_a_r_n IS NOT NULL THEN 'Reserved'
          WHEN pricing_term = 'Spot' OR line_item_usage_type LIKE '%Spot%' THEN 'Spot'
          ELSE 'OnDemand'
        END AS pricing_model,
        SUM(line_item_unblended_cost) AS cost,
        SUM(pricing_public_on_demand_cost) AS on_demand_equivalent
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_line_item_type IN ('Usage','Fee')
        AND line_item_usage_account_id IN (${idsStr})
      GROUP BY 1
    `, ["pricing_model", "cost", "on_demand_equivalent"]),

    // 5. Savings Plans coverage
    executeQuery(`
      SELECT
        SUM(savings_plan_savings_plan_effective_cost) AS sp_covered_cost,
        SUM(pricing_public_on_demand_cost) AS on_demand_equivalent
      FROM ${ATHENA_DATABASE}.data
      WHERE savings_plan_savings_plan_a_r_n IS NOT NULL
        AND line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_usage_account_id IN (${idsStr})
    `, ["sp_covered_cost", "on_demand_equivalent"]),

    // 6. Cost by domain (user_domain tag)
    executeQuery(`
      SELECT
        resource_tags['user_domain'] AS domain,
        SUM(line_item_unblended_cost) AS cost,
        SUM(line_item_net_unblended_cost) AS net_cost,
        COUNT(DISTINCT line_item_resource_id) AS resources
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage')
        AND line_item_usage_account_id IN (${idsStr})
        AND resource_tags['user_domain'] IS NOT NULL
        AND resource_tags['user_domain'] != ''
      GROUP BY 1
      ORDER BY cost DESC
    `, ["domain", "cost", "net_cost", "resources"]),

    // 7. Cost by environment (user_environment tag)
    executeQuery(`
      SELECT
        resource_tags['user_environment'] AS environment,
        SUM(line_item_unblended_cost) AS cost,
        COUNT(DISTINCT line_item_resource_id) AS resources
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage')
        AND line_item_usage_account_id IN (${idsStr})
        AND resource_tags['user_environment'] IS NOT NULL
        AND resource_tags['user_environment'] != ''
      GROUP BY 1
      ORDER BY cost DESC
    `, ["environment", "cost", "resources"]),

    // 8. Tag coverage (tagged vs untagged cost)
    executeQuery(`
      SELECT
        CASE
          WHEN resource_tags IS NOT NULL AND resource_tags['user_domain'] IS NOT NULL AND resource_tags['user_domain'] != '' THEN 'tagged'
          ELSE 'untagged'
        END AS tag_status,
        SUM(line_item_unblended_cost) AS cost
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage')
        AND line_item_usage_account_id IN (${idsStr})
      GROUP BY 1
    `, ["tag_status", "cost"]),

    // 9. Savings Plan details (ARN, type, expiration)
    executeQuery(`
      SELECT
        savings_plan_savings_plan_a_r_n AS arn,
        savings_plan_offering_type AS sp_type,
        savings_plan_end_time AS end_time,
        SUM(savings_plan_savings_plan_effective_cost) AS effective_cost,
        SUM(pricing_public_on_demand_cost) AS on_demand_equivalent
      FROM ${ATHENA_DATABASE}.data
      WHERE savings_plan_savings_plan_a_r_n IS NOT NULL
        AND savings_plan_savings_plan_a_r_n != ''
        AND line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_usage_account_id IN (${idsStr})
      GROUP BY 1, 2, 3
      ORDER BY effective_cost DESC
    `, ["arn", "sp_type", "end_time", "effective_cost", "on_demand_equivalent"]),

    // 10. Marketplace / software contracts (separate from infra)
    executeQuery(`
      SELECT
        line_item_product_code AS product_code,
        line_item_line_item_description AS description,
        date_format(line_item_usage_start_date, '%Y-%m-%d') AS day,
        SUM(line_item_unblended_cost) AS cost
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_usage_account_id IN (${idsStr})
        AND (
          line_item_usage_type LIKE 'Global-SoftwareUsage-Contracts'
          OR line_item_usage_type LIKE '%MP:%'
          OR line_item_usage_type LIKE '%Marketplace%'
        )
        AND line_item_unblended_cost > 0
      GROUP BY 1, 2, 3
      ORDER BY cost DESC
    `, ["product_code", "description", "day", "cost"]),

    // 11. Discounts / credits / SP negation breakdown
    executeQuery(`
      SELECT
        line_item_line_item_type AS item_type,
        SUM(line_item_unblended_cost) AS cost
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_usage_account_id IN (${idsStr})
        AND line_item_line_item_type IN ('Credit','Refund','SppDiscount','BundledDiscount','SavingsPlanNegation','Tax')
      GROUP BY 1
    `, ["item_type", "cost"]),

    // 12. EC2 fleet by instance type + account.
    // Account dimension (line_item_usage_account_id) is part of GROUP BY and the
    // projected row so every ec2Fleet entry is account-attributable and verifiable
    // by the endpoint/client scoping (Req 1.3, 2.2). WHERE filters by selected accounts.
    executeQuery(`
      SELECT
        product_instance_type AS instance_type,
        line_item_usage_account_id AS account_id,
        COUNT(DISTINCT line_item_resource_id) AS resources,
        SUM(line_item_unblended_cost) AS cost
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_usage_account_id IN (${idsStr})
        AND line_item_product_code = 'AmazonEC2'
        AND product_instance_type IS NOT NULL
        AND product_instance_type != ''
        AND line_item_line_item_type IN ('Usage','Fee')
      GROUP BY product_instance_type, line_item_usage_account_id
      ORDER BY cost DESC
      LIMIT 30
    `, ["instance_type", "account_id", "resources", "cost"]),

    // 13. EBS gp2 detector (waste hunt)
    executeQuery(`
      SELECT
        SUM(line_item_unblended_cost) AS cost,
        COUNT(DISTINCT line_item_resource_id) AS resources,
        SUM(line_item_usage_amount) AS gb_month
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_usage_account_id IN (${idsStr})
        AND line_item_usage_type LIKE '%EBS:VolumeUsage.gp2%'
        AND line_item_line_item_type = 'Usage'
    `, ["cost", "resources", "gb_month"]),

    // 14. RDS Extended Support charges
    executeQuery(`
      SELECT
        line_item_usage_type AS usage_type,
        SUM(line_item_unblended_cost) AS cost
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_usage_account_id IN (${idsStr})
        AND line_item_usage_type LIKE '%ExtendedSupport%'
        AND line_item_line_item_type IN ('Usage','Fee')
      GROUP BY 1
      ORDER BY cost DESC
    `, ["usage_type", "cost"]),

    // 15. CloudWatch Logs top groups
    executeQuery(`
      SELECT
        line_item_resource_id AS log_group,
        line_item_usage_account_id AS account_id,
        SUM(line_item_unblended_cost) AS cost
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_usage_account_id IN (${idsStr})
        AND line_item_product_code = 'AmazonCloudWatch'
        AND line_item_resource_id IS NOT NULL
        AND TRIM(line_item_resource_id) <> ''
        AND line_item_line_item_type IN ('Usage','Fee')
      GROUP BY 1, 2
      HAVING SUM(line_item_unblended_cost) > 5
      ORDER BY cost DESC
      LIMIT 20
    `, ["log_group", "account_id", "cost"]),

    // 16. NAT Gateway breakdown by resource and kind (hours vs data)
    executeQuery(`
      SELECT
        line_item_resource_id AS resource_id,
        line_item_usage_account_id AS account_id,
        CASE
          WHEN line_item_usage_type LIKE '%NatGateway-Hours%' THEN 'hours'
          WHEN line_item_usage_type LIKE '%NatGateway-Bytes%' THEN 'data'
          ELSE 'other'
        END AS kind,
        SUM(line_item_unblended_cost) AS cost
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_usage_account_id IN (${idsStr})
        AND line_item_usage_type LIKE '%NatGateway%'
        AND line_item_line_item_type = 'Usage'
        AND line_item_resource_id IS NOT NULL
        AND TRIM(line_item_resource_id) <> ''
      GROUP BY 1, 2, 3
      ORDER BY cost DESC
    `, ["resource_id", "account_id", "kind", "cost"]),

    // 17. Bedrock / GenAI by inference profile
    executeQuery(`
      SELECT
        line_item_resource_id AS resource_id,
        line_item_usage_account_id AS account_id,
        SUM(line_item_unblended_cost) AS cost
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_usage_account_id IN (${idsStr})
        AND line_item_resource_id LIKE 'arn:aws:bedrock:%'
        AND line_item_line_item_type IN ('Usage','Fee')
      GROUP BY 1, 2
      HAVING SUM(line_item_unblended_cost) > 0
      ORDER BY cost DESC
      LIMIT 20
    `, ["resource_id", "account_id", "cost"]),

    // 18. Snapshot + InterZone signals (additional waste hints)
    executeQuery(`
      SELECT
        CASE
          WHEN line_item_operation = 'CreateSnapshot' THEN 'snapshot'
          WHEN line_item_operation IN ('InterZone-In','InterZone-Out') THEN 'interzone'
          ELSE 'other'
        END AS bucket,
        SUM(line_item_unblended_cost) AS cost
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_usage_account_id IN (${idsStr})
        AND line_item_operation IN ('CreateSnapshot','InterZone-In','InterZone-Out')
        AND line_item_line_item_type IN ('Usage','Fee')
      GROUP BY 1
    `, ["bucket", "cost"]),

    // 19. gp2 detail per resource — actionable migration list
    executeQuery(`
      SELECT
        line_item_resource_id AS resource_id,
        line_item_usage_account_id AS account_id,
        SUM(line_item_usage_amount) AS gb_month,
        SUM(line_item_unblended_cost) AS cost
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_usage_account_id IN (${idsStr})
        AND line_item_usage_type LIKE '%EBS:VolumeUsage.gp2%'
        AND line_item_line_item_type = 'Usage'
        AND line_item_resource_id IS NOT NULL
        AND TRIM(line_item_resource_id) <> ''
      GROUP BY 1, 2
      HAVING SUM(line_item_unblended_cost) > 1
      ORDER BY cost DESC
      LIMIT 30
    `, ["resource_id", "account_id", "gb_month", "cost"]),

    // 20. Extended Support detail per resource (RDS instance ARN)
    executeQuery(`
      SELECT
        line_item_resource_id AS resource_id,
        line_item_usage_account_id AS account_id,
        line_item_usage_type AS usage_type,
        SUM(line_item_unblended_cost) AS cost
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_usage_account_id IN (${idsStr})
        AND line_item_usage_type LIKE '%ExtendedSupport%'
        AND line_item_line_item_type IN ('Usage','Fee')
        AND line_item_resource_id IS NOT NULL
        AND TRIM(line_item_resource_id) <> ''
      GROUP BY 1, 2, 3
      ORDER BY cost DESC
      LIMIT 30
    `, ["resource_id", "account_id", "usage_type", "cost"]),

    // 21. Bedrock 3-month trend
    executeQuery(`
      SELECT
        date_format(date_trunc('month', line_item_usage_start_date), '%Y-%m') AS month,
        SUM(line_item_unblended_cost) AS cost
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${addMonths(startDate, -3)}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_usage_account_id IN (${idsStr})
        AND line_item_resource_id LIKE 'arn:aws:bedrock:%'
        AND line_item_line_item_type IN ('Usage','Fee')
      GROUP BY 1
      ORDER BY 1
    `, ["month", "cost"]),

    // 22. Tag compliance per mandatory tag key (user_department, user_domain, user_environment)
    executeQuery(`
      WITH per_tag AS (
        SELECT 'user_domain' AS tag_key,
          SUM(CASE WHEN resource_tags['user_domain'] IS NOT NULL AND resource_tags['user_domain']<>'' THEN line_item_unblended_cost ELSE 0 END) AS tagged_cost,
          SUM(CASE WHEN resource_tags['user_domain'] IS NULL OR resource_tags['user_domain']='' THEN line_item_unblended_cost ELSE 0 END) AS untagged_cost,
          COUNT(DISTINCT CASE WHEN resource_tags['user_domain'] IS NOT NULL AND resource_tags['user_domain']<>'' THEN resource_tags['user_domain'] END) AS distinct_values
        FROM ${ATHENA_DATABASE}.data
        WHERE line_item_usage_start_date >= DATE '${startDate}' AND line_item_usage_start_date < DATE '${endExclusive}'
          AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage','Fee')
          AND line_item_usage_account_id IN (${idsStr})
        UNION ALL
        SELECT 'user_environment',
          SUM(CASE WHEN resource_tags['user_environment'] IS NOT NULL AND resource_tags['user_environment']<>'' THEN line_item_unblended_cost ELSE 0 END),
          SUM(CASE WHEN resource_tags['user_environment'] IS NULL OR resource_tags['user_environment']='' THEN line_item_unblended_cost ELSE 0 END),
          COUNT(DISTINCT CASE WHEN resource_tags['user_environment'] IS NOT NULL AND resource_tags['user_environment']<>'' THEN resource_tags['user_environment'] END)
        FROM ${ATHENA_DATABASE}.data
        WHERE line_item_usage_start_date >= DATE '${startDate}' AND line_item_usage_start_date < DATE '${endExclusive}'
          AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage','Fee')
          AND line_item_usage_account_id IN (${idsStr})
        UNION ALL
        SELECT 'user_department',
          SUM(CASE WHEN resource_tags['user_department'] IS NOT NULL AND resource_tags['user_department']<>'' THEN line_item_unblended_cost ELSE 0 END),
          SUM(CASE WHEN resource_tags['user_department'] IS NULL OR resource_tags['user_department']='' THEN line_item_unblended_cost ELSE 0 END),
          COUNT(DISTINCT CASE WHEN resource_tags['user_department'] IS NOT NULL AND resource_tags['user_department']<>'' THEN resource_tags['user_department'] END)
        FROM ${ATHENA_DATABASE}.data
        WHERE line_item_usage_start_date >= DATE '${startDate}' AND line_item_usage_start_date < DATE '${endExclusive}'
          AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage','Fee')
          AND line_item_usage_account_id IN (${idsStr})
      )
      SELECT tag_key, tagged_cost, untagged_cost, distinct_values FROM per_tag
    `, ["tag_key", "tagged_cost", "untagged_cost", "distinct_values"]),

    // 23. AI cost per day + account + source (Kiro licenses + Bedrock inference).
    // Single grouped query (no per-day loop): drives the AI cost history chart,
    // reactive to the selected accounts + date range like the rest of the screen.
    executeQuery(`
      SELECT
        date_format(line_item_usage_start_date, '%Y-%m-%d') AS day,
        line_item_usage_account_id AS account_id,
        CASE WHEN line_item_product_code = 'Kiro' THEN 'kiro' ELSE 'bedrock' END AS source,
        SUM(line_item_unblended_cost) AS cost
      FROM ${ATHENA_DATABASE}.data
      WHERE line_item_usage_start_date >= DATE '${startDate}'
        AND line_item_usage_start_date < DATE '${endExclusive}'
        AND line_item_usage_account_id IN (${idsStr})
        AND (
          line_item_product_code = 'Kiro'
          OR line_item_resource_id LIKE 'arn:aws:bedrock:%'
        )
        AND line_item_line_item_type IN ('Usage','Fee','FlatRateSubscription','Credit','SppDiscount')
      GROUP BY 1, 2, 3
      ORDER BY 1 ASC
    `, ["day", "account_id", "source", "cost"]),
  ]);

  // Aggregate by account
  const accountMap = new Map<string, { cost: number; services: Map<string, number> }>();
  const serviceMap = new Map<string, number>();
  let totalCost = 0;

  for (const row of costRows) {
    const cost = Number(row.cost) || 0;
    totalCost += cost;

    if (!accountMap.has(row.account_id)) {
      accountMap.set(row.account_id, { cost: 0, services: new Map() });
    }
    const acc = accountMap.get(row.account_id)!;
    acc.cost += cost;
    acc.services.set(row.service, (acc.services.get(row.service) || 0) + cost);

    serviceMap.set(row.service, (serviceMap.get(row.service) || 0) + cost);
  }

  const byAccount: CurCostByAccount[] = [...accountMap.entries()]
    .map(([id, data]) => ({
      accountId: id,
      accountName: accountNameMap[id] || id,
      cost: roundMoney(data.cost),
      services: [...data.services.entries()]
        .map(([service, cost]) => ({ service, cost: roundMoney(cost) }))
        .sort((a, b) => b.cost - a.cost),
    }))
    .sort((a, b) => b.cost - a.cost);

  const byService: CurCostByService[] = [...serviceMap.entries()]
    .map(([service, cost]) => ({ service, cost: roundMoney(cost) }))
    .sort((a, b) => b.cost - a.cost);

  const dailyCosts: CurDailyCost[] = dailyRows.map((r) => ({
    day: r.day,
    cost: roundMoney(Number(r.cost) || 0),
    netCost: roundMoney(Number(r.net_cost) || 0),
  }));

  const netCost = dailyCosts.reduce((sum, d) => sum + d.netCost, 0);

  const topResources: CurTopResource[] = resourceRows.map((r) => ({
    accountId: r.account_id,
    service: r.service,
    resourceId: r.resource_id,
    cost: roundMoney(Number(r.cost) || 0),
    instanceType: r.instance_type || "",
  }));

  const pricingModel: CurPricingModel[] = pricingRows.map((r) => ({
    model: r.pricing_model,
    cost: roundMoney(Number(r.cost) || 0),
    onDemandEquivalent: roundMoney(Number(r.on_demand_equivalent) || 0),
  }));

  const spCovered = Number(spRows[0]?.sp_covered_cost) || 0;
  const spOnDemandEq = Number(spRows[0]?.on_demand_equivalent) || 0;
  const spSavings = spOnDemandEq - spCovered;

  const onDemandCost = pricingModel.find((p) => p.model === "OnDemand")?.cost || 0;
  const totalUsageCost = pricingModel.reduce((s, p) => s + p.cost, 0);

  // Marketplace separation
  const marketplaceCostRaw = marketplaceRows.reduce((sum, r) => sum + Number(r.cost || 0), 0);
  const marketplaceItems = marketplaceRows.map((r) => ({
    productCode: String(r.product_code || ""),
    description: String(r.description || ""),
    cost: roundMoney(Number(r.cost) || 0),
    date: r.day || null,
  }));
  const marketplaceCost = roundMoney(marketplaceCostRaw);

  // Discounts breakdown
  const discountIndex = new Map(discountRows.map((r) => [String(r.item_type), Number(r.cost || 0)]));
  const discounts = {
    sppDiscount: roundMoney(discountIndex.get("SppDiscount") || 0),
    bundledDiscount: roundMoney(discountIndex.get("BundledDiscount") || 0),
    credits: roundMoney(discountIndex.get("Credit") || 0),
    refunds: roundMoney(discountIndex.get("Refund") || 0),
    savingsPlanNegation: roundMoney(discountIndex.get("SavingsPlanNegation") || 0),
    tax: roundMoney(discountIndex.get("Tax") || 0),
  };

  // EC2 fleet — each row carries its account so the entry is verifiable against
  // the selected account set (accountName resolved via accountNameMap).
  const ec2Fleet = ec2FleetRows.map((r) => {
    const accountId = String(r.account_id || "");
    return {
      instanceType: String(r.instance_type || "unknown"),
      accountId,
      accountName: accountNameMap[accountId] || accountId,
      resourceCount: Number(r.resources || 0),
      cost: roundMoney(Number(r.cost) || 0),
    };
  });

  // Hidden costs detector
  const gp2Row = gp2Rows[0] || {};
  const gp2Cost = Number(gp2Row.cost) || 0;
  const gp2Resources = Number(gp2Row.resources) || 0;
  const gp2Savings = gp2Cost * 0.20; // gp3 is ~20% cheaper than gp2 for the same IOPS

  const extendedSupport = extSupportRows.map((r) => {
    const usageType = String(r.usage_type || "");
    const engineMatch = usageType.match(/Yr\d+:?\w*[-:]?(\w+\d+)/);
    return {
      engine: engineMatch?.[1] || usageType.split(":").pop() || "unknown",
      usageType,
      monthlyCost: roundMoney(Number(r.cost) || 0),
    };
  });

  const cwLogsTotal = cwlogsRows.reduce((sum, r) => sum + Number(r.cost || 0), 0);
  const cwLogsTop = cwlogsRows.slice(0, 15).map((r) => ({
    logGroup: String(r.log_group || ""),
    cost: roundMoney(Number(r.cost) || 0),
    account: String(r.account_id || ""),
  }));

  const natGwByResource = new Map<string, { account: string; cost: number }>();
  let natHoursCost = 0;
  let natDataCost = 0;
  for (const r of natGwRows) {
    const rid = String(r.resource_id || "");
    const acc = String(r.account_id || "");
    const cost = Number(r.cost) || 0;
    if (r.kind === "hours") natHoursCost += cost;
    if (r.kind === "data") natDataCost += cost;
    if (!rid) continue;
    const existing = natGwByResource.get(rid);
    if (existing) existing.cost += cost;
    else natGwByResource.set(rid, { account: acc, cost });
  }
  const natTopConsumers = [...natGwByResource.entries()]
    .map(([resourceId, v]) => ({ resourceId, account: v.account, cost: roundMoney(v.cost) }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10);

  const bedrockTotal = bedrockRows.reduce((sum, r) => sum + Number(r.cost || 0), 0);
  const bedrockByModel = bedrockRows.map((r) => {
    const arn = String(r.resource_id || "");
    const modelMatch = arn.match(/inference-profile\/([^\s]+)$/);
    const accountId = String(r.account_id || "");
    return {
      model: modelMatch?.[1] || arn.split("/").pop() || "unknown",
      account: accountId,
      accountName: accountNameMap[accountId] || accountId,
      cost: roundMoney(Number(r.cost) || 0),
    };
  });
  const bedrockTrend = bedrockTrendRows.map((r) => ({
    month: String(r.month || ""),
    cost: roundMoney(Number(r.cost) || 0),
  }));

  const gp2Detail = gp2DetailRows.map((r) => ({
    resourceId: String(r.resource_id || ""),
    account: String(r.account_id || ""),
    gbMonth: Math.round(Number(r.gb_month) || 0),
    cost: roundMoney(Number(r.cost) || 0),
  }));

  const extendedSupportDetail = extSupportDetailRows.map((r) => {
    const usageType = String(r.usage_type || "");
    const engineMatch = usageType.match(/Yr\d+:?\w*[-:]?(\w+\d+)/);
    return {
      resourceId: String(r.resource_id || ""),
      account: String(r.account_id || ""),
      engine: engineMatch?.[1] || usageType.split(":").pop() || "unknown",
      cost: roundMoney(Number(r.cost) || 0),
    };
  });

  // Detect anomaly days from dailyCosts (μ + 2σ above mean) and pull breakdown for them
  const anomalyAttribution = await (async () => {
    if (dailyCosts.length < 4) return [];
    const costs = dailyCosts.map((d) => d.cost);
    const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
    const variance = costs.reduce((sum, c) => sum + (c - mean) ** 2, 0) / costs.length;
    const stddev = Math.sqrt(variance);
    const threshold = mean + 2 * stddev;
    const flaggedDays = dailyCosts
      .filter((d) => d.cost > threshold && d.cost > mean * 1.5)
      .map((d) => ({ ...d, deviation: stddev > 0 ? (d.cost - mean) / stddev : 0 }))
      .sort((a, b) => b.deviation - a.deviation)
      .slice(0, 8);
    if (flaggedDays.length === 0) return [];

    // For each flagged day, pull top services + top resources in parallel
    const breakdowns = await Promise.all(
      flaggedDays.map(async (day) => {
        const dayEnd = nextDay(day.day);
        try {
          const [serviceRows, resourceRows] = await Promise.all([
            executeQuery(
              `SELECT line_item_product_code AS service, SUM(line_item_unblended_cost) AS cost
               FROM ${ATHENA_DATABASE}.data
               WHERE line_item_usage_start_date >= DATE '${day.day}'
                 AND line_item_usage_start_date < DATE '${dayEnd}'
                 AND line_item_usage_account_id IN (${idsStr})
                 AND line_item_line_item_type IN ('Usage','Tax','Fee')
               GROUP BY 1 ORDER BY cost DESC LIMIT 5`,
              ["service", "cost"],
            ),
            executeQuery(
              `SELECT line_item_resource_id AS resource_id,
                      line_item_product_code AS service,
                      line_item_usage_account_id AS account_id,
                      SUM(line_item_unblended_cost) AS cost
               FROM ${ATHENA_DATABASE}.data
               WHERE line_item_usage_start_date >= DATE '${day.day}'
                 AND line_item_usage_start_date < DATE '${dayEnd}'
                 AND line_item_usage_account_id IN (${idsStr})
                 AND line_item_line_item_type IN ('Usage','Tax','Fee')
                 AND line_item_resource_id IS NOT NULL AND TRIM(line_item_resource_id) <> ''
               GROUP BY 1, 2, 3 ORDER BY cost DESC LIMIT 5`,
              ["resource_id", "service", "account_id", "cost"],
            ),
          ]);
          return {
            day: day.day,
            cost: day.cost,
            deviation: roundMoney(day.deviation),
            topServices: serviceRows.map((r) => ({
              service: String(r.service || "Unknown"),
              cost: roundMoney(Number(r.cost) || 0),
            })),
            topResources: resourceRows.map((r) => ({
              resourceId: String(r.resource_id || ""),
              service: String(r.service || "Unknown"),
              account: accountNameMap[String(r.account_id)] || String(r.account_id || ""),
              cost: roundMoney(Number(r.cost) || 0),
            })),
          };
        } catch {
          return {
            day: day.day,
            cost: day.cost,
            deviation: roundMoney(day.deviation),
            topServices: [],
            topResources: [],
          };
        }
      }),
    );
    return breakdowns;
  })();

  const tagCompliance = tagComplianceRows.map((r) => {
    const tagged = Number(r.tagged_cost) || 0;
    const untagged = Number(r.untagged_cost) || 0;
    const total = tagged + untagged;
    return {
      tagKey: String(r.tag_key || ""),
      taggedCost: roundMoney(tagged),
      untaggedCost: roundMoney(untagged),
      coveragePct: total > 0 ? roundMoney((tagged / total) * 100) : 0,
      distinctValues: Number(r.distinct_values) || 0,
    };
  });

  const snapInterzoneIndex = new Map(snapInterzoneRows.map((r) => [String(r.bucket), Number(r.cost || 0)]));

  // AI cost daily series (Kiro + Bedrock) per account, with friendly names.
  const aiCostDaily = buildAiCostDaily(aiCostDailyRows, accountNameMap);

  // Net infrastructure cost = totalCost - marketplace + discounts (negative values reduce)
  // discounts (SppDiscount, etc.) are already in totalCost as negatives, so we keep them.
  const netInfraCost = roundMoney(totalCost - marketplaceCost);

  return {
    window: { startDate, endDate },
    totalCost: roundMoney(totalCost),
    netCost: roundMoney(netCost),
    netInfraCost,
    marketplace: {
      cost: marketplaceCost,
      items: marketplaceItems,
    },
    discounts,
    byAccount,
    byService,
    dailyCosts,
    topResources,
    pricingModel,
    savingsPlans: {
      coveredCost: roundMoney(spCovered),
      onDemandEquivalent: roundMoney(spOnDemandEq),
      savingsAmount: roundMoney(spSavings),
      savingsPct: spOnDemandEq > 0 ? roundMoney((spSavings / spOnDemandEq) * 100) : 0,
    },
    onDemandExposure: {
      cost: roundMoney(onDemandCost),
      pct: totalUsageCost > 0 ? roundMoney((onDemandCost / totalUsageCost) * 100) : 0,
    },
    // New dimensions
    byDomain: domainRows.map((r) => ({
      domain: r.domain,
      cost: roundMoney(Number(r.cost) || 0),
      netCost: roundMoney(Number(r.net_cost) || 0),
      resources: Number(r.resources) || 0,
    })),
    byEnvironment: envRows.map((r) => ({
      environment: r.environment,
      cost: roundMoney(Number(r.cost) || 0),
      resources: Number(r.resources) || 0,
    })),
    tagCoverage: (() => {
      const tagged = Number(tagCoverageRows.find((r) => r.tag_status === "tagged")?.cost) || 0;
      const untagged = Number(tagCoverageRows.find((r) => r.tag_status === "untagged")?.cost) || 0;
      const total = tagged + untagged;
      return {
        taggedCost: roundMoney(tagged),
        untaggedCost: roundMoney(untagged),
        coveragePct: total > 0 ? roundMoney((tagged / total) * 100) : 0,
      };
    })(),
    spDetails: spDetailRows.map((r) => {
      const eff = Number(r.effective_cost) || 0;
      const od = Number(r.on_demand_equivalent) || 0;
      return {
        arn: r.arn,
        type: r.sp_type || "Unknown",
        endTime: r.end_time || "",
        effectiveCost: roundMoney(eff),
        onDemandEquivalent: roundMoney(od),
        savingsPct: od > 0 ? roundMoney(((od - eff) / od) * 100) : 0,
      };
    }),
    hiddenCosts: {
      gp2Volumes: {
        monthlyCost: roundMoney(gp2Cost),
        estimatedSavings: roundMoney(gp2Savings),
        resourceCount: gp2Resources,
      },
      gp2Detail,
      extendedSupport,
      extendedSupportDetail,
      cloudwatchLogs: {
        totalCost: roundMoney(cwLogsTotal),
        topGroups: cwLogsTop,
      },
      natGateways: {
        totalCost: roundMoney(natHoursCost + natDataCost),
        dataProcessedCost: roundMoney(natDataCost),
        hoursCost: roundMoney(natHoursCost),
        topConsumers: natTopConsumers,
      },
      bedrock: {
        totalCost: roundMoney(bedrockTotal),
        byModel: bedrockByModel,
        monthlyTrend: bedrockTrend,
      },
      snapshotCost: roundMoney(snapInterzoneIndex.get("snapshot") || 0),
      interZoneTransfer: roundMoney(snapInterzoneIndex.get("interzone") || 0),
    },
    ec2Fleet,
    tagCompliance,
    anomalyAttribution,
    aiCostDaily,
  };
}

/** Rich cost context for the chatbot — last 3 months */
export async function fetchCurSummaryForChat(
  accountIds: string[],
  accountNameMap: Record<string, string> = {}
): Promise<string> {
  const now = new Date();
  // Last 3 full months + current month
  const threeMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
  const startDate = threeMonthsAgo.toISOString().split("T")[0];
  const endDate = now.toISOString().split("T")[0];

  try {
    const idsStr = accountIdsToSql(accountIds);
    const endExclusive = nextDay(endDate);

    // Run queries in parallel — monthly trend + current month detail + top resources
    const [monthlyRows, currentRows, resourceRows, pricingRows, spRows, dailyRows, domainRows, envRows] = await Promise.all([
      // Monthly cost by account (last 3 months)
      executeQuery(`
        SELECT
          date_format(date_trunc('month', line_item_usage_start_date), '%Y-%m') AS month,
          line_item_usage_account_id AS account_id,
          SUM(line_item_unblended_cost) AS cost
        FROM ${ATHENA_DATABASE}.data
        WHERE line_item_usage_start_date >= DATE '${startDate}'
          AND line_item_usage_start_date < DATE '${endExclusive}'
          AND line_item_line_item_type IN ('Usage','Tax','Fee')
          AND line_item_usage_account_id IN (${idsStr})
        GROUP BY 1, 2
        ORDER BY 1, cost DESC
      `, ["month", "account_id", "cost"]),

      // Current month by service
      executeQuery(`
        SELECT
          line_item_product_code AS service,
          SUM(line_item_unblended_cost) AS cost
        FROM ${ATHENA_DATABASE}.data
        WHERE line_item_usage_start_date >= DATE '${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01'
          AND line_item_usage_start_date < DATE '${endExclusive}'
          AND line_item_line_item_type IN ('Usage','Tax','Fee')
          AND line_item_usage_account_id IN (${idsStr})
        GROUP BY 1
        ORDER BY cost DESC
        LIMIT 20
      `, ["service", "cost"]),

      // Top 30 resources (current month)
      executeQuery(`
        SELECT
          line_item_usage_account_id AS account_id,
          line_item_product_code AS service,
          line_item_resource_id AS resource_id,
          SUM(line_item_unblended_cost) AS cost,
          MAX(product_instance_type) AS instance_type
        FROM ${ATHENA_DATABASE}.data
        WHERE line_item_usage_start_date >= DATE '${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01'
          AND line_item_usage_start_date < DATE '${endExclusive}'
          AND line_item_line_item_type IN ('Usage','Tax','Fee')
          AND line_item_usage_account_id IN (${idsStr})
          AND line_item_resource_id IS NOT NULL AND TRIM(line_item_resource_id) != ''
        GROUP BY 1, 2, 3
        HAVING SUM(line_item_unblended_cost) > 0
        ORDER BY cost DESC
        LIMIT 30
      `, ["account_id", "service", "resource_id", "cost", "instance_type"]),

      // Pricing model
      executeQuery(`
        SELECT
          CASE
            WHEN savings_plan_savings_plan_a_r_n IS NOT NULL THEN 'SavingsPlan'
            WHEN reservation_reservation_a_r_n IS NOT NULL THEN 'Reserved'
            WHEN pricing_term = 'Spot' OR line_item_usage_type LIKE '%Spot%' THEN 'Spot'
            ELSE 'OnDemand'
          END AS pricing_model,
          SUM(line_item_unblended_cost) AS cost,
          SUM(pricing_public_on_demand_cost) AS on_demand_equivalent
        FROM ${ATHENA_DATABASE}.data
        WHERE line_item_usage_start_date >= DATE '${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01'
          AND line_item_usage_start_date < DATE '${endExclusive}'
          AND line_item_line_item_type IN ('Usage','Fee')
          AND line_item_usage_account_id IN (${idsStr})
        GROUP BY 1
      `, ["pricing_model", "cost", "on_demand_equivalent"]),

      // Savings Plans
      executeQuery(`
        SELECT
          SUM(savings_plan_savings_plan_effective_cost) AS sp_covered,
          SUM(pricing_public_on_demand_cost) AS on_demand_eq
        FROM ${ATHENA_DATABASE}.data
        WHERE savings_plan_savings_plan_a_r_n IS NOT NULL
          AND line_item_usage_start_date >= DATE '${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01'
          AND line_item_usage_start_date < DATE '${endExclusive}'
          AND line_item_usage_account_id IN (${idsStr})
      `, ["sp_covered", "on_demand_eq"]),

      // Daily costs (last 30 days)
      executeQuery(`
        SELECT
          date_format(line_item_usage_start_date, '%Y-%m-%d') AS day,
          SUM(line_item_unblended_cost) AS cost
        FROM ${ATHENA_DATABASE}.data
        WHERE line_item_usage_start_date >= DATE '${(() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().split("T")[0]; })()}'
          AND line_item_usage_start_date < DATE '${endExclusive}'
          AND line_item_line_item_type IN ('Usage','Tax','Fee')
          AND line_item_usage_account_id IN (${idsStr})
        GROUP BY 1
        ORDER BY 1
      `, ["day", "cost"]),

      // Cost by domain tag (current month)
      executeQuery(`
        SELECT
          resource_tags['user_domain'] AS domain,
          SUM(line_item_unblended_cost) AS cost,
          COUNT(DISTINCT line_item_resource_id) AS resources
        FROM ${ATHENA_DATABASE}.data
        WHERE line_item_usage_start_date >= DATE '${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01'
          AND line_item_usage_start_date < DATE '${endExclusive}'
          AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage')
          AND line_item_usage_account_id IN (${idsStr})
          AND resource_tags['user_domain'] IS NOT NULL
          AND resource_tags['user_domain'] != ''
        GROUP BY 1
        ORDER BY cost DESC
      `, ["domain", "cost", "resources"]),

      // Cost by environment tag (current month)
      executeQuery(`
        SELECT
          resource_tags['user_environment'] AS environment,
          SUM(line_item_unblended_cost) AS cost
        FROM ${ATHENA_DATABASE}.data
        WHERE line_item_usage_start_date >= DATE '${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01'
          AND line_item_usage_start_date < DATE '${endExclusive}'
          AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage')
          AND line_item_usage_account_id IN (${idsStr})
          AND resource_tags['user_environment'] IS NOT NULL
          AND resource_tags['user_environment'] != ''
        GROUP BY 1
        ORDER BY cost DESC
      `, ["environment", "cost"]),
    ]);

    // Build context
    let ctx = `## Costes AWS reales (CUR) — datos hasta ${endDate}\n\n`;

    // Monthly trend
    const monthTotals = new Map<string, number>();
    for (const r of monthlyRows) {
      monthTotals.set(r.month, (monthTotals.get(r.month) || 0) + (Number(r.cost) || 0));
    }
    ctx += `### Evolución mensual:\n`;
    for (const [month, total] of [...monthTotals.entries()].sort()) {
      ctx += `- ${month}: $${roundMoney(total)}\n`;
    }

    // Monthly by account (current month)
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const currentMonthByAccount = monthlyRows
      .filter((r) => r.month === currentMonth)
      .sort((a, b) => (Number(b.cost) || 0) - (Number(a.cost) || 0));
    ctx += `\n### Mes actual (${currentMonth}) por cuenta:\n`;
    for (const r of currentMonthByAccount.slice(0, 15)) {
      ctx += `- ${accountNameMap[r.account_id] || r.account_id}: $${roundMoney(Number(r.cost))}\n`;
    }

    // Previous month by account
    const prevMonth = `${now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear()}-${String(now.getUTCMonth() === 0 ? 12 : now.getUTCMonth()).padStart(2, "0")}`;
    const prevMonthByAccount = monthlyRows
      .filter((r) => r.month === prevMonth)
      .sort((a, b) => (Number(b.cost) || 0) - (Number(a.cost) || 0));
    if (prevMonthByAccount.length > 0) {
      ctx += `\n### Mes anterior (${prevMonth}) por cuenta:\n`;
      for (const r of prevMonthByAccount.slice(0, 15)) {
        ctx += `- ${accountNameMap[r.account_id] || r.account_id}: $${roundMoney(Number(r.cost))}\n`;
      }
    }

    // Current month by service
    ctx += `\n### Mes actual por servicio:\n`;
    for (const r of currentRows.slice(0, 15)) {
      ctx += `- ${r.service}: $${roundMoney(Number(r.cost))}\n`;
    }

    // Pricing model
    ctx += `\n### Modelo de pricing (mes actual):\n`;
    for (const r of pricingRows) {
      ctx += `- ${r.pricing_model}: $${roundMoney(Number(r.cost))} (On-Demand equiv: $${roundMoney(Number(r.on_demand_equivalent))})\n`;
    }

    // Savings Plans
    const spCov = Number(spRows[0]?.sp_covered) || 0;
    const spOD = Number(spRows[0]?.on_demand_eq) || 0;
    ctx += `\n### Savings Plans:\n`;
    ctx += `- Coste cubierto por SP: $${roundMoney(spCov)}\n`;
    ctx += `- Equivalente On-Demand: $${roundMoney(spOD)}\n`;
    ctx += `- Ahorro: $${roundMoney(spOD - spCov)} (${spOD > 0 ? roundMoney(((spOD - spCov) / spOD) * 100) : 0}%)\n`;

    // Top resources
    ctx += `\n### Top 30 recursos más caros (mes actual):\n`;
    for (const r of resourceRows) {
      const name = accountNameMap[r.account_id] || r.account_id;
      ctx += `- ${r.resource_id.slice(-60)} | ${r.service} | ${name} | ${r.instance_type || "-"} | $${roundMoney(Number(r.cost))}\n`;
    }

    // Daily costs
    ctx += `\n### Coste diario (últimos 30 días):\n`;
    for (const r of dailyRows) {
      ctx += `- ${r.day}: $${roundMoney(Number(r.cost))}\n`;
    }

    // Cost by domain (team/microservice)
    if (domainRows.length > 0) {
      ctx += `\n### Coste por dominio/equipo (mes actual, recursos taggeados):\n`;
      for (const r of domainRows.slice(0, 20)) {
        ctx += `- ${r.domain}: $${roundMoney(Number(r.cost))} (${r.resources} recursos)\n`;
      }
    }

    // Cost by environment
    if (envRows.length > 0) {
      ctx += `\n### Coste por entorno (mes actual):\n`;
      for (const r of envRows) {
        ctx += `- ${r.environment}: $${roundMoney(Number(r.cost))}\n`;
      }
    }

    return ctx;
  } catch (err) {
    console.error("Athena CUR query failed:", err);
    return `Error consultando CUR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function nextDay(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}

function addMonths(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().split("T")[0];
}

// ─── Bedrock cost by day (for the AI cost daily snapshot) ────────────────────

export interface BedrockCostByDay {
  model: string;
  accountId: string;
  cost: number;
}

/**
 * Derives a Bedrock model identifier from a CUR resource ARN.
 * Handles both inference-profile and foundation-model ARNs, e.g.:
 *   arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0
 *   arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-sonnet-4-20250514-v1:0
 * Falls back to the last ARN path segment, then "unknown".
 * Consistent with the model derivation used by hiddenCosts.bedrock in fetchCurFullSnapshot.
 */
function deriveBedrockModel(resourceArn: string): string {
  const arn = String(resourceArn || "");
  const profileMatch = arn.match(/inference-profile\/([^\s]+)$/);
  if (profileMatch) return profileMatch[1];
  const foundationMatch = arn.match(/foundation-model\/([^\s]+)$/);
  if (foundationMatch) return foundationMatch[1];
  return arn.split("/").pop() || "unknown";
}

/**
 * Fetches Bedrock inference cost for a single day, grouped by model (derived
 * from the resource ARN) and usage account. The query is bounded to one day to
 * keep it cheap — this powers the daily AI-cost snapshot and deliberately does
 * NOT recompute the full (expensive) CurFullSnapshot.
 *
 * Stays consistent with hiddenCosts.bedrock in fetchCurFullSnapshot: it filters
 * line_item_resource_id LIKE 'arn:aws:bedrock:%', sums line_item_unblended_cost
 * and includes line item types ('Usage','Fee') so the daily figure reconciles
 * with what the BedrockCard already shows.
 *
 * @param date       Single day in 'YYYY-MM-DD' (UTC). Bounded to [date, date+1).
 * @param accountIds Optional list of usage account ids to scope the query.
 * @returns Array of { model, accountId, cost } with cost rounded to 2 decimals.
 */
export async function fetchBedrockCostByDay(
  date: string,
  accountIds?: string[],
): Promise<BedrockCostByDay[]> {
  const dayStart = date;
  const dayEnd = nextDay(date);
  const accountFilter =
    accountIds && accountIds.length > 0
      ? `AND line_item_usage_account_id IN (${accountIdsToSql(accountIds)})`
      : "";

  const rows = await executeQuery(
    `
    SELECT
      line_item_resource_id AS resource_id,
      line_item_usage_account_id AS account_id,
      SUM(line_item_unblended_cost) AS cost
    FROM ${ATHENA_DATABASE}.data
    WHERE line_item_usage_start_date >= DATE '${dayStart}'
      AND line_item_usage_start_date < DATE '${dayEnd}'
      AND line_item_resource_id LIKE 'arn:aws:bedrock:%'
      AND line_item_line_item_type IN ('Usage','Fee')
      ${accountFilter}
    GROUP BY 1, 2
    HAVING SUM(line_item_unblended_cost) > 0
    ORDER BY cost DESC
  `,
    ["resource_id", "account_id", "cost"],
  );

  // Aggregate by (model, accountId): multiple resource ARNs (e.g. distinct
  // inference profiles) can resolve to the same model + account.
  const byModelAccount = new Map<string, BedrockCostByDay>();
  for (const r of rows) {
    const model = deriveBedrockModel(String(r.resource_id || ""));
    const accountId = String(r.account_id || "");
    const cost = Number(r.cost) || 0;
    const key = `${model}\u0000${accountId}`;
    const existing = byModelAccount.get(key);
    if (existing) {
      existing.cost += cost;
    } else {
      byModelAccount.set(key, { model, accountId, cost });
    }
  }

  return [...byModelAccount.values()]
    .map((e) => ({ model: e.model, accountId: e.accountId, cost: roundMoney(e.cost) }))
    .sort((a, b) => b.cost - a.cost);
}


// ─── AI cost daily series (Kiro + Bedrock, straight from the CUR) ────────────

export interface AiCostSeriesRow {
  date: string;       // YYYY-MM-DD
  accountId: string;
  source: "kiro" | "bedrock";
  cost: number;
}

/**
 * Fetches the daily AI-cost series (Kiro licenses + Bedrock inference) directly
 * from the CUR over [startDate, endDate], grouped by day, account and source.
 *
 * This is the single source of truth for the AI cost history card — same model as
 * the rest of the Costs tab (CUR via Athena), so there is NO snapshot table to
 * backfill: the full history is available on demand for whatever date range the
 * dashboard requests.
 *
 *  - Kiro:    line_item_product_code = 'Kiro' (FlatRateSubscription/Usage/Fee/Credit…),
 *             netted per day+account (credits subtract).
 *  - Bedrock: line_item_resource_id LIKE 'arn:aws:bedrock:%' (Usage/Fee).
 *
 * @param startDate inclusive 'YYYY-MM-DD' (UTC)
 * @param endDate   inclusive 'YYYY-MM-DD' (UTC)
 * @param accountIds optional account subset (the dashboard's CUR selection)
 */
export async function fetchAiCostSeries(
  startDate: string,
  endDate: string,
  accountIds?: string[],
): Promise<AiCostSeriesRow[]> {
  const endExclusive = nextDay(endDate);
  const accountFilter =
    accountIds && accountIds.length > 0
      ? `AND line_item_usage_account_id IN (${accountIdsToSql(accountIds)})`
      : "";

  const sql = `
    SELECT
      date_format(line_item_usage_start_date, '%Y-%m-%d') AS day,
      line_item_usage_account_id AS account_id,
      CASE
        WHEN line_item_product_code = 'Kiro' THEN 'kiro'
        ELSE 'bedrock'
      END AS source,
      SUM(line_item_unblended_cost) AS cost
    FROM ${ATHENA_DATABASE}.data
    WHERE line_item_usage_start_date >= DATE '${startDate}'
      AND line_item_usage_start_date < DATE '${endExclusive}'
      ${accountFilter}
      AND (
        (line_item_product_code = 'Kiro'
          AND line_item_line_item_type IN ('Usage','Fee','Credit','SppDiscount','FlatRateSubscription','RIFee','SavingsPlanRecurringFee'))
        OR
        (line_item_resource_id LIKE 'arn:aws:bedrock:%'
          AND line_item_line_item_type IN ('Usage','Fee'))
      )
    GROUP BY 1, 2, 3
    ORDER BY 1 ASC
  `;

  const rows = await executeQuery(sql, ["day", "account_id", "source", "cost"]);

  return rows
    .map((r) => ({
      date: String(r.day || ""),
      accountId: String(r.account_id || ""),
      source: (String(r.source) === "kiro" ? "kiro" : "bedrock") as "kiro" | "bedrock",
      cost: roundMoney(Number(r.cost) || 0),
    }))
    .filter((r) => r.date.length === 10);
}
