import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { hasSessionMinimumRole } from "@/lib/session-role";
import { getUserActivitySummary } from "@/lib/user-activity";

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
        const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 30;
        const summary = await getUserActivitySummary(days);
        return NextResponse.json(summary);
    } catch (error) {
        console.error("Activity summary error:", error);
        return NextResponse.json({ error: "Failed to fetch activity summary" }, { status: 500 });
    }
}
