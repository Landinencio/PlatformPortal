import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import { squadCatalog } from "@/lib/squad-infra/squad-catalog";
import { validateConfig, validateEnvironments } from "@/lib/squad-infra/validators";
import { renderResource } from "@/lib/squad-infra/render";
import type { SquadResourceType } from "@/lib/squad-infra/templates";

export const dynamic = "force-dynamic";

const VALID_TYPES: SquadResourceType[] = ["sqs", "secret", "dynamodb", "eventbridge", "sns"];

// POST /api/squad-infra/preview — render the HCL for a squad resource (no persistence).
export async function POST(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { squad, resourceType, environments, config } = body;

  if (!VALID_TYPES.includes(resourceType)) {
    return NextResponse.json({ error: `resourceType must be one of: ${VALID_TYPES.join(", ")}` }, { status: 400 });
  }

  const envError = validateEnvironments(environments);
  if (envError) return NextResponse.json({ error: envError }, { status: 400 });

  const cfgError = validateConfig(resourceType, config);
  if (cfgError) return NextResponse.json({ error: cfgError }, { status: 400 });

  const squadEntry = await squadCatalog.getBySquad(squad);
  if (!squadEntry) {
    return NextResponse.json({ error: `Squad "${squad}" not found` }, { status: 422 });
  }

  // Ensure requested environments are supported by the repo.
  const unsupported = (environments as string[]).filter((e) => !squadEntry.environments.includes(e));
  if (unsupported.length > 0) {
    return NextResponse.json(
      { error: `Squad "${squad}" does not support environments: ${unsupported.join(", ")}` },
      { status: 422 }
    );
  }

  try {
    const result = renderResource(resourceType, config, squadEntry);
    return NextResponse.json({
      hcl: result.hcl,
      filePath: result.filePath,
      variablesHcl: result.variablesHcl ?? null,
      ciVars: result.ciVars ?? [],
    });
  } catch (err) {
    console.error("[squad-infra/preview] render error:", err);
    return NextResponse.json({ error: "Failed to render template" }, { status: 500 });
  }
}
