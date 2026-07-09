import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";

// GET /api/notifications — list notifications for the current user
export async function GET(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const email = auth.session.user?.email;
  if (!email) return NextResponse.json({ error: "No email in session" }, { status: 400 });

  // Domain migration: search both @iskaypet.com and @emefinpetcare.com
  const altEmail = email.includes("@emefinpetcare.com")
    ? email.replace("@emefinpetcare.com", "@iskaypet.com")
    : email.includes("@iskaypet.com")
    ? email.replace("@iskaypet.com", "@emefinpetcare.com")
    : null;
  const emails = altEmail ? [email, altEmail] : [email];

  const { searchParams } = new URL(request.url);
  const unreadOnly = searchParams.get("unread") === "true";
  const limit = Math.min(Number(searchParams.get("limit")) || 50, 100);

  const query = unreadOnly
    ? `SELECT * FROM user_notifications WHERE user_email = ANY($1) AND read = false ORDER BY created_at DESC LIMIT $2`
    : `SELECT * FROM user_notifications WHERE user_email = ANY($1) ORDER BY created_at DESC LIMIT $2`;

  const { rows } = await pool.query(query, [emails, limit]);

  const countResult = await pool.query(
    `SELECT COUNT(*) as count FROM user_notifications WHERE user_email = ANY($1) AND read = false`,
    [emails]
  );

  return NextResponse.json({
    notifications: rows,
    unreadCount: Number(countResult.rows[0]?.count || 0),
  });
}
