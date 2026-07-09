import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import { squadCatalog } from "@/lib/squad-infra/squad-catalog";

export const dynamic = "force-dynamic";

// GET /api/squad-infra/squads — list squad repos available for self-service infra.
export async function GET(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  try {
    const squads = await squadCatalog.getAll();
    return NextResponse.json({
      squads: squads.map((s) => ({
        squad: s.squad,
        displayName: s.displayName,
        businessTeam: s.businessTeam,
        environments: s.environments,
      })),
    });
  } catch (err) {
    console.error("[squad-infra/squads] error:", err);
    return NextResponse.json({ error: "Failed to load squads" }, { status: 500 });
  }
}
