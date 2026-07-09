import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { AppRole, hasMinimumRole, roleFromTokenData } from "@/lib/rbac";
import { buildNextParam } from "@/lib/navigation/internal-path";

type RoleRule = {
    prefix: string;
    minimumRole: AppRole;
};

const ROLE_RULES: RoleRule[] = [
    { prefix: "/admin", minimumRole: "admin" },
    { prefix: "/aws-inventory", minimumRole: "admin" },
    { prefix: "/finops/advisor", minimumRole: "admin" },
    { prefix: "/metrics", minimumRole: "externos" },
    { prefix: "/synthetics", minimumRole: "externos" },
    { prefix: "/finops", minimumRole: "desarrolladores" },
    { prefix: "/finops-athena", minimumRole: "desarrolladores" },
    { prefix: "/kiro-analytics", minimumRole: "managers" },
    { prefix: "/user-onboarding", minimumRole: "staff" },
];

/** API routes that require user authentication (JWT) */
const API_ROLE_RULES: RoleRule[] = [
    { prefix: "/api/admin", minimumRole: "admin" },
    { prefix: "/api/metrics", minimumRole: "editor" },
    { prefix: "/api/sonarqube", minimumRole: "editor" },
    { prefix: "/api/gitlab", minimumRole: "editor" },
    { prefix: "/api/ai", minimumRole: "editor" },
    { prefix: "/api/finops", minimumRole: "editor" },
    { prefix: "/api/kiro-analytics", minimumRole: "managers" },
    // Synthetics read endpoints used by the /synthetics page (which is open to
    // `externos`). These mirror the public-ish UI tabs (monitors stats,
    // external services status, Lighthouse audits). Keep BEFORE the general
    // /api/synthetics rule so they match first.
    { prefix: "/api/synthetics/lighthouse", minimumRole: "externos" },
    { prefix: "/api/synthetics/stats", minimumRole: "externos" },
    { prefix: "/api/synthetics/external-status", minimumRole: "externos" },
    { prefix: "/api/synthetics", minimumRole: "editor" },
    { prefix: "/api/reliability", minimumRole: "editor" },
    { prefix: "/api/cybersecurity", minimumRole: "editor" },
    { prefix: "/api/inventory", minimumRole: "editor" },
];

/**
 * API routes that are called by internal services (CronJobs, n8n, backfill scripts).
 * These use x-internal-secret header auth instead of user JWT.
 * They are excluded from the API role check in middleware.
 */
const INTERNAL_API_PREFIXES = [
    "/api/metrics/snapshot",
    "/api/metrics/snapshot-all",
    "/api/metrics/backfill",
    "/api/metrics/correlate",
    "/api/metrics/compliance-snapshot",
    "/api/metrics/k8s-snapshot",
    "/api/metrics/k8s-mapping",
    "/api/sonarqube/snapshot",
    "/api/gitlab/mr-snapshot",
    "/api/cybersecurity/intake",
    "/api/reliability/incidents/intake",
    "/api/synthetics/rollup",
    "/api/synthetics/run",
    "/api/finops/snapshot",
    "/api/finops/ai-cost/snapshot",
    "/api/infra-assistant/execute",
    "/api/infra-requests/reminders",
    "/api/access-management/execute",
];

const isProtectedPath = (pathname: string): RoleRule | null =>
    ROLE_RULES.find((rule) => pathname === rule.prefix || pathname.startsWith(`${rule.prefix}/`)) || null;

const isProtectedApiPath = (pathname: string): RoleRule | null =>
    API_ROLE_RULES.find((rule) => pathname === rule.prefix || pathname.startsWith(`${rule.prefix}/`)) || null;

const isInternalApiPath = (pathname: string): boolean =>
    INTERNAL_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

export async function middleware(request: NextRequest) {
    const { pathname, search } = request.nextUrl;

    // Auth routes are always public
    if (pathname.startsWith("/api/auth/")) {
        return NextResponse.next();
    }

    // Internal API routes handle their own auth via x-internal-secret
    if (isInternalApiPath(pathname)) {
        return NextResponse.next();
    }

    // Protected API routes — require user JWT
    if (pathname.startsWith("/api/")) {
        const apiRule = isProtectedApiPath(pathname);
        if (apiRule) {
            const token = await getToken({ req: request });
            if (!token) {
                return NextResponse.json({ error: "Authentication required" }, { status: 401 });
            }
            const role = roleFromTokenData({ appRole: token.appRole, roles: token.roles });
            if (!hasMinimumRole(role, apiRule.minimumRole)) {
                return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
            }
        }
        return NextResponse.next();
    }

    // Home page is public
    if (pathname === "/") {
        return NextResponse.next();
    }

    // Protected page routes
    const token = await getToken({ req: request });
    if (!token) {
        const redirectUrl = new URL("/", request.url);
        const next = buildNextParam(pathname, search);
        if (next) {
            redirectUrl.searchParams.set("next", next);
        }
        return NextResponse.redirect(redirectUrl);
    }

    const role = roleFromTokenData({
        appRole: token.appRole,
        roles: token.roles,
    });

    const required = isProtectedPath(pathname);
    if (required && !hasMinimumRole(role, required.minimumRole)) {
        const redirectUrl = new URL("/", request.url);
        redirectUrl.searchParams.set("forbidden", required.minimumRole);
        return NextResponse.redirect(redirectUrl);
    }

    return NextResponse.next();
}

export const config = {
    matcher: [
        "/((?!_next/static|_next/image|favicon.ico|logo.svg|next.svg|vercel.svg|window.svg|globe.svg|file.svg).*)",
    ],
};
