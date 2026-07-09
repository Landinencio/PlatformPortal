import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";
import { cached } from "@/lib/cache";
import { CostExplorerClient, GetCostForecastCommand, GetSavingsPlansCoverageCommand } from "@aws-sdk/client-cost-explorer";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

export const dynamic = "force-dynamic";

const LAMBDA_URL =
  process.env.FINOPS_ATHENA_LAMBDA_URL ||
  "https://jzcrsycqa2plblvxdeck37r6am0kxeqw.lambda-url.eu-north-1.on.aws/";

const FORECAST_CACHE_TTL_MS = 30 * 60 * 1000;

// Same role used for CUR access; root-iskaypet has billing visibility
const FORECAST_ROLE_ARN =
  process.env.FORECAST_ROLE_ARN?.trim() ||
  "arn:aws:iam::600700800900:role/Cur-AWSS3CURLambdaExecutor-Y5pT9wqNQaur";

function parseLambdaResponse(data: any): any {
  if (data.body) {
    return typeof data.body === "string" ? JSON.parse(data.body) : data.body;
  }
  return data;
}

async function getCeClient(): Promise<CostExplorerClient> {
  const sts = new STSClient({ region: "us-east-1" });
  const assumed = await sts.send(
    new AssumeRoleCommand({
      RoleArn: FORECAST_ROLE_ARN,
      RoleSessionName: "portal-forecast-scoped",
      DurationSeconds: 900,
    }),
  );
  return new CostExplorerClient({
    region: "us-east-1",
    credentials: {
      accessKeyId: assumed.Credentials!.AccessKeyId!,
      secretAccessKey: assumed.Credentials!.SecretAccessKey!,
      sessionToken: assumed.Credentials!.SessionToken!,
    },
  });
}

function fmtDate(d: Date) { return d.toISOString().split("T")[0]; }
function startOfMonth(d: Date) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }
function addMonths(d: Date, n: number) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate())); }
function addDays(d: Date, n: number) { return new Date(d.getTime() + n * 86_400_000); }

async function fetchScopedForecast(accountIds: string[], months: number) {
  const client = await getCeClient();
  const now = new Date();
  const forecastStart = fmtDate(addDays(now, 1));
  const forecastEnd = fmtDate(startOfMonth(addMonths(now, months)));

  const filter = {
    Dimensions: { Key: "LINKED_ACCOUNT" as const, Values: accountIds },
  };

  const [forecast, coverage] = await Promise.all([
    client.send(new GetCostForecastCommand({
      TimePeriod: { Start: forecastStart, End: forecastEnd },
      Metric: "UNBLENDED_COST",
      Granularity: "MONTHLY",
      Filter: filter,
    })).catch((e) => ({ error: e?.message || "forecast failed" })),
    client.send(new GetSavingsPlansCoverageCommand({
      TimePeriod: {
        Start: fmtDate(addDays(now, -30)),
        End: fmtDate(now),
      },
      Granularity: "DAILY",
      Filter: filter,
    })).catch((e) => ({ error: e?.message || "coverage failed" })),
  ]);

  const fanyany: any = forecast as any;
  const byMonth = (fanyany?.ForecastResultsByTime || []).map((p: any) => ({
    start: p.TimePeriod?.Start,
    end: p.TimePeriod?.End,
    mean: Number(p.MeanValue || 0),
    low: Number(p.PredictionIntervalLowerBound || 0),
    high: Number(p.PredictionIntervalUpperBound || 0),
  }));

  const cany: any = coverage as any;
  const daily = (cany?.SavingsPlansCoverages || []).map((c: any) => ({
    start: c.TimePeriod?.Start,
    coveragePct: Number(c.Coverage?.CoveragePercentage || 0),
    spendCoveredBySP: Number(c.Coverage?.SpendCoveredBySavingsPlans || 0),
    onDemandCost: Number(c.Coverage?.OnDemandCost || 0),
    totalCost: Number(c.Coverage?.TotalCost || 0),
  }));

  const avg = daily.length ? daily.reduce((s: number, d: any) => s + d.coveragePct, 0) / daily.length : 0;

  return {
    generatedAt: new Date().toISOString(),
    forecast: byMonth.length > 0 ? {
      period: { start: forecastStart, end: forecastEnd },
      totalMean: byMonth.reduce((s: number, m: any) => s + m.mean, 0),
      currency: "USD",
      byMonth,
    } : null,
    spCoverage: daily.length > 0 ? {
      period: { start: fmtDate(addDays(now, -30)), end: fmtDate(now) },
      averageCoveragePct: Math.round(avg * 10) / 10,
      daily,
    } : null,
    errors: [
      ...((forecast as any).error ? [{ area: "forecast", message: (forecast as any).error }] : []),
      ...((coverage as any).error ? [{ area: "spCoverage", message: (coverage as any).error }] : []),
    ],
    scopedToAccounts: accountIds,
  };
}

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const role = getSessionRole(session);
    if (!hasMinimumRole(role, "desarrolladores")) {
      return NextResponse.json({ error: "Editor access required" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const forecastMonths = parseInt(searchParams.get("months") || "3", 10);
    const accountIdsParam = searchParams.get("accountIds") || "";
    const accountIds = accountIdsParam ? accountIdsParam.split(",").map((id) => id.trim()).filter(Boolean) : [];

    const cacheKey = `finops-forecast:${forecastMonths}:${accountIds.length > 0 ? accountIds.slice().sort().join(",") : "all"}`;

    const result = await cached(
      cacheKey,
      async () => {
        // If specific accounts are requested, use direct Cost Explorer with Filter
        if (accountIds.length > 0) {
          return await fetchScopedForecast(accountIds, forecastMonths);
        }
        // Else fall back to the org-wide lambda
        const response = await fetch(LAMBDA_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "forecast", query: { forecastMonths } }),
        });
        if (!response.ok) {
          throw new Error(`Lambda returned ${response.status}`);
        }
        const data = await response.json();
        return parseLambdaResponse(data);
      },
      FORECAST_CACHE_TTL_MS
    );

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error fetching forecast:", error);
    return NextResponse.json(
      { error: "Failed to fetch forecast data" },
      { status: 500 }
    );
  }
}
