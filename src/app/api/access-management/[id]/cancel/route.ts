import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";
import { createNotification } from "@/lib/notifications";
import { emailsMatch } from "@/lib/access-management/domain-normalizer";

// POST /api/access-management/[id]/cancel
// Allows the requestor to cancel their OWN access request while it is still pending.
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const email = auth.session.user?.email?.toLowerCase() || "";
  const requestId = Number(params.id);

  if (isNaN(requestId)) {
    return NextResponse.json({ error: "Invalid request id" }, { status: 400 });
  }

  // Load request
  const { rows } = await pool.query(
    "SELECT * FROM access_requests WHERE id = $1",
    [requestId]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const accessRequest = rows[0];

  // Ownership check (domain-normalized)
  if (!emailsMatch(accessRequest.requestor_email, email)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // Atomic status transition: only cancel if still pending.
  const { rowCount } = await pool.query(
    "UPDATE access_requests SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status = 'pending'",
    [requestId]
  );

  if (rowCount === 0) {
    return NextResponse.json(
      { error: `Cannot cancel: status is ${accessRequest.status}` },
      { status: 409 }
    );
  }

  // Notify the approver (best-effort)
  const approverEmail = accessRequest.approver_email || "";
  if (approverEmail) {
    await createNotification({
      userEmail: approverEmail,
      type: "info",
      title: "Solicitud de acceso cancelada",
      message: `${accessRequest.requestor_email} ha cancelado su solicitud de acceso a ${(accessRequest.platform || "").toUpperCase()}.`,
      link: "/infra-requests",
      metadata: { requestId },
    }).catch(() => {});
  }

  return NextResponse.json({ id: requestId, status: "cancelled" });
}
