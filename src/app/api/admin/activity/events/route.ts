import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { hasSessionMinimumRole } from "@/lib/session-role";
import { getUserActivityEvents } from "@/lib/user-activity";

export async function GET(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!hasSessionMinimumRole(session, "admin")) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    try {
        const { searchParams } = new URL(request.url);
        const daysRaw = parseInt(searchParams.get("days") || "30", 10);
        const limitRaw = parseInt(searchParams.get("limit") || "200", 10);
        const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 30;
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;

        const payload = await getUserActivityEvents(days, limit);
        return NextResponse.json(payload);
    } catch (error) {
        console.error("Activity events error:", error);
        return NextResponse.json({ error: "Failed to fetch activity events" }, { status: 500 });
    }
}
