import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";
import { cached, cacheKey } from "@/lib/cache";

export const dynamic = "force-dynamic";

const LAMBDA_URL =
  process.env.FINOPS_ATHENA_LAMBDA_URL ||
  "https://jzcrsycqa2plblvxdeck37r6am0kxeqw.lambda-url.eu-north-1.on.aws/";

/** Cache FinOps queries for 10 minutes (data changes daily via CUR) */
const FINOPS_CACHE_TTL_MS = 10 * 60 * 1000;

function parseLambdaResponse(data: any): any {
  if (data.body) {
    return typeof data.body === "string" ? JSON.parse(data.body) : data.body;
  }
  return data;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const role = getSessionRole(session);
    if (!hasMinimumRole(role, "desarrolladores")) {
      return NextResponse.json({ error: "Editor access required for FinOps" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const accountIds = searchParams.get("accountIds") || "all";
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const includeTrends = searchParams.get("includeTrends") !== "false";
    const includeResourceCosts = searchParams.get("includeResourceCosts") === "true";
    const resourceCostLimit = searchParams.get("resourceCostLimit");

    if (!startDate || !endDate) {
      return NextResponse.json(
        { error: "startDate and endDate are required" },
        { status: 400 }
      );
    }

    const key = cacheKey("finops-athena", {
      accountIds,
      startDate,
      endDate,
      includeTrends,
      includeResourceCosts,
      resourceCostLimit: resourceCostLimit || "",
    });

    const result = await cached(
      key,
      async () => {
        const lambdaResponse = await fetch(LAMBDA_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: {
              accountIds,
              startDate,
              endDate,
              includeTrends,
              includeResourceCosts,
              resourceCostLimit: resourceCostLimit ? Number(resourceCostLimit) : undefined,
            },
          }),
        });

        if (!lambdaResponse.ok) {
          throw new Error(`Lambda returned ${lambdaResponse.status}`);
        }

        const data = await lambdaResponse.json();
        return parseLambdaResponse(data);
      },
      FINOPS_CACHE_TTL_MS
    );

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error calling FinOps Lambda:", error);
    return NextResponse.json(
      { error: "Failed to fetch cost data" },
      { status: 500 }
    );
  }
}
