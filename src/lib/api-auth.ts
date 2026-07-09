/**
 * API Route Authentication Helpers
 *
 * Two auth strategies:
 * 1. User auth — validates NextAuth JWT (for dashboard/UI API calls)
 * 2. Internal auth — validates a shared secret header (for CronJobs, n8n webhooks, backfill scripts)
 *
 * Usage:
 *   import { requireUserAuth, requireInternalAuth } from "@/lib/api-auth";
 *
 *   // User-facing route
 *   export async function GET(request: Request) {
 *     const auth = await requireUserAuth(request);
 *     if (auth.error) return auth.error;
 *     // auth.session available
 *   }
 *
 *   // Internal/CronJob route
 *   export async function POST(request: Request) {
 *     const auth = requireInternalAuth(request);
 *     if (auth.error) return auth.error;
 *   }
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { AppRole, hasMinimumRole, roleFromTokenData } from "@/lib/rbac";
import type { Session } from "next-auth";

type UserAuthSuccess = { session: Session; error: null };
type UserAuthFailure = { session: null; error: NextResponse };
type UserAuthResult = UserAuthSuccess | UserAuthFailure;

type InternalAuthSuccess = { error: null };
type InternalAuthFailure = { error: NextResponse };
type InternalAuthResult = InternalAuthSuccess | InternalAuthFailure;

const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

/**
 * Validates that the request comes from an authenticated user via NextAuth session.
 * Optionally checks for a minimum role.
 */
export async function requireUserAuth(
  request: Request,
  minimumRole?: AppRole
): Promise<UserAuthResult> {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return {
      session: null,
      error: NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      ),
    };
  }

  if (minimumRole) {
    const role = roleFromTokenData({
      appRole: (session.user as any).appRole,
      roles: (session.user as any).roles,
    });

    if (!hasMinimumRole(role, minimumRole)) {
      return {
        session: null,
        error: NextResponse.json(
          { error: "Insufficient permissions", required: minimumRole },
          { status: 403 }
        ),
      };
    }
  }

  return { session, error: null };
}

/**
 * Validates that the request comes from an internal service (CronJob, n8n, backfill script)
 * using a shared secret in the `x-internal-secret` header.
 *
 * Falls back to allowing the request if INTERNAL_API_SECRET is not configured,
 * to avoid breaking existing deployments. Logs a warning in that case.
 */
export function requireInternalAuth(request: Request): InternalAuthResult {
  if (!INTERNAL_API_SECRET) {
    console.warn(
      "[api-auth] INTERNAL_API_SECRET not configured — internal route is unprotected. " +
      "Set INTERNAL_API_SECRET env var to secure internal endpoints."
    );
    return { error: null };
  }

  const provided = request.headers.get("x-internal-secret");

  if (provided !== INTERNAL_API_SECRET) {
    return {
      error: NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      ),
    };
  }

  return { error: null };
}

/**
 * Accepts either user auth OR internal auth.
 * Useful for routes that can be called by both users and CronJobs.
 */
export async function requireAnyAuth(
  request: Request
): Promise<UserAuthResult | InternalAuthResult> {
  // Try internal auth first (cheaper, no DB/session lookup)
  const internal = requireInternalAuth(request);
  if (!internal.error) return internal;

  // Fall back to user auth
  return requireUserAuth(request);
}
