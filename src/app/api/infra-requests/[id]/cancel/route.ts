import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";
import { createNotification } from "@/lib/notifications";

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
    "SELECT * FROM infra_requests WHERE id = $1",
    [requestId]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const infra = rows[0];

  // Ownership check (normalize domain for iskaypet ↔ emefinpetcare migration)
  const normalize = (e: string) =>
    e.toLowerCase().replace("@emefinpetcare.com", "@iskaypet.com");

  if (normalize(infra.requestor_email) !== normalize(email)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // Status check
  if (infra.status !== "pending") {
    return NextResponse.json(
      { error: `Cannot cancel: status is ${infra.status}` },
      { status: 409 }
    );
  }

  // Update status
  await pool.query(
    "UPDATE infra_requests SET status = 'cancelled' WHERE id = $1",
    [requestId]
  );

  // Notify approver (from payload)
  const payload =
    typeof infra.payload === "string" ? JSON.parse(infra.payload) : infra.payload;
  const approverEmail = payload?.approver || "";

  if (approverEmail) {
    await createNotification({
      userEmail: approverEmail,
      type: "info",
      title: "Solicitud cancelada",
      message: `${infra.requestor_name || email} ha cancelado su solicitud de ${infra.resource_type}.`,
      link: "/infra-requests",
      metadata: { requestId },
    }).catch(() => {});
  }

  return NextResponse.json({ id: requestId, status: "cancelled" });
}
