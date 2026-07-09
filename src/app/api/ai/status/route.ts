import { NextResponse } from "next/server";
import { bedrockClient } from "@/lib/bedrock";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({
      provider: bedrockClient.getStatus(),
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("AI status error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch AI status",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
