/**
 * Shared helpers for the Kiro Analytics API routes.
 *
 * - `guard()` enforces the portal next-auth session + minimum role (Requirement 1).
 * - `parseFilters()` validates the user/date filters (Requirement 4).
 * - `cachedJson()` wraps responses with the portal cache under the
 *   `kiro-analytics` prefix (Requirement 11).
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";
import type { AppRole } from "@/lib/rbac";
import { cached, cacheKey } from "@/lib/cache";
import { ValidationError, AthenaQueryError, parseUserFilter, assertValidDate } from "@/lib/kiro-analytics";

/** Minimum role required to access Kiro Analytics (data is per-person sensitive). */
export const KIRO_ANALYTICS_MIN_ROLE: AppRole = "managers";

/** Dedicated cache prefix for selective invalidation. */
export const KIRO_CACHE_PREFIX = "kiro-analytics";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

type GuardResult = { ok: true } | { ok: false; response: NextResponse };

export async function guard(): Promise<GuardResult> {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return { ok: false, response: NextResponse.json({ error: "Authentication required" }, { status: 401 }) };
  }
  const role = getSessionRole(session);
  if (!hasMinimumRole(role, KIRO_ANALYTICS_MIN_ROLE)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Insufficient permissions", required: KIRO_ANALYTICS_MIN_ROLE },
        { status: 403 },
      ),
    };
  }
  return { ok: true };
}

export interface ParsedFilters {
  users: string[];
  startDate?: string;
  endDate?: string;
}

/** Parse + validate the common query string filters. Throws ValidationError. */
export function parseFilters(request: NextRequest): ParsedFilters {
  const { searchParams } = new URL(request.url);
  const users = parseUserFilter(searchParams.get("users"));
  const startDate = searchParams.get("startDate") || undefined;
  const endDate = searchParams.get("endDate") || undefined;
  assertValidDate(startDate, "startDate");
  assertValidDate(endDate, "endDate");
  return { users, startDate, endDate };
}

/**
 * Build a cache key that incorporates the user filter + date range so distinct
 * combinations are cached separately. Never includes raw prompt text.
 */
export function key(name: string, params: Record<string, unknown>): string {
  return cacheKey(KIRO_CACHE_PREFIX, { endpoint: name, ...params });
}

/** Resolve a guarded + cached JSON response, mapping known errors to statuses. */
export async function cachedJson<T>(
  cacheKeyStr: string,
  compute: () => Promise<T>,
): Promise<NextResponse> {
  try {
    const data = await cached(cacheKeyStr, compute, CACHE_TTL_MS);
    return NextResponse.json(data);
  } catch (err) {
    return errorResponse(err);
  }
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ValidationError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (err instanceof AthenaQueryError) {
    // Generic message — no SQL/credentials leaked (Requirement 3.4/3.5).
    console.error("[kiro-analytics] query error:", err.message);
    return NextResponse.json({ error: "Data source query failed" }, { status: 502 });
  }
  console.error("[kiro-analytics] error:", err);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}
