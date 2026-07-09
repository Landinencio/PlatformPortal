/**
 * Iskay (FinOps chat) — Excel report download endpoint.
 *
 * `GET /api/finops/report/[id]` serves the workbook produced by the `build_report`
 * tool. The buffer lives in Postgres (`finops_reports` table) so the download
 * works regardless of which replica handles the request — the chat turn that
 * generated the report and the GET that downloads it can hit different pods.
 *
 * Auth model:
 *  - Same gate as the chat itself: only `admin`/`directores` can hit this route
 *    (Iskay's read-only audience). A logged-in user without that minimum role
 *    gets 403 from `requireUserAuth`.
 *  - Ownership: the row carries the requester's email; we domain-normalize the
 *    comparison via `emailsMatch` so `@iskaypet.com` ↔ `@emefinpetcare.com`
 *    work transparently. A different authorized user gets 403 (authoritative —
 *    they're logged in, just not the owner). The spec accepts 404 here too;
 *    we pick 403 because it carries useful information without leaking content.
 *
 * Not-found / expired collapse to 404 (the store's `getReport` already treats
 * expired rows as inexistent, so callers can't tell them apart — by design).
 */

import { NextResponse } from "next/server";

import { requireUserAuth } from "@/lib/api-auth";
import { emailsMatch } from "@/lib/access-management/domain-normalizer";
import { getReport } from "@/lib/finops-report-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Build a Content-Disposition header that survives non-ASCII filenames.
 *
 * Strategy: include both the legacy `filename="..."` (escaped quotes,
 * non-ASCII stripped to `_`) for old clients and `filename*=UTF-8''...` per
 * RFC 5987 so modern browsers preserve accents/emoji in the saved file name.
 */
function buildContentDisposition(filename: string): string {
  // Strip path separators and quotes so a malicious filename can't break out
  // of the header. Replace non-ASCII with `_` for the legacy parameter.
  const sanitized = filename.replace(/[\r\n"\\/]/g, "_");
  const ascii = sanitized.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(sanitized);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  // Same admin/directores gate as the chat (`POST /api/ai/finops-chat`).
  const auth = await requireUserAuth(request, "directores");
  if (auth.error) return auth.error;

  const sessionEmail = auth.session.user?.email || "";
  if (!sessionEmail) {
    // Defensive: a session without an email can't satisfy ownership anyway.
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const report = await getReport(params.id);
  if (!report) {
    // Covers both "never existed" and "expired" — the store already collapses
    // them, and we don't want to leak which one it was.
    return NextResponse.json({ error: "Report not found" }, { status: 404 });
  }

  if (!emailsMatch(report.userEmail, sessionEmail)) {
    return NextResponse.json(
      { error: "Forbidden: not the owner of this report" },
      { status: 403 },
    );
  }

  return new NextResponse(report.content, {
    status: 200,
    headers: {
      "Content-Type": XLSX_CONTENT_TYPE,
      "Content-Disposition": buildContentDisposition(report.filename),
      "Content-Length": String(report.content.length),
      // Reports are short-lived per-user artefacts; don't let intermediaries cache.
      "Cache-Control": "private, no-store",
    },
  });
}
