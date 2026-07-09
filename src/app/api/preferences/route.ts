import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";

// GET /api/preferences?key=project_presets
export async function GET(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;
  const email = auth.session.user?.email;
  if (!email) return NextResponse.json({ value: null });

  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key");
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });

  const { rows } = await pool.query(
    `SELECT pref_value FROM user_preferences WHERE user_email = $1 AND pref_key = $2`,
    [email, key]
  );
  return NextResponse.json({ value: rows[0]?.pref_value ?? null });
}

// POST /api/preferences — { key, value }
export async function POST(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;
  const email = auth.session.user?.email;
  if (!email) return NextResponse.json({ error: "No email" }, { status: 400 });

  const { key, value } = await request.json();
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });

  await pool.query(
    `INSERT INTO user_preferences (user_email, pref_key, pref_value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_email, pref_key) DO UPDATE SET pref_value = $3, updated_at = NOW()`,
    [email, key, JSON.stringify(value)]
  );
  return NextResponse.json({ ok: true });
}
