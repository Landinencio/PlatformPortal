import { NextResponse } from "next/server";
import pool, { getPoolStats } from "@/lib/db";
import { cacheStats } from "@/lib/cache";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await pool.query("SELECT 1");
    return NextResponse.json({
      status: "ok",
      db: "connected",
      pool: getPoolStats(),
      cache: cacheStats(),
    });
  } catch (error) {
    return NextResponse.json(
      { status: "degraded", db: "unreachable", error: String(error), pool: getPoolStats(), cache: cacheStats() },
      { status: 503 }
    );
  }
}
