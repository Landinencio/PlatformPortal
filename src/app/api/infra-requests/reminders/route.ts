import { NextResponse } from "next/server";
import { requireInternalAuth } from "@/lib/api-auth";
import pool from "@/lib/db";
import { createNotificationBatch } from "@/lib/notifications";
import { getNotifyList } from "@/lib/infra-approvers";

export async function POST(request: Request) {
  const auth = requireInternalAuth(request);
  if (auth.error) return auth.error;

  // Find stale pending requests (>24h, no reminder sent)
  const { rows } = await pool.query(`
    SELECT id, requestor_email, requestor_name, resource_type, team, payload
    FROM infra_requests
    WHERE status = 'pending'
      AND created_at < NOW() - INTERVAL '24 hours'
      AND reminder_sent_at IS NULL
  `);

  if (rows.length === 0) {
    return NextResponse.json({ reminded: 0 });
  }

  // Send reminders
  for (const row of rows) {
    const payload =
      typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    const approverEmail = payload?.approver || "";
    const notifyEmails = approverEmail ? getNotifyList(approverEmail) : [];

    if (notifyEmails.length > 0) {
      await createNotificationBatch(
        notifyEmails.map((email) => ({
          userEmail: email,
          type: "approval_request" as const,
          title: `⏰ Recordatorio: solicitud pendiente de ${row.resource_type}`,
          message: `La solicitud de ${row.requestor_name || row.requestor_email} lleva más de 24h pendiente.`,
          link: "/infra-requests",
          metadata: { requestId: row.id, reminder: true },
        }))
      ).catch((err) =>
        console.error(`Reminder notification error for ${row.id}:`, err)
      );
    }

    // Mark as reminded
    await pool.query(
      "UPDATE infra_requests SET reminder_sent_at = NOW() WHERE id = $1",
      [row.id]
    );
  }

  return NextResponse.json({ reminded: rows.length });
}
