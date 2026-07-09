import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";

// POST /api/notifications/read — mark notifications as read
export async function POST(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const email = auth.session.user?.email;
  if (!email) return NextResponse.json({ error: "No email in session" }, { status: 400 });

  // Domain migration: mark as read for both @iskaypet.com and @emefinpetcare.com
  const altEmail = email.includes("@emefinpetcare.com")
    ? email.replace("@emefinpetcare.com", "@iskaypet.com")
    : email.includes("@iskaypet.com")
    ? email.replace("@iskaypet.com", "@emefinpetcare.com")
    : null;
  const emails = altEmail ? [email, altEmail] : [email];

  const body = await request.json();
  const { ids, all } = body as { ids?: number[]; all?: boolean };

  if (all) {
    await pool.query(
      `UPDATE user_notifications SET read = true, read_at = NOW() WHERE user_email = ANY($1) AND read = false`,
      [emails]
    );
  } else if (Array.isArray(ids) && ids.length > 0) {
    await pool.query(
      `UPDATE user_notifications SET read = true, read_at = NOW() WHERE user_email = ANY($1) AND id = ANY($2) AND read = false`,
      [emails, ids]
    );
  } else {
    return NextResponse.json({ error: "Provide ids or all:true" }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
