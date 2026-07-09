import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import { squadCatalog } from "@/lib/squad-infra/squad-catalog";
import { gitlabClient } from "@/lib/gitlab";
import type { SquadResourceType } from "@/lib/squad-infra/templates";

export const dynamic = "force-dynamic";

interface FoundResource {
  resourceType: SquadResourceType;
  name: string;
  filePath: string;
  /** module/resource label in the HCL */
  tfLabel: string;
}

// Detect squad resources by scanning the squad's iac/services .tf files.
function detectResources(filePath: string, content: string): FoundResource[] {
  const found: FoundResource[] = [];

  // SQS modules: module "<id>_sqs" { source = ".../sqs/aws" ... name = "<name>" }
  const sqsBlocks = content.matchAll(/module\s+"([^"]+)"\s*\{[^}]*?sqs\/aws[^}]*?name\s*=\s*"([^"]+)"/gs);
  for (const m of sqsBlocks) {
    found.push({ resourceType: "sqs", name: m[2], filePath, tfLabel: m[1] });
  }

  // DynamoDB modules
  const dynBlocks = content.matchAll(/module\s+"([^"]+)"\s*\{[^}]*?dynamodb-table\/aws[^}]*?name\s*=\s*"([^"]+)"/gs);
  for (const m of dynBlocks) {
    found.push({ resourceType: "dynamodb", name: m[2], filePath, tfLabel: m[1] });
  }

  // Secrets: resource "aws_secretsmanager_secret" "<label>" { name = "<path>" }
  const secretBlocks = content.matchAll(/resource\s+"aws_secretsmanager_secret"\s+"([^"]+)"\s*\{[^}]*?name\s*=\s*"([^"]+)"/gs);
  for (const m of secretBlocks) {
    found.push({ resourceType: "secret", name: m[2], filePath, tfLabel: m[1] });
  }

  // SNS topics
  const snsBlocks = content.matchAll(/resource\s+"aws_sns_topic"\s+"([^"]+)"\s*\{[^}]*?name\s*=\s*"([^"]+)"/gs);
  for (const m of snsBlocks) {
    found.push({ resourceType: "sns", name: m[2], filePath, tfLabel: m[1] });
  }

  return found;
}

// POST /api/squad-infra/list-resources { squad, resourceType }
export async function POST(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const { squad, resourceType } = await request.json();
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
    const tfFiles = tree.filter((i) => i.type === "blob" && i.path.endsWith(".tf") && !i.path.endsWith("variables.tf") && !i.path.endsWith("backend.tf") && !i.path.endsWith("provider.tf"));

    const all: FoundResource[] = [];
    for (const f of tfFiles.slice(0, 60)) {
      const raw = await gitlabClient.getRepositoryFileRaw(squadEntry.gitlabProjectId, f.path, squadEntry.defaultBranch);
      if (!raw) continue;
      all.push(...detectResources(f.path, raw));
    }

    const filtered = resourceType ? all.filter((r) => r.resourceType === resourceType) : all;
    // Deduplicate by name+filePath
    const seen = new Set<string>();
    const resources = filtered.filter((r) => {
      const k = `${r.filePath}::${r.name}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return NextResponse.json({ resources });
  } catch (err) {
    console.error("[squad-infra/list-resources] error:", err);
    return NextResponse.json({ error: "Failed to list resources" }, { status: 500 });
  }
}
