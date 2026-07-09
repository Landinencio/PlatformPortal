import { NextResponse } from "next/server";
import { ingestCybersecurityReport } from "@/lib/cybersecurity";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await ingestCybersecurityReport(body);

    return NextResponse.json({
      ...result,
      ingestedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Cybersecurity intake error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      error instanceof Error && error.name === "ZodError"
        ? 400
        : message.includes("schema is not ready")
          ? 503
          : 500;

    return NextResponse.json(
      {
        error: "Failed to ingest cybersecurity report",
        details: message,
      },
      { status }
    );
  }
}
