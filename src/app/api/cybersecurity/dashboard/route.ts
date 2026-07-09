import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { hasSessionMinimumRole } from "@/lib/session-role";
import { getCybersecurityDashboard } from "@/lib/cybersecurity";
import { ENABLE_CYBERSECURITY } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!ENABLE_CYBERSECURITY) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasSessionMinimumRole(session, "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const data = await getCybersecurityDashboard();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Cybersecurity dashboard error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.includes("schema is not ready") ? 503 : 500;

    return NextResponse.json(
      {
        error: "Failed to load cybersecurity dashboard",
        details: message,
      },
      { status }
    );
  }
}
