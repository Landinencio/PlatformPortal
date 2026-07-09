// GET /api/infra-request-v2/modify/environments
//
// Feature: infra-self-service-hardening — task 7.1
//
// Read-only endpoint that prefills the `targetEnvironments` form of the
// Formulario_Modify: resolves the resource's `.tf` file in the Repositorio_Destino,
// parses the canonical `count = contains([...], var.environment) ? 1 : 0`
// expression and returns the current envs plus the closed catalog available.
//
// Contract:
//   Query params:
//     - team         (string, required) — RepoCatalog key (case-insensitive)
//     - resourceType (string, required) — one of "rds" | "s3" | "iam_role"
//     - identifier   (string, required) — must match IDENTIFIER_PATTERN
//
//   Responses:
//     200 { current: Env[], available: ["dev","uat","prod"] }
//     400 { code: "missing_parameter" | "invalid_resource_type" }
//     401                                        (unauthenticated)
//     404 { code: "route_disabled" }             (feature flag off — route hidden)
//     404 { code: "team_not_found" }             (RepoCatalog miss)
//     404 { code: "resource_not_found" }         (file / block absent)
//     422 { code: "invalid_identifier_charset" }
//     422 { code: "environments_expression_not_parseable" }
//     500 (unexpected)
//
// Notes:
//   - Any authenticated user may call this endpoint; it does not mutate state
//     and does not require the team-approver role.
//   - Gated behind ENABLE_INFRA_HARDENING_V1 (default `false`). When disabled
//     the route responds 404 so the endpoint is effectively hidden.

import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import { repoCatalog } from "@/lib/repo-catalog";
import { gitlabClient } from "@/lib/gitlab";
import {
  parseEnvironmentsExpression,
  type Env,
} from "@/lib/infra/environments-parser";
import { validateIdentifier } from "@/lib/infra/duplicate-guard";
import { ENABLE_INFRA_HARDENING_V1 } from "@/lib/feature-flags";
import { InfraLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type ResourceType = "rds" | "s3" | "iam_role";

const VALID_RESOURCE_TYPES: ReadonlySet<ResourceType> = new Set([
  "rds",
  "s3",
  "iam_role",
]);

const AVAILABLE_ENVS: readonly Env[] = ["dev", "uat", "prod"] as const;

/**
 * Resolves the `.tf` file path holding the environments expression for the
 * given resource. Mirrors the mapping documented in the design and applied by
 * the Guardia_Duplicado (task 5.3):
 *   - rds       → `iac/databases/<identifier>.tf`  (per-resource file)
 *   - s3        → `iac/s3/s3.tf`                   (shared file; block lookup)
 *   - iam_role  → `iac/roles/roles.tf`             (shared file; block lookup)
 *
 * The shared-file resources (s3, iam_role) hold the `contains([...])` inside
 * the block for the specific identifier, so callers must additionally locate
 * the block for that identifier inside the file content before parsing.
 */
function resolveFilePath(
  resourceType: ResourceType,
  identifier: string,
): string {
  switch (resourceType) {
    case "rds":
      return `iac/databases/${identifier}.tf`;
    case "s3":
      return "iac/s3/s3.tf";
    case "iam_role":
      return "iac/roles/roles.tf";
  }
}

/**
 * Extracts the body of the `resource "<awsType>" "<identifier>" { ... }` block
 * from a shared HCL file. Returns `null` when the block is not found. Balances
 * `{`/`}` so nested blocks (e.g. `lifecycle_rule { ... }`) are handled correctly.
 *
 * NOTE: HCL string literals do not contain unescaped braces for the identifiers
 * we care about (bucket/role names, env values), so a simple depth counter over
 * the raw text is safe here.
 */
function extractResourceBlock(
  hcl: string,
  awsType: string,
  identifier: string,
): string | null {
  // Match: resource "aws_s3_bucket" "<identifier>" { ... }
  //  - quotes may have arbitrary whitespace around them
  //  - identifier is matched literally (already validated by IDENTIFIER_PATTERN)
  const header = new RegExp(
    `resource\\s+"${escapeRegex(awsType)}"\\s+"${escapeRegex(identifier)}"\\s*\\{`,
  );
  const match = header.exec(hcl);
  if (!match) return null;
  const bodyStart = match.index + match[0].length;
  let depth = 1;
  for (let i = bodyStart; i < hcl.length; i++) {
    const ch = hcl.charCodeAt(i);
    if (ch === 0x7b /* { */) depth++;
    else if (ch === 0x7d /* } */) {
      depth--;
      if (depth === 0) return hcl.slice(bodyStart, i);
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Given the resource type and the raw file content from GitLab, returns the
 * HCL fragment we should feed to `parseEnvironmentsExpression`. For per-resource
 * files (rds) we return the whole file; for shared files we return just the
 * body of the target block, or `null` when the block is absent.
 */
function extractExpressionScope(
  resourceType: ResourceType,
  identifier: string,
  fileContent: string,
): string | null {
  if (resourceType === "rds") return fileContent;
  if (resourceType === "s3") {
    return extractResourceBlock(fileContent, "aws_s3_bucket", identifier);
  }
  return extractResourceBlock(fileContent, "aws_iam_role", identifier);
}

export async function GET(request: Request) {
  // Feature flag gate — when the hardening rollout is off, the route stays hidden.
  if (!ENABLE_INFRA_HARDENING_V1) {
    return NextResponse.json({ code: "route_disabled" }, { status: 404 });
  }

  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const userEmail = auth.session.user?.email ?? "unknown";
  const logger = new InfraLogger("modify-environments", userEmail);

  const url = new URL(request.url);
  const team = url.searchParams.get("team")?.trim() ?? "";
  const resourceTypeRaw = url.searchParams.get("resourceType")?.trim() ?? "";
  const identifierRaw = url.searchParams.get("identifier")?.trim() ?? "";

  if (!team || !resourceTypeRaw || !identifierRaw) {
    return NextResponse.json(
      { code: "missing_parameter" },
      { status: 400 },
    );
  }

  if (!VALID_RESOURCE_TYPES.has(resourceTypeRaw as ResourceType)) {
    return NextResponse.json(
      { code: "invalid_resource_type" },
      { status: 400 },
    );
  }
  const resourceType = resourceTypeRaw as ResourceType;

  const idCheck = validateIdentifier(identifierRaw);
  if (!idCheck.ok) {
    return NextResponse.json(
      { code: "invalid_identifier_charset" },
      { status: 422 },
    );
  }
  const identifier = idCheck.value;

  const catalog = await repoCatalog.getByTeam(team);
  if (!catalog) {
    logger.warn("Team not found in catalog", { team });
    return NextResponse.json({ code: "team_not_found" }, { status: 404 });
  }
  const { gitlabProjectId: projectId, defaultBranch } = catalog;

  const filePath = resolveFilePath(resourceType, identifier);

  let fileContent: string | null;
  try {
    fileContent = await gitlabClient.getRepositoryFileRaw(
      projectId,
      filePath,
      defaultBranch,
    );
  } catch (err) {
    logger.error("GitLab fetch failed", {
      team,
      resourceType,
      identifier,
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ code: "route_error" }, { status: 500 });
  }

  if (fileContent === null) {
    return NextResponse.json(
      { code: "resource_not_found" },
      { status: 404 },
    );
  }

  const scope = extractExpressionScope(resourceType, identifier, fileContent);
  if (scope === null) {
    // Shared file present but the block for this identifier is absent.
    return NextResponse.json(
      { code: "resource_not_found" },
      { status: 404 },
    );
  }

  const parsed = parseEnvironmentsExpression(scope);
  if (!parsed.ok) {
    logger.warn("environments_expression_not_parseable", {
      team,
      resourceType,
      identifier,
      filePath,
    });
    return NextResponse.json(
      { code: "environments_expression_not_parseable" },
      { status: 422 },
    );
  }

  logger.done("environments resolved", {
    team,
    resourceType,
    identifier,
    filePath,
    current: parsed.current,
  });

  return NextResponse.json(
    { current: parsed.current, available: AVAILABLE_ENVS },
    { status: 200 },
  );
}
