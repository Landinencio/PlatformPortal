import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";
import { validateDaysParam, getDateRange } from "@/lib/admin-analytics";

export async function GET(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;
  const role = (auth.session.user as any)?.appRole || "externos";
  if (role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const email = searchParams.get("email");
  const days = validateDaysParam(searchParams.get("days"));
  const { from, to } = getDateRange(days);

  if (!email) {
    return NextResponse.json({ error: "Missing email parameter" }, { status: 400 });
  }

  try {
    // Get user info
    const { rows: userRows } = await pool.query(`
      SELECT
        user_email as email,
        MAX(user_name) as name,
        MAX(user_role) as role
      FROM portal_user_activity
      WHERE user_email = $1
      GROUP BY user_email
    `, [email]);

    if (userRows.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Get navigation history
    const { rows: navigationHistory } = await pool.query(`
      SELECT
        occurred_at,
        event_type,
        path,
        action
      FROM portal_user_activity
      WHERE user_email = $1
        AND occurred_at >= NOW() - INTERVAL '${days} days'
      ORDER BY occurred_at DESC
      LIMIT 200
    `, [email]);

    const user = userRows[0];

    return NextResponse.json({
      period: { days, from: from.toISOString(), to: to.toISOString() },
      data: {
        user: {
          email: user.email,
          name: user.name || user.email,
          role: user.role,
        },
        navigationHistory: navigationHistory.map(r => ({
          occurredAt: r.occurred_at,
          eventType: r.event_type,
          path: r.path,
          action: r.action,
        })),
      },
    });
  } catch (error) {
    console.error("[admin/analytics/user-detail] Query failed:", error);
    return NextResponse.json({ error: "Failed to fetch analytics" }, { status: 500 });
  }
}
