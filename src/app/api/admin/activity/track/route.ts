import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionRole } from "@/lib/session-role";
import { trackUserActivity, UserActivityEventType } from "@/lib/user-activity";

const allowedEventTypes = new Set<UserActivityEventType>([
    "login",
    "session_start",
    "session_end",
    "page_view",
    "feature_click",
    "api_action",
]);

const asString = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const asObject = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

const readClientIp = (request: Request): string | null => {
    const forwardedFor = request.headers.get("x-forwarded-for");
    if (forwardedFor) {
        return forwardedFor.split(",")[0]?.trim() || null;
    }
    return request.headers.get("x-real-ip");
};

export async function POST(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await request.json();
        const eventTypeRaw = asString(body?.eventType);

        if (!eventTypeRaw || !allowedEventTypes.has(eventTypeRaw as UserActivityEventType)) {
            return NextResponse.json({ error: "Invalid eventType" }, { status: 400 });
        }

        const durationRaw = body?.durationSeconds;
        const durationSeconds =
            typeof durationRaw === "number" && Number.isFinite(durationRaw)
                ? Math.max(0, Math.floor(durationRaw))
                : null;

        await trackUserActivity({
            eventType: eventTypeRaw as UserActivityEventType,
            userEmail: session.user.email,
            userName: session.user.name,
            userRole: getSessionRole(session),
            authSub: session.user.oid || null,
            portalSessionId: asString(body?.portalSessionId),
            path: asString(body?.path),
            action: asString(body?.action),
            durationSeconds,
            metadata: asObject(body?.metadata),
            ipAddress: readClientIp(request),
            userAgent: request.headers.get("user-agent"),
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Activity track error:", error);
        return NextResponse.json({ error: "Failed to track activity" }, { status: 500 });
    }
}
