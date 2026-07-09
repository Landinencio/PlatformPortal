/**
 * GET /api/finops/k8s-cost
 *
 * Node-centric EKS cost summary for the "EKS Allocation" tab of the FinOps
 * dashboard. Successor of `GET /api/finops/k8s-allocation`.
 *
 * Contract (design.md §Endpoint HTTP):
 *   - Auth: `getServerSession(authOptions)` → 401 `{ error: "Authentication required" }`
 *     when no session.
 *   - RBAC: `hasSessionMinimumRole(session, "desarrolladores")` → 403
 *     `{ error: "Access denied" }`, WITHOUT any cost data
 *     (Property 13 — leak-proof).
 *   - Query params (all optional, validated strictly):
 *       env       ^(dev|uat|prod|tooling)$
 *       nodegroup ^[a-z0-9][a-z0-9-]{0,62}$
 *       squad     ^[A-Za-z0-9 _-]{1,64}$
 *     Any invalid value → 400 `{ error: "Invalid parameter: <name>" }`
 *     (never echoes the received value, so it does not reflect into logs).
 *   - Cache: `cached("eks-cost", cacheKey("eks-cost", filters), ..., 5min)`.
 *     Cache prefix `eks-cost:` is isolated from the pre-existing prefixes.
 *   - Metrics readiness: `grafanaMetricsClient.getStatus().ready === false`
 *     → 500 `{ error: "Grafana Metrics is not ready", missing: [...] }`
 *     including the missing env vars (Requirement 8.1).
 *   - Unhandled exceptions → 500 opaque `{ error: "Failed to fetch EKS cost summary" }`.
 *     The full trace is only logged via `console.error`.
 *   - `Cache-Control: private, no-store` on authorized responses.
 *   - Structured logging on start and end (method + sanitized query + duration).
 *     Never logs tokens or full URLs.
 *
 * See:
 *   - `.kiro/specs/eks-cost-optimization/design.md` §Endpoint HTTP
 *   - `.kiro/specs/eks-cost-optimization/tasks.md` §Fase 1 > task 7.1
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { hasSessionMinimumRole } from "@/lib/session-role";
import { cached, cacheKey } from "@/lib/cache";
import { grafanaMetricsClient } from "@/lib/grafana-metrics";
import { fetchEksCostSummary } from "@/lib/eks-cost";
import type { EnvironmentName, Filters } from "@/lib/eks-cost/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_PREFIX = "eks-cost";

/** Strict param validators (design.md §Endpoint HTTP > Query params). */
const ENV_RE = /^(dev|uat|prod|tooling)$/;
// Accept camelCase / PascalCase names — real EKS nodegroups include
// values like `RetailProdV2`, `DigitalNodesV2`, `HeliosProd`, `OmsProdV2`
// (Terraform-managed) alongside the lowercase ones (`toolingnodesv2-…`).
const NODEGROUP_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const SQUAD_RE = /^[A-Za-z0-9 _-]{1,64}$/;

/** Common headers for authorized responses (matches `/api/finops/report/[id]`). */
const AUTHORIZED_HEADERS = { "Cache-Control": "private, no-store" } as const;

type ParseResult =
  | { ok: true; filters: Filters }
  | { ok: false; param: "env" | "nodegroup" | "squad" };

/**
 * Parse and validate the accepted query params. Rejects on the first
 * offending parameter so the response error indicates a single param name
 * (design.md §Endpoint HTTP > Errores).
 *
 * The received value is intentionally NOT echoed back in the error body,
 * which prevents log reflection of arbitrary user-supplied strings.
 */
function parseFilters(searchParams: URLSearchParams): ParseResult {
  const env = searchParams.get("env");
  const nodegroup = searchParams.get("nodegroup");
  const squad = searchParams.get("squad");

  if (env !== null && !ENV_RE.test(env)) return { ok: false, param: "env" };
  if (nodegroup !== null && !NODEGROUP_RE.test(nodegroup)) {
    return { ok: false, param: "nodegroup" };
  }
  if (squad !== null && !SQUAD_RE.test(squad)) {
    return { ok: false, param: "squad" };
  }

  const filters: Filters = {};
  if (env !== null) filters.env = env as EnvironmentName;
  if (nodegroup !== null) filters.nodegroup = nodegroup;
  if (squad !== null) filters.squad = squad;
  return { ok: true, filters };
}

/**
 * Emit a single-line JSON log entry. Kept local so the route does not
 * pull in `InfraLogger` (which is scoped to infra-request flows).
 *
 * Never includes tokens, request bodies, or full URLs (design §Logging).
 */
function log(
  level: "info" | "warn" | "error",
  message: string,
  metadata?: Record<string, unknown>,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    action: "finops.k8s-cost",
    message,
    ...(metadata ? { metadata } : {}),
  };
  const line = JSON.stringify(entry) + "\n";
  if (level === "error") process.stderr.write(line);
  else process.stdout.write(line);
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const searchParams = request.nextUrl.searchParams;
  // Sanitised query summary: only which params were provided, never their
  // values, so nothing user-supplied reaches the logs.
  const providedParams = ["env", "nodegroup", "squad"].filter((p) =>
    searchParams.has(p),
  );
  log("info", "request.start", { method: "GET", providedParams });

  const finish = (status: number, extra?: Record<string, unknown>) => {
    const durationMs = Date.now() - startedAt;
    log("info", "request.end", { method: "GET", status, durationMs, ...extra });
  };

  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      finish(401);
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }
    if (!hasSessionMinimumRole(session, "desarrolladores")) {
      finish(403);
      // 403 body MUST NOT include cost data (Property 13).
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const parsed = parseFilters(searchParams);
    if (!parsed.ok) {
      finish(400, { invalidParam: parsed.param });
      // Deliberately does NOT echo the received value.
      return NextResponse.json(
        { error: `Invalid parameter: ${parsed.param}` },
        { status: 400 },
      );
    }

    const metricsStatus = grafanaMetricsClient.getStatus();
    if (!metricsStatus.ready) {
      finish(500, { missing: metricsStatus.missing });
      return NextResponse.json(
        {
          error: "Grafana Metrics is not ready",
          missing: metricsStatus.missing,
        },
        { status: 500, headers: AUTHORIZED_HEADERS },
      );
    }

    const filters = parsed.filters;
    const key = cacheKey(CACHE_PREFIX, filters as Record<string, unknown>);
    const summary = await cached(
      key,
      () => fetchEksCostSummary(filters),
      CACHE_TTL_MS,
    );

    finish(200);
    return NextResponse.json(summary, {
      status: 200,
      headers: AUTHORIZED_HEADERS,
    });
  } catch (error) {
    // Full trace only to the logger; the client gets an opaque 500 body
    // so we do not leak internals (design §Endpoint HTTP > Errores).
    console.error("[k8s-cost] unhandled error:", error);
    finish(500, { unhandled: true });
    return NextResponse.json(
      { error: "Failed to fetch EKS cost summary" },
      { status: 500, headers: AUTHORIZED_HEADERS },
    );
  }
}
