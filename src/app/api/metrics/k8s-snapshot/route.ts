import { NextResponse } from "next/server";
import { subDays } from "date-fns";

import {
  generateK8sSnapshots,
  parseK8sSnapshotDay,
  previewK8sSnapshot,
} from "@/lib/k8s-snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const dateStr = searchParams.get("date");
    const parsedDate = parseK8sSnapshotDay(dateStr);
    if (dateStr && !parsedDate) {
      return NextResponse.json(
        { error: "Invalid date format. Use YYYY-MM-DD" },
        { status: 400 }
      );
    }

    const date = parsedDate || subDays(new Date(), 1);
    const snapshot = await previewK8sSnapshot(date);

    return NextResponse.json({
      success: true,
      preview: true,
      ...snapshot,
    });
  } catch (error) {
    console.error("K8s snapshot preview error:", error);
    return NextResponse.json(
      { error: "Failed to get K8s metrics", details: String(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const dateStr = searchParams.get("date");
    const parsedDate = parseK8sSnapshotDay(dateStr);
    if (dateStr && !parsedDate) {
      return NextResponse.json(
        { error: "Invalid date format. Use YYYY-MM-DD" },
        { status: 400 }
      );
    }

    const rawDaysParam = searchParams.get("days") || "1";
    const requestedDays = Number.parseInt(rawDaysParam, 10);
    if (!Number.isFinite(requestedDays) || requestedDays < 1) {
      return NextResponse.json(
        { error: "Invalid days value. Use a positive integer." },
        { status: 400 }
      );
    }

    const anchorDate = parsedDate || subDays(new Date(), 1);
    const payload = await generateK8sSnapshots(anchorDate, requestedDays);

    return NextResponse.json(
      payload,
      { status: payload.success ? 200 : 207 }
    );
  } catch (error) {
    console.error("K8s snapshot error:", error);
    return NextResponse.json(
      { error: "Failed to save K8s snapshot", details: String(error) },
      { status: 500 }
    );
  }
}
