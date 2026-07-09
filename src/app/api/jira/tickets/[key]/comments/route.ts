/**
 * GET /api/jira/tickets/[key]/comments — Get comments for a Jira issue
 * POST /api/jira/tickets/[key]/comments — Add a comment to a Jira issue
 */

import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import { mapJiraErrorStatus } from "@/lib/jira";
import pool from "@/lib/db";

const JIRA_BASE = process.env.JIRA_BASE_URL || "https://iskaypet.atlassian.net";
const JIRA_EMAIL = process.env.JIRA_EMAIL || "";
const JIRA_TOKEN = process.env.JIRA_API_TOKEN || "";

function authHeader(): string {
  return `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64")}`;
}

async function jiraFetch(endpoint: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(`${JIRA_BASE}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract plain text from Jira ADF (Atlassian Document Format) body.
 */
function adfToText(adf: any): string {
  if (!adf || !adf.content) return "";
  const parts: string[] = [];

  function walk(nodes: any[]) {
    for (const node of nodes) {
      if (node.type === "text") {
        parts.push(node.text || "");
      } else if (node.type === "hardBreak") {
        parts.push("\n");
      } else if (node.content) {
        walk(node.content);
        if (node.type === "paragraph" || node.type === "heading") {
          parts.push("\n");
        }
      }
    }
  }

  walk(adf.content);
  return parts.join("").trim();
}

export async function GET(
  request: Request,
  { params }: { params: { key: string } }
) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const email = auth.session.user?.email || "";
  const issueKey = params.key;

  // Verify the ticket belongs to this user (check both email domains)
  const altEmail = email.includes("@emefinpetcare.com")
    ? email.replace("@emefinpetcare.com", "@iskaypet.com")
    : email.includes("@iskaypet.com")
    ? email.replace("@iskaypet.com", "@emefinpetcare.com")
    : null;

  const checkQuery = altEmail
    ? `SELECT id FROM portal_tickets WHERE jira_key = $1 AND requestor_email IN ($2, $3)`
    : `SELECT id FROM portal_tickets WHERE jira_key = $1 AND requestor_email = $2`;
  const checkParams = altEmail ? [issueKey, email, altEmail] : [issueKey, email];

  const { rows } = await pool.query(checkQuery, checkParams);
  if (rows.length === 0) {
    return NextResponse.json({ error: "Ticket not found or not yours" }, { status: 404 });
  }

  // Fetch comments from Jira
  try {
    const res = await jiraFetch(`/rest/api/3/issue/${issueKey}/comment?orderBy=created`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[jira-comments] GET failed for ${issueKey}: ${res.status} ${text.slice(0, 200)}`);
      return NextResponse.json({ comments: [] });
    }

    const data = await res.json();
    const comments = (data.comments || []).map((c: any) => {
      const rawBody = adfToText(c.body);
      let author = c.author?.displayName || "Unknown";
      let body = rawBody;

      // If comment was posted from the portal, extract the real author from the body
      // Format: "💬 Name (email):\nActual comment text"
      const portalMatch = rawBody.match(/^💬\s+(.+?)\s+\(([^)]+)\):\n?([\s\S]*)$/);
      if (portalMatch) {
        author = portalMatch[1]; // Real user name
        body = portalMatch[3].trim(); // Actual comment without attribution line
      }

      return {
        id: c.id,
        author,
        authorEmail: c.author?.emailAddress || "",
        body,
        created: c.created,
        updated: c.updated,
      };
    });

    return NextResponse.json({ comments });
  } catch (err) {
    console.error(`[jira-comments] Error fetching comments for ${issueKey}:`, err);
    return NextResponse.json({ comments: [] });
  }
}

export async function POST(
  request: Request,
  { params }: { params: { key: string } }
) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const email = auth.session.user?.email || "";
  const userName = auth.session.user?.name || email;
  const issueKey = params.key;

  // Verify the ticket belongs to this user
  const altEmail = email.includes("@emefinpetcare.com")
    ? email.replace("@emefinpetcare.com", "@iskaypet.com")
    : email.includes("@iskaypet.com")
    ? email.replace("@iskaypet.com", "@emefinpetcare.com")
    : null;

  const checkQuery = altEmail
    ? `SELECT id FROM portal_tickets WHERE jira_key = $1 AND requestor_email IN ($2, $3)`
    : `SELECT id FROM portal_tickets WHERE jira_key = $1 AND requestor_email = $2`;
  const checkParams = altEmail ? [issueKey, email, altEmail] : [issueKey, email];

  const { rows } = await pool.query(checkQuery, checkParams);
  if (rows.length === 0) {
    return NextResponse.json({ error: "Ticket not found or not yours" }, { status: 404 });
  }

  const body = await request.json();
  const { comment } = body as { comment: string };

  if (!comment || !comment.trim()) {
    return NextResponse.json({ error: "Comment is required" }, { status: 400 });
  }

  // Post comment to Jira in ADF format with user attribution
  const adfBody = {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: `💬 ${userName} (${email}):`, marks: [{ type: "strong" }] },
        ],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: comment.trim() }],
      },
    ],
  };

  try {
    const res = await jiraFetch(`/rest/api/3/issue/${issueKey}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: adfBody }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[jira-comments] POST failed for ${issueKey}: ${res.status} ${text.slice(0, 200)}`);
      return NextResponse.json(
        { error: text.trim().slice(0, 500) || "Failed to add comment", jiraStatus: res.status },
        { status: mapJiraErrorStatus(res.status) }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`[jira-comments] Error posting comment for ${issueKey}:`, err);
    return NextResponse.json({ error: "Failed to add comment" }, { status: 500 });
  }
}
