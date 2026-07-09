import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";

// GET /api/notifications/count — unread count (lightweight, for polling)
export async function GET(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const email = auth.session.user?.email;
  if (!email) return NextResponse.json({ count: 0 });

  // Domain migration: check both @iskaypet.com and @emefinpetcare.com
  const altEmail = email.includes("@emefinpetcare.com")
    ? email.replace("@emefinpetcare.com", "@iskaypet.com")
    : email.includes("@iskaypet.com")
    ? email.replace("@iskaypet.com", "@emefinpetcare.com")
    : null;
  const emails = altEmail ? [email, altEmail] : [email];

  const { rows } = await pool.query(
    `SELECT COUNT(*) as count FROM user_notifications WHERE user_email = ANY($1) AND read = false`,
    [emails]
  );

  return NextResponse.json({ count: Number(rows[0]?.count || 0) });
}
