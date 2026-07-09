import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import { squadCatalog } from "@/lib/squad-infra/squad-catalog";
import { gitlabClient } from "@/lib/gitlab";

export const dynamic = "force-dynamic";

// POST /api/squad-infra/buses { squad }
// Discovers the EventBridge bus names already referenced in the squad's repo
// so the form can offer real choices instead of a hardcoded default.
export async function POST(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const { squad } = await request.json();
  const squadEntry = await squadCatalog.getBySquad(squad);
  if (!squadEntry) {
    return NextResponse.json({ error: `Squad "${squad}" not found` }, { status: 422 });
  }

  try {
    const tree = await gitlabClient.listRepoTree(
      squadEntry.gitlabProjectId,
      squadEntry.infraRootPath,
      squadEntry.defaultBranch,
      true
    );
    const tfFiles = tree.filter((i) => i.type === "blob" && i.path.endsWith(".tf"));

    const buses = new Set<string>();
    for (const f of tfFiles.slice(0, 60)) {
      const raw = await gitlabClient.getRepositoryFileRaw(squadEntry.gitlabProjectId, f.path, squadEntry.defaultBranch);
      if (!raw) continue;
      // bus_name = "xxx"  or  bus_name = var.xxx (skip variable refs)
      for (const m of raw.matchAll(/bus_name\s*=\s*"([^"]+)"/g)) {
        buses.add(m[1]);
      }
    }

    // Fall back to the squad key if nothing found (most squads have a bus named after themselves or "oms").
    const list = Array.from(buses).sort();
    return NextResponse.json({ buses: list });
  } catch (err) {
    console.error("[squad-infra/buses] error:", err);
    return NextResponse.json({ buses: [] });
  }
}
