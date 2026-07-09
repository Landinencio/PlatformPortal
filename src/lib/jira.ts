/**
 * Jira Cloud API client.
 * Uses the new /rest/api/3/search/jql endpoint (POST).
 */

const JIRA_BASE = process.env.JIRA_BASE_URL || "https://iskaypet.atlassian.net";
const JIRA_EMAIL = process.env.JIRA_EMAIL || "";
const JIRA_TOKEN = process.env.JIRA_API_TOKEN || "";
const JIRA_FETCH_TIMEOUT = 20_000;

// One-time startup log to verify credentials presence
console.log(`[jira] Module loaded. BASE=${JIRA_BASE} EMAIL_SET=${!!JIRA_EMAIL} TOKEN_SET=${!!JIRA_TOKEN} TOKEN_LEN=${JIRA_TOKEN.length}`);

function authHeader(): string {
  return `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64")}`;
}

async function jiraFetch(endpoint: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JIRA_FETCH_TIMEOUT);
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

export async function jiraSearchJql(
  jql: string,
  fields: string[] = ["summary", "status", "assignee", "issuetype", "priority", "created", "updated", "resolutiondate"],
  maxResults = 100,
  nextPageToken?: string,
): Promise<{ issues: any[]; nextPageToken?: string }> {
  const body: any = { jql, fields, maxResults };
  if (nextPageToken) body.nextPageToken = nextPageToken;

  const res = await jiraFetch("/rest/api/3/search/jql", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jira ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function jiraGetProjects(): Promise<any[]> {
  const res = await jiraFetch("/rest/api/3/project");
  if (!res.ok) throw new Error(`Jira projects ${res.status}`);
  return res.json();
}

export async function jiraGetServiceDesks(): Promise<any[]> {
  const res = await jiraFetch("/rest/servicedeskapi/servicedesk");
  if (!res.ok) throw new Error(`Jira service desks ${res.status}`);
  const data = await res.json();
  return data.values || [];
}

export async function jiraGetQueues(serviceDeskId: string): Promise<any[]> {
  const res = await jiraFetch(`/rest/servicedeskapi/servicedesk/${serviceDeskId}/queue`);
  if (!res.ok) throw new Error(`Jira queues ${res.status}`);
  const data = await res.json();
  return data.values || [];
}

export type JiraIssueCompact = {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  type: string;
  priority: string;
  assignee: string | null;
  created: string;
  updated: string;
  resolved: string | null;
};

export function compactIssue(raw: any): JiraIssueCompact {
  const f = raw.fields || {};
  return {
    key: raw.key,
    summary: f.summary || "",
    status: f.status?.name || "Unknown",
    statusCategory: f.status?.statusCategory?.key || "undefined",
    type: f.issuetype?.name || "Unknown",
    priority: f.priority?.name || "Medium",
    assignee: f.assignee?.displayName || null,
    created: f.created?.slice(0, 10) || "",
    updated: f.updated?.slice(0, 10) || "",
    resolved: f.resolutiondate?.slice(0, 10) || null,
  };
}

/**
 * Convert a text description (with simple wiki-like markup) to Jira ADF format.
 * Supports: h2., h3., ||table||headers||, |cell|values|, plain paragraphs, _italic_
 */
function textToAdf(text: string): Record<string, unknown> {
  const lines = text.split("\n");
  const content: Record<string, unknown>[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Empty line → skip
    if (!line) { i++; continue; }

    // h2. heading
    if (line.startsWith("h2. ")) {
      content.push({
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: line.slice(4) }],
      });
      i++; continue;
    }

    // h3. heading
    if (line.startsWith("h3. ")) {
      content.push({
        type: "heading",
        attrs: { level: 3 },
        content: [{ type: "text", text: line.slice(4) }],
      });
      i++; continue;
    }

    // Table: collect consecutive lines starting with | or ||
    if (line.startsWith("|") || line.startsWith("||")) {
      const tableRows: Record<string, unknown>[] = [];

      while (i < lines.length && (lines[i].trim().startsWith("|") || lines[i].trim().startsWith("||"))) {
        const rowLine = lines[i].trim();
        const isHeader = rowLine.startsWith("||");
        const separator = isHeader ? "||" : "|";

        // Split cells: remove leading/trailing separator, split by separator
        const cellTexts = rowLine
          .replace(/^\|+/, "")
          .replace(/\|+$/, "")
          .split(separator)
          .map((c) => c.trim());

        const cells = cellTexts.map((cellText) => ({
          type: isHeader ? "tableHeader" : "tableCell",
          content: [
            {
              type: "paragraph",
              content: cellText ? [{ type: "text", text: cellText }] : [],
            },
          ],
        }));

        tableRows.push({ type: "tableRow", content: cells });
        i++;
      }

      content.push({ type: "table", attrs: { isNumberColumnEnabled: false, layout: "default" }, content: tableRows });
      continue;
    }

    // _italic text_ (entire line)
    if (line.startsWith("_") && line.endsWith("_")) {
      content.push({
        type: "paragraph",
        content: [{ type: "text", text: line.slice(1, -1), marks: [{ type: "em" }] }],
      });
      i++; continue;
    }

    // Regular paragraph
    content.push({
      type: "paragraph",
      content: [{ type: "text", text: line }],
    });
    i++;
  }

  return { type: "doc", version: 1, content };
}

/**
 * Create a Jira issue via REST API v3.
 * Requirement 5.4
 */
export async function jiraCreateIssue(opts: {
  projectKey: string
  issueTypeId: string
  summary: string
  description: string
  labels?: string[]
  priority?: string
  reporterEmail?: string
}): Promise<{ key: string; id: string; url: string }> {
  const { projectKey, issueTypeId, summary, description, labels, priority, reporterEmail } = opts;

  // Convert plain text description to proper ADF (Atlassian Document Format)
  const adfDescription = textToAdf(description);

  // Resolve reporter accountId from email before creating the issue
  let reporterField: Record<string, string> | undefined;
  if (reporterEmail) {
    const accountId = await jiraFindUserByEmail(reporterEmail);
    if (accountId) {
      reporterField = { accountId };
    } else {
      console.warn(`[jira] Reporter not found for ${reporterEmail}, will use default`);
    }
  }

  const body: Record<string, unknown> = {
    fields: {
      project: { key: projectKey },
      issuetype: { id: issueTypeId },
      summary,
      description: adfDescription,
      ...(labels && labels.length > 0 ? { labels } : {}),
      ...(priority ? { priority: { name: priority } } : {}),
      ...(reporterField ? { reporter: reporterField } : {}),
    },
  };

  const res = await jiraFetch("/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jira createIssue ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return {
    key: data.key,
    id: data.id,
    url: `${JIRA_BASE}/browse/${data.key}`,
  };
}

/**
 * Transition a Jira issue to "Done" status.
 * Tries common transition IDs for "Done" (31, 41, 51, 21).
 * If none work, attempts to find the correct transition dynamically.
 */
export async function jiraTransitionToDone(issueKey: string): Promise<void> {
  // First, get available transitions
  const transRes = await jiraFetch(`/rest/api/3/issue/${issueKey}/transitions`);
  if (!transRes.ok) {
    console.error(`[jira] Failed to get transitions for ${issueKey}: ${transRes.status}`);
    return;
  }

  const transData = await transRes.json();
  const transitions = transData.transitions || [];

  // Find a "Done" or "Cerrado" or "Resolved" transition
  const doneTransition = transitions.find((t: any) =>
    /done|cerrado|resolved|complete|hecho/i.test(t.name)
  );

  if (!doneTransition) {
    console.warn(`[jira] No 'Done' transition found for ${issueKey}. Available: ${transitions.map((t: any) => t.name).join(", ")}`);
    return;
  }

  const res = await jiraFetch(`/rest/api/3/issue/${issueKey}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: doneTransition.id } }),
  });

  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => "");
    console.error(`[jira] Transition to Done failed for ${issueKey}: ${res.status} ${text.slice(0, 200)}`);
  }
}

/**
 * A Jira workflow transition as returned by `GET /rest/api/3/issue/{key}/transitions`.
 * `to.statusCategory.key` is one of Jira's canonical category keys:
 * `"new"` (To Do), `"indeterminate"` (In Progress) or `"done"` (Done).
 */
export type JiraTransition = {
  id: string;
  name: string;
  to?: { statusCategory?: { key?: string } };
};

/**
 * Bilingual (EN/ES) regex matching the NAME of a "reopen" transition.
 *
 * Symmetric to the bilingual close matcher used in `jiraTransitionToDone`
 * (`/done|cerrado|resolved|complete|hecho/i`). Covers, case-insensitively:
 *  - EN: `reopen`, `re-open`, `to do`, `backlog`, `open`
 *  - ES: `reabr` (Reabrir/Reabierto), `volver a abrir`, `por hacer`,
 *        `abrir` (e.g. "Volver a abrir incidencia"), `pendiente`
 */
export const REOPEN_TRANSITION_REGEX =
  /reopen|re-open|reabr|volver a abrir|to do|por hacer|backlog|abrir|pendiente|open/i;

/**
 * Pure matcher (no network, no side effects) that selects the correct "reopen"
 * transition from a list of available Jira transitions.
 *
 * Strategy:
 *  1. Match by name with `REOPEN_TRANSITION_REGEX` (bilingual EN/ES).
 *  2. Fallback by destination status category: the first transition whose
 *     `to.statusCategory.key` is `"new"` (To Do) or `"indeterminate"` (In Progress),
 *     ALWAYS excluding `"done"`.
 *  3. `undefined` if nothing matches (including an empty list).
 */
export function matchReopenTransition(
  transitions: JiraTransition[]
): JiraTransition | undefined {
  if (!Array.isArray(transitions) || transitions.length === 0) {
    return undefined;
  }

  // (1) Match by transition name (bilingual).
  const byName = transitions.find(
    (t) => typeof t?.name === "string" && REOPEN_TRANSITION_REGEX.test(t.name)
  );
  if (byName) {
    return byName;
  }

  // (2) Fallback by destination status category, never selecting "done".
  const byCategory = transitions.find((t) => {
    const key = t?.to?.statusCategory?.key;
    return key === "new" || key === "indeterminate";
  });

  return byCategory;
}

/**
 * Structured result of a reopen transition attempt.
 *
 *  - `ok`           — the issue was successfully transitioned (the caller may
 *                     safely mark the portal row as `open`).
 *  - `matched`      — a reopen transition was found via `matchReopenTransition`.
 *  - `transitioned` — the `POST .../transitions` execution succeeded (res.ok / 204).
 *  - `status`       — the real upstream Jira HTTP status (when available).
 *  - `message`      — diagnostic detail (real Jira body on failure, or the list
 *                     of available transition names when no reopen match exists).
 */
export type TransitionResult = {
  ok: boolean;
  matched: boolean;
  transitioned: boolean;
  status?: number;
  message?: string;
};

/**
 * Transition a Jira issue to a "reopen" (To Do / In Progress) status.
 *
 * Symmetric to `jiraTransitionToDone` (bilingual matching + `res.ok` check) but
 * returns a structured `TransitionResult` so the caller can keep the portal DB
 * consistent with the real Jira state (only mark the row `open` when the issue
 * actually transitioned).
 *
 * Flow:
 *  1. `GET .../transitions` — if not OK, returns `{ ok:false, matched:false,
 *     transitioned:false, status, message }`.
 *  2. Apply `matchReopenTransition` — if no match, returns `{ ok:false,
 *     matched:false, transitioned:false, message:"No reopen transition.
 *     Available: <names>" }` for diagnostics.
 *  3. `POST .../transitions` checking `res.ok` (treating `204` as success),
 *     logging the real status/body on failure, and returning
 *     `{ ok, matched:true, transitioned, status, message }`.
 */
export async function jiraTransitionToOpen(issueKey: string): Promise<TransitionResult> {
  // 1) Fetch available transitions.
  const transRes = await jiraFetch(`/rest/api/3/issue/${issueKey}/transitions`);
  if (!transRes.ok) {
    const text = await transRes.text().catch(() => "");
    console.error(`[jira] Failed to get transitions for ${issueKey}: ${transRes.status} ${text.slice(0, 200)}`);
    return {
      ok: false,
      matched: false,
      transitioned: false,
      status: transRes.status,
      message: text.slice(0, 300),
    };
  }

  const transData = await transRes.json();
  const transitions: JiraTransition[] = transData.transitions || [];

  // 2) Match the reopen transition (bilingual name + status-category fallback).
  const reopen = matchReopenTransition(transitions);
  if (!reopen) {
    const names = transitions.map((t) => t.name).join(", ");
    console.warn(`[jira] No reopen transition found for ${issueKey}. Available: ${names}`);
    return {
      ok: false,
      matched: false,
      transitioned: false,
      message: `No reopen transition. Available: ${names}`,
    };
  }

  // 3) Execute the transition, checking res.ok (and treating 204 as success).
  const res = await jiraFetch(`/rest/api/3/issue/${issueKey}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: reopen.id } }),
  });

  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => "");
    console.error(`[jira] Reopen transition failed for ${issueKey}: ${res.status} ${text.slice(0, 200)}`);
    return {
      ok: false,
      matched: true,
      transitioned: false,
      status: res.status,
      message: text.slice(0, 300),
    };
  }

  return {
    ok: true,
    matched: true,
    transitioned: true,
    status: res.status,
  };
}

/**
 * Pure mapper (no network, no side effects) that turns a real upstream Jira
 * HTTP status into the status the comment endpoint should propagate to the
 * client, instead of masking everything behind a fixed `500`.
 *
 *  - `4xx` (client errors, 400–499) → the SAME code (e.g. 403 → 403, 404 → 404).
 *  - `>= 500` (server/upstream errors) → `502` (Bad Gateway — Jira is upstream).
 *  - any other unexpected value (e.g. `< 400`) → `502` as a safe default.
 */
export function mapJiraErrorStatus(jiraStatus: number): number {
  if (jiraStatus >= 400 && jiraStatus < 500) {
    return jiraStatus;
  }
  return 502;
}

/**
 * Attach one or more files to an existing Jira issue.
 * Uses multipart/form-data upload to the Jira REST API.
 *
 * @param issueKey - The Jira issue key (e.g. "SRE-123")
 * @param files - Array of { filename, buffer, mimeType }
 */
export async function jiraAddAttachments(
  issueKey: string,
  files: Array<{ filename: string; buffer: Buffer; mimeType: string }>
): Promise<void> {
  if (files.length === 0) return;

  for (const file of files) {
    const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;

    const bodyParts = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n`,
      `Content-Type: ${file.mimeType}\r\n\r\n`,
    ];

    const header = Buffer.from(bodyParts.join(""));
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, file.buffer, footer]);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    try {
      const res = await fetch(`${JIRA_BASE}/rest/api/3/issue/${issueKey}/attachments`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: authHeader(),
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "X-Atlassian-Token": "no-check",
        },
        body,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[jira] Attachment upload failed for ${issueKey}: ${res.status} ${text.slice(0, 200)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Find a Jira user by email address.
 * Tries both @iskaypet.com and @emefinpetcare.com variants.
 * Returns the accountId or null if not found.
 */
export async function jiraFindUserByEmail(email: string): Promise<string | null> {
  console.log(`[jira] findUserByEmail searching for: ${email}`);
  const res = await jiraFetch(`/rest/api/3/user/search?query=${encodeURIComponent(email)}`);
  console.log(`[jira] findUserByEmail status: ${res.status}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[jira] findUserByEmail FAILED: ${res.status} ${text.slice(0, 200)}`);
    return null;
  }
  const users = await res.json();
  console.log(`[jira] findUserByEmail found ${Array.isArray(users) ? users.length : 0} users for ${email}`);
  if (Array.isArray(users) && users.length > 0) {
    console.log(`[jira] findUserByEmail accountId=${users[0].accountId} displayName=${users[0].displayName}`);
    return users[0].accountId || null;
  }

  // Try alternate domain (@iskaypet.com ↔ @emefinpetcare.com)
  const altEmail = email.includes("@emefinpetcare.com")
    ? email.replace("@emefinpetcare.com", "@iskaypet.com")
    : email.includes("@iskaypet.com")
    ? email.replace("@iskaypet.com", "@emefinpetcare.com")
    : email.includes("@ext.emefinpetcare.com")
    ? email.replace("@ext.emefinpetcare.com", "@iskaypet.com")
    : null;

  if (altEmail) {
    console.log(`[jira] findUserByEmail retrying with alternate: ${altEmail}`);
    const res2 = await jiraFetch(`/rest/api/3/user/search?query=${encodeURIComponent(altEmail)}`);
    console.log(`[jira] findUserByEmail alt status: ${res2.status}`);
    if (res2.ok) {
      const users2 = await res2.json();
      console.log(`[jira] findUserByEmail found ${Array.isArray(users2) ? users2.length : 0} users for ${altEmail}`);
      if (Array.isArray(users2) && users2.length > 0) {
        console.log(`[jira] findUserByEmail accountId=${users2[0].accountId} displayName=${users2[0].displayName}`);
        return users2[0].accountId || null;
      }
    }
  }

  // Last resort: search by local part of email as display name
  const localPart = email.split("@")[0]; // e.g. "jordi.salazar"
  const nameParts = localPart.split(".").map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
  console.log(`[jira] findUserByEmail last resort search by name: ${nameParts}`);
  const res3 = await jiraFetch(`/rest/api/3/user/search?query=${encodeURIComponent(nameParts)}`);
  if (res3.ok) {
    const users3 = await res3.json();
    if (Array.isArray(users3) && users3.length === 1) {
      // Only use if exactly 1 result to avoid ambiguity
      console.log(`[jira] findUserByEmail name match: accountId=${users3[0].accountId} displayName=${users3[0].displayName}`);
      return users3[0].accountId || null;
    } else if (Array.isArray(users3) && users3.length > 1) {
      // Multiple results — try to match by first+last name from local part
      const match = users3.find((u: any) =>
        u.displayName?.toLowerCase().includes(localPart.split(".")[0]) &&
        u.displayName?.toLowerCase().includes(localPart.split(".")[1] || "")
      );
      if (match) {
        console.log(`[jira] findUserByEmail fuzzy name match: accountId=${match.accountId} displayName=${match.displayName}`);
        return match.accountId || null;
      }
    }
  }

  return null;
}

/**
 * Update the reporter of a Jira issue.
 * Requires the "Modify Reporter" permission on the project.
 */
export async function jiraSetReporter(issueKey: string, reporterAccountId: string): Promise<void> {
  console.log(`[jira] setReporter ${issueKey} -> ${reporterAccountId}`);
  const res = await jiraFetch(`/rest/api/3/issue/${issueKey}`, {
    method: "PUT",
    body: JSON.stringify({
      fields: { reporter: { accountId: reporterAccountId } },
    }),
  });
  console.log(`[jira] setReporter ${issueKey} status: ${res.status}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[jira] setReporter FAILED for ${issueKey}: ${res.status} ${text.slice(0, 300)}`);
  } else {
    console.log(`[jira] setReporter SUCCESS for ${issueKey}`);
  }
}

/**
 * Set the reporter of a Jira issue by email (convenience wrapper).
 * Non-blocking: logs errors but doesn't throw.
 */
export async function jiraSetReporterByEmail(issueKey: string, email: string): Promise<void> {
  console.log(`[jira] setReporterByEmail ${issueKey} -> ${email}`);
  try {
    const accountId = await jiraFindUserByEmail(email);
    if (accountId) {
      await jiraSetReporter(issueKey, accountId);
    } else {
      console.warn(`[jira] User NOT FOUND for email ${email}, reporter NOT changed for ${issueKey}`);
    }
  } catch (err) {
    console.error(`[jira] setReporterByEmail FAILED for ${issueKey}:`, err);
  }
}
