/**
 * Helper functions for the access-management execute route.
 * Extracted for testability with property-based tests.
 */

export interface AccessRequestRow {
  id: number;
  requestor_email: string;
  target_user_email: string;
  platform: string;
  request_type: string;
  group_id: string | null;
  group_name: string | null;
  role: string | null;
  approver_email: string;
  status: string;
  reviewer_email: string | null;
  reviewer_name: string | null;
  executed_at: string | null;
  business_team?: string | null;
}

/**
 * Build Jira issue content for an executed access request.
 *
 * Property 8: Jira issue content completeness
 * - Summary: `[Access] Solicitud de acceso a {PLATFORM} para {target_user_email}`
 * - Description: platform, target user, group/role, requestor, approver, timestamp
 * - Labels: ["AccessRequest"]
 */
export function buildJiraContent(request: AccessRequestRow): {
  summary: string;
  description: string;
  labels: string[];
} {
  const platform = request.platform.toUpperCase();
  const summary = `[Access] Solicitud de acceso a ${platform} para ${request.target_user_email}`;

  const executionTimestamp = request.executed_at || new Date().toISOString();
  const groupOrRole = request.group_name || request.role || "N/A";

  const description = [
    `Plataforma: ${platform}`,
    `Usuario destino: ${request.target_user_email}`,
    `Grupo/Rol: ${groupOrRole}`,
    `Solicitante: ${request.requestor_email}`,
    `Aprobador: ${request.approver_email}`,
    `Fecha de ejecución: ${executionTimestamp}`,
  ].join("\n");

  return {
    summary,
    description,
    labels: ["AccessRequest"],
  };
}

/**
 * Build Teams adaptive card for an executed access request.
 *
 * Property 9: Teams card content completeness
 * - Title: "🔐 Solicitud de Acceso"
 * - Platform name
 * - Target user email
 * - Group or role name
 * - Status: "✅ Acceso Concedido"
 * - Link to Jira ticket
 */
export function buildTeamsCard(
  request: AccessRequestRow,
  jiraKey: string,
  jiraUrl: string
): Record<string, unknown> {
  const platform = request.platform.toUpperCase();
  const groupOrRole = request.group_name || request.role || "N/A";

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          msteams: { width: "Full" },
          body: [
            {
              type: "Container",
              items: [
                {
                  type: "TextBlock",
                  text: "🔐 Solicitud de Acceso",
                  weight: "Bolder",
                  size: "Medium",
                  color: "Accent",
                },
                {
                  type: "TextBlock",
                  text: platform,
                  weight: "Bolder",
                  size: "ExtraLarge",
                  spacing: "None",
                },
                {
                  type: "FactSet",
                  facts: [
                    { title: "Solicitante:", value: request.target_user_email },
                    { title: "Grupo Asignado:", value: groupOrRole },
                    { title: "Estado:", value: "✅ Acceso Concedido" },
                    {
                      title: "Jira:",
                      value: `[${jiraKey}](${jiraUrl})`,
                    },
                  ],
                },
              ],
            },
          ],
          actions: [
            {
              type: "Action.OpenUrl",
              title: "Ver Ticket en Jira",
              url: jiraUrl,
            },
          ],
        },
      },
    ],
  };
}
