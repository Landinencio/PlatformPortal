import { NextResponse } from "next/server";
import { ingestIncidents } from "@/lib/reliability";

export const dynamic = "force-dynamic";

function resolveBearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;

  const [scheme, token] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

export async function POST(request: Request) {
  try {
    const expectedToken = process.env.INCIDENTS_INGEST_TOKEN;
    if (!expectedToken) {
      return NextResponse.json(
        { error: "Incident intake is not enabled" },
        { status: 503 }
      );
    }

    const token = resolveBearerToken(request);
    if (token !== expectedToken) {
      return NextResponse.json(
        { error: "Unauthorized incident intake request" },
        { status: 401 }
      );
    }

    const body = await request.json();
    const result = await ingestIncidents(body);

    return NextResponse.json({
      ...result,
      ingestedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Incident intake error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = error instanceof Error && error.name === "ZodError"
      ? 400
      : message.includes("schema is not ready")
        ? 503
        : 500;

    return NextResponse.json(
      {
        error: "Failed to ingest incidents",
        details: message,
      },
      { status }
    );
  }
}
