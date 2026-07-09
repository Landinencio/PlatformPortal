// Microsoft Teams notification helper.
//
// Centralises sending an Adaptive Card to an arbitrary Teams incoming webhook.
// The MessageCard/Adaptive Card JSON structure matches the format already used
// across the portal (access-management, squad-infra, metrics feedback, etc.):
//   { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive",
//     content: { $schema, type: "AdaptiveCard", version: "1.4", body: [...], actions: [...] } }] }
//
// NOTE: This helper is consumed by the daily FinOps digest only. The existing
// inline Teams senders in other call-sites are intentionally NOT refactored here.

const TEAMS_POST_TIMEOUT_MS = 10_000; // 10s per webhook POST

export interface DigestFact {
  name: string;
  value: string;
}

export interface BuildDigestCardOptions {
  /** Card title (rendered as the bold header TextBlock). */
  title: string;
  /** Markdown summary body (Adaptive Card TextBlock supports light markdown). */
  markdownSummary: string;
  /** Key/value facts rendered as a FactSet. */
  facts: DigestFact[];
  /** URL the action button links to. */
  linkUrl: string;
  /** Label for the action button (default: "Ver dashboard FinOps"). */
  linkLabel?: string;
}

/**
 * POST an Adaptive Card payload to a Teams incoming webhook.
 *
 * Returns `true` on a 2xx response, `false` otherwise. Never throws — this is
 * part of the digest's graceful-degradation contract (a partial failure must
 * not abort the whole run). An empty/undefined webhook URL logs a warning and
 * returns `false`.
 */
export async function sendTeamsCard(
  card: Record<string, unknown>,
  webhookUrl: string | undefined,
): Promise<boolean> {
  if (!webhookUrl) {
    console.warn("[teams-notify] webhook URL not configured — skipping Teams notification");
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEAMS_POST_TIMEOUT_MS);

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[teams-notify] webhook failed (${res.status}): ${detail}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[teams-notify] webhook error:", err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a Teams Adaptive Card for a digest-style message: a bold title, a
 * markdown summary block, a FactSet of key metrics, and an "open in portal"
 * action linking to the FinOps dashboard.
 *
 * Coherent with the Adaptive Card format used elsewhere in the portal
 * (contentType `application/vnd.microsoft.card.adaptive`, version 1.4,
 * `Action.OpenUrl` for the link button).
 */
export function buildDigestCard(opts: BuildDigestCardOptions): Record<string, unknown> {
  const { title, markdownSummary, facts, linkUrl, linkLabel } = opts;

  const body: Array<Record<string, unknown>> = [
    {
      type: "TextBlock",
      text: title,
      weight: "Bolder",
      size: "Medium",
      color: "Accent",
      wrap: true,
    },
  ];

  if (markdownSummary && markdownSummary.trim().length > 0) {
    body.push({
      type: "TextBlock",
      text: markdownSummary,
      wrap: true,
    });
  }

  if (facts.length > 0) {
    body.push({
      type: "FactSet",
      facts: facts.map((f) => ({ title: f.name, value: f.value })),
    });
  }

  const content: Record<string, unknown> = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    msteams: { width: "Full" },
    body,
  };

  if (linkUrl) {
    content.actions = [
      {
        type: "Action.OpenUrl",
        title: linkLabel || "Ver dashboard FinOps",
        url: linkUrl,
      },
    ];
  }

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content,
      },
    ],
  };
}
