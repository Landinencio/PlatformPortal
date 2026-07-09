import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import { jiraCreateIssue, jiraSetReporterByEmail, jiraAddAttachments } from "@/lib/jira";

const TEAMS_WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL || "";

/**
 * POST /api/metrics/feedback
 * Receives user feedback about metrics and creates a Jira ticket + Teams message.
 * Supports both JSON and FormData (for file uploads).
 */
export async function POST(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const email = auth.session.user?.email || "";
  const name = auth.session.user?.name || email;

  let message: string;
  let category: string;
  let files: Array<{ filename: string; buffer: Buffer; mimeType: string }> = [];

  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    message = (formData.get("message") as string) || "";
    category = (formData.get("category") as string) || "general";
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
    message = body.message || "";
    category = body.category || "general";
  }

  if (!message || message.trim().length < 5) {
    return NextResponse.json({ error: "El mensaje debe tener al menos 5 caracteres" }, { status: 400 });
  }

  const categoryLabel = category;

  // 1. Create Jira ticket
  try {
    const jiraDescription = [
      `h2. Feedback sobre Métricas`,
      ``,
      `||Campo||Valor||`,
      `|De|${name} (${email})|`,
      `|Categoría|${categoryLabel}|`,
      ``,
      `h3. Mensaje`,
      message.trim(),
      ``,
      `_Creado automáticamente desde el Portal de Plataforma._`,
    ].join("\n");

    const jiraResult = await jiraCreateIssue({
      projectKey: "SRE",
      issueTypeId: "10048",
      summary: `[Métricas] Feedback — ${categoryLabel}`,
      description: jiraDescription,
      labels: ["SRE", "portal", "metrics-feedback"],
      reporterEmail: email,
    });

    // Upload attachments if any
    if (files.length > 0) {
      try {
        await jiraAddAttachments(jiraResult.key, files);
      } catch (attachErr) {
        console.error("[metrics/feedback] Attachment upload failed:", attachErr);
      }
    }
  } catch (err) {
    console.error("[metrics/feedback] Jira creation failed:", err);
  }

  // 2. Send Teams notification
  if (TEAMS_WEBHOOK_URL) {
    try {
      await fetch(TEAMS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "message",
          attachments: [{
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
              type: "AdaptiveCard",
              version: "1.4",
              body: [
                { type: "TextBlock", text: "💬 Feedback sobre Métricas", weight: "Bolder", size: "Medium" },
                { type: "FactSet", facts: [
                  { title: "De", value: `${name} (${email})` },
                  { title: "Categoría", value: categoryLabel },
                ]},
                { type: "TextBlock", text: message.trim(), wrap: true },
              ],
            },
          }],
        }),
      });
    } catch (err) {
      console.error("[metrics/feedback] Teams webhook failed:", err);
    }
  }

  return NextResponse.json({ success: true });
}
