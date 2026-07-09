import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import { jiraCreateIssue, jiraAddAttachments, jiraSetReporterByEmail } from "@/lib/jira";
import pool from "@/lib/db";

export async function POST(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const email = auth.session.user?.email || "";
  const name = auth.session.user?.name || email;

  // Support both JSON and FormData (for file uploads)
  const contentType = request.headers.get("content-type") || "";
  let type: string;
  let title: string;
  let description: string;
  let priority: string;
  let businessTeam: string;
  let files: Array<{ filename: string; buffer: Buffer; mimeType: string }> = [];

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    type = formData.get("type") as string || "";
    title = formData.get("title") as string || "";
    description = formData.get("description") as string || "";
    priority = formData.get("priority") as string || "media";
    businessTeam = formData.get("businessTeam") as string || "";

    // Collect uploaded files
    const fileEntries = formData.getAll("attachments");
    for (const entry of fileEntries) {
      if (entry instanceof File && entry.size > 0) {
        const arrayBuffer = await entry.arrayBuffer();
        files.push({
          filename: entry.name,
          buffer: Buffer.from(arrayBuffer),
          mimeType: entry.type || "application/octet-stream",
        });
      }
    }
  } else {
    const body = await request.json();
    type = body.type || "";
    title = body.title || "";
    description = body.description || "";
    priority = body.priority || "media";
    businessTeam = body.businessTeam || "";
  }

  if (!title || !description || !type || !businessTeam) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const isIncident = type === "incident";
  const prefix = isIncident ? "[Incidencia]" : "[Petición]";

  // Map priority to Jira priority name
  const priorityMap: Record<string, string> = { alta: "High", media: "Medium", baja: "Low" };
  const jiraPriority = priorityMap[priority] || "Medium";

  try {
    const jiraDescription = [
      `h2. ${isIncident ? "Incidencia" : "Petición"} — ${title}`,
      ``,
      `||Campo||Valor||`,
      `|Tipo|${isIncident ? "Incidencia" : "Petición"}|`,
      `|Equipo|${businessTeam}|`,
      `|Prioridad|${priority}|`,
      `|Solicitante|${name} (${email})|`,
      ``,
      `h3. Descripción`,
      description,
      files.length > 0 ? `\n_${files.length} archivo(s) adjunto(s)._` : "",
      ``,
      `_Creado automáticamente desde el Portal de Plataforma._`,
    ].join("\n");

    const result = await jiraCreateIssue({
      projectKey: "SRE",
      issueTypeId: "10048",
      summary: `${prefix} ${title} — ${businessTeam}`,
      description: jiraDescription,
      labels: ["SRE", "portal", isIncident ? "incident" : "request", businessTeam],
      priority: jiraPriority,
      reporterEmail: email,
    });

    // Upload attachments to the created ticket (non-blocking)
    if (files.length > 0) {
      try {
        await jiraAddAttachments(result.key, files);
      } catch (attachErr) {
        console.error("[create-ticket] Attachment upload failed (non-blocking):", attachErr);
      }
    }

    // Fallback: if reporter wasn't set during creation, try PUT
    await jiraSetReporterByEmail(result.key, email);

    // Save to portal_tickets for history tracking
    try {
      await pool.query(
        `INSERT INTO portal_tickets (jira_key, type, title, description, priority, business_team, requestor_email, requestor_name, status, has_attachments)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9)`,
        [result.key, type, title, description, priority, businessTeam, email, name, files.length > 0]
      );
    } catch (dbErr) {
      console.error("[create-ticket] DB insert failed (non-blocking):", dbErr);
    }

    return NextResponse.json({ success: true, key: result.key, url: `/tickets` });
  } catch (err) {
    console.error("Jira create-ticket error:", err);
    return NextResponse.json({ error: "Failed to create Jira ticket" }, { status: 500 });
  }
}
