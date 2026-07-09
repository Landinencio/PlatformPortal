import { NextRequest, NextResponse } from "next/server";
import { guard, parseFilters, key, cachedJson, errorResponse } from "../../../_shared";
import { getDistribution, isDistributionField } from "@/lib/kiro-analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: NextRequest, { params }: { params: { field: string } }) {
  const g = await guard();
  if (!g.ok) return g.response;
  try {
    const field = params.field;
    if (!isDistributionField(field)) {
      return NextResponse.json({ error: "Invalid distribution field" }, { status: 400 });
    }
    const { users } = parseFilters(request);
    return cachedJson(key("classified/distribution", { field, users }), () => getDistribution(field, users));
  } catch (err) {
    return errorResponse(err);
  }
}
