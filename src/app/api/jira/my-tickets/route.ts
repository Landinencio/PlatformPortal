/**
 * GET /api/jira/my-tickets — List tickets created by the current user
 * PATCH /api/jira/my-tickets — Update ticket status (close/reopen) + sync with Jira
 */

import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import pool from "@/lib/db";
import { jiraTransitionToDone, jiraTransitionToOpen, jiraSearchJql } from "@/lib/jira";

export async function GET(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const email = auth.session.user?.email || "";
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status"); // "open", "closed", or null (all)
  const type = searchParams.get("type"); // "incident", "request", or null (all)

  // Domain migration: search both @iskaypet.com and @emefinpetcare.com
  const altEmail = email.includes("@emefinpetcare.com")
    ? email.replace("@emefinpetcare.com", "@iskaypet.com")
    : email.includes("@iskaypet.com")
    ? email.replace("@iskaypet.com", "@emefinpetcare.com")
    : null;

  let query = altEmail
    ? `SELECT * FROM portal_tickets WHERE requestor_email IN ($1, $2)`
    : `SELECT * FROM portal_tickets WHERE requestor_email = $1`;
  const params: any[] = altEmail ? [email, altEmail] : [email];
  let paramIdx = altEmail ? 3 : 2;

  if (status === "open") {
    query += ` AND status != 'closed'`;
  } else if (status === "closed") {
    query += ` AND status = 'closed'`;
  }

  if (type === "incident" || type === "request") {
    query += ` AND type = $${paramIdx}`;
    params.push(type);
    paramIdx++;
  }

  query += ` ORDER BY created_at DESC LIMIT 50`;

  const { rows } = await pool.query(query, params);

  return NextResponse.json({ tickets: rows });
}

export async function PATCH(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const email = auth.session.user?.email || "";
  const body = await request.json();
  const { jiraKey, action } = body as { jiraKey: string; action: "close" | "reopen" };

  if (!jiraKey || !action) {
    return NextResponse.json({ error: "jiraKey and action required" }, { status: 400 });
  }

  // Verify the ticket belongs to this user
  const { rows } = await pool.query(
    `SELECT id, status FROM portal_tickets WHERE jira_key = $1 AND requestor_email = $2`,
    [jiraKey, email]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "Ticket not found or not yours" }, { status: 404 });
  }

  try {
    if (action === "close") {
      // Transition Jira to Done
      await jiraTransitionToDone(jiraKey);
      await pool.query(
        `UPDATE portal_tickets SET status = 'closed', closed_at = NOW(), updated_at = NOW() WHERE jira_key = $1`,
        [jiraKey]
      );
    } else if (action === "reopen") {
      // Reopen in Jira via the bilingual helper, which checks res.ok and reports
      // a structured result. BD↔Jira consistency contract: do NOT mark the portal
      // row as 'open' unless Jira actually transitioned the issue.
      const result = await jiraTransitionToOpen(jiraKey);

      if (!result.ok) {
        // No reopen transition available (matched === false with no upstream status)
        // → 422; Jira upstream failure (has an HTTP status) → 502. Never update the row.
        const httpStatus = !result.matched && result.status === undefined ? 422 : 502;
        return NextResponse.json(
          {
            error: result.matched
              ? "Failed to reopen ticket in Jira"
              : "No reopen transition available for this ticket in Jira",
            jiraStatus: result.status,
            detail: result.message,
          },
          { status: httpStatus }
        );
      }

      await pool.query(
        `UPDATE portal_tickets SET status = 'open', closed_at = NULL, updated_at = NOW() WHERE jira_key = $1`,
        [jiraKey]
      );
    }

    return NextResponse.json({ success: true, jiraKey, action });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
