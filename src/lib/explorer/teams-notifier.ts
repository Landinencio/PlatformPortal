/**
 * AI Portal Explorer — Teams_Notifier.
 *
 * Feature: ai-portal-explorer
 *
 * Publica en un canal de Teams (webhook SRE, `TEAMS_WEBHOOK_URL`) un resumen del
 * Exploration_Run cuando este finaliza: número de Anomalies por Severity, nº de
 * RBAC_Findings, Routes visitadas y un enlace/referencia al Report.
 *
 * Reutiliza `buildDigestCard`/`sendTeamsCard` de `src/lib/teams-notify.ts` (mismo
 * formato de Adaptive Card que el resto del portal).
 *
 * Contrato de no-lanzamiento (Req 7.6): la publicación es best-effort. Si el envío
 * falla (o no hay webhook configurado), el notificador NO lanza — registra el
 * fallo y devuelve un `{ sent, reason }`. El orquestador conserva el Report ya
 * persistido y continúa.
 *
 * _Requirements: 7.5, 7.6_
 */

import { buildDigestCard, sendTeamsCard } from "@/lib/teams-notify";
import type { DigestFact } from "@/lib/teams-notify";
import { SEVERITY_ORDER } from "./types";
import type { Severity } from "./types";
import type { Report } from "./reporter";

/** Etiqueta legible por Severity para los facts de la card. */
const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Críticas",
  high: "Altas",
  medium: "Medias",
  low: "Bajas",
  info: "Informativas",
};

/**
 * Construye la Adaptive Card de resumen del Exploration_Run para Teams.
 *
 * Incluye:
 * - Título con el identificador del run y su estado.
 * - Resumen markdown con el total de anomalías y las Routes visitadas.
 * - FactSet con el desglose de Anomalies por Severity (en orden canónico) y el
 *   número de RBAC_Findings.
 * - Botón de acción que enlaza al Report (Req 7.5).
 *
 * Función pura: para el mismo Report y reportUrl produce siempre la misma card.
 *
 * _Requirements: 7.5_
 */
export function buildExplorerTeamsCard(
  report: Report,
  reportUrl: string,
): Record<string, unknown> {
  const { run, summary } = report;

  const totalAnomalies = SEVERITY_ORDER.reduce(
    (acc, severity) => acc + summary.anomaliesBySeverity[severity],
    0,
  );

  const facts: DigestFact[] = [
    { name: "Estado", value: run.status },
    { name: "Routes visitadas", value: String(summary.routesVisited) },
    { name: "Anomalías totales", value: String(totalAnomalies) },
  ];

  for (const severity of SEVERITY_ORDER) {
    facts.push({
      name: SEVERITY_LABEL[severity],
      value: String(summary.anomaliesBySeverity[severity]),
    });
  }

  facts.push({ name: "RBAC findings", value: String(summary.rbacFindings) });

  const rolesCovered = run.rolesCovered.join(", ") || "—";
  const markdownSummary =
    `Barrido del Platform Portal (\`${run.baseUrl}\`) finalizado con estado **${run.status}**. ` +
    `Se detectaron **${totalAnomalies}** anomalía(s) en **${summary.routesVisited}** ruta(s) ` +
    `bajo los roles: ${rolesCovered}.`;

  return buildDigestCard({
    title: `🔎 AI Portal Explorer — run ${run.runId}`,
    markdownSummary,
    facts,
    linkUrl: reportUrl,
    linkLabel: "Ver Report del Explorer",
  });
}

export type ExplorerNotifyReason = "no-webhook" | "send-failed" | "sent";

export interface ExplorerNotifyResult {
  sent: boolean;
  reason: ExplorerNotifyReason;
}

export interface ExplorerNotifyDeps {
  /** Builder de la card (default: buildExplorerTeamsCard). */
  buildCard: (report: Report, reportUrl: string) => Record<string, unknown>;
  /** Emisor del webhook (default: sendTeamsCard de teams-notify.ts). */
  sendCard: (
    card: Record<string, unknown>,
    webhookUrl: string | undefined,
  ) => Promise<boolean>;
  /** Webhook de Teams (default: process.env.TEAMS_WEBHOOK_URL — canal SRE). */
  webhookUrl: string | undefined;
}

function resolveDeps(deps?: Partial<ExplorerNotifyDeps>): ExplorerNotifyDeps {
  const d = deps || {};
  return {
    buildCard: d.buildCard || buildExplorerTeamsCard,
    sendCard: d.sendCard || sendTeamsCard,
    // Key-presence (not `!== undefined`) so an explicit override (incl. empty)
    // wins over the ambient env — keeps tests deterministic.
    webhookUrl: "webhookUrl" in d ? d.webhookUrl : process.env.TEAMS_WEBHOOK_URL,
  };
}

/**
 * Publica el resumen del Exploration_Run en Teams. Best-effort: NUNCA lanza
 * (Req 7.6). Devuelve `{ sent, reason }` para logging/tests. Un fallo de envío
 * o la ausencia de webhook NO descartan el Report ya persistido.
 *
 * _Requirements: 7.5, 7.6_
 */
export async function notifyExplorerRun(
  report: Report,
  reportUrl: string,
  deps?: Partial<ExplorerNotifyDeps>,
): Promise<ExplorerNotifyResult> {
  try {
    const d = resolveDeps(deps);

    if (!d.webhookUrl) {
      console.warn(
        "[explorer-teams-notifier] TEAMS_WEBHOOK_URL not configured — skipping Teams notification",
      );
      return { sent: false, reason: "no-webhook" };
    }

    const card = d.buildCard(report, reportUrl);
    const ok = await d.sendCard(card, d.webhookUrl);
    if (!ok) {
      console.error(
        `[explorer-teams-notifier] Teams publish failed for run ${report.run.runId} — Report preserved`,
      );
      return { sent: false, reason: "send-failed" };
    }

    console.log(
      `[explorer-teams-notifier] notified Explorer run ${report.run.runId}`,
    );
    return { sent: true, reason: "sent" };
  } catch (err) {
    // Defensa en profundidad: aunque sendTeamsCard ya no lanza, cualquier error
    // inesperado se traga aquí para honrar el contrato de no-lanzamiento.
    console.error("[explorer-teams-notifier] unexpected error (Report preserved):", err);
    return { sent: false, reason: "send-failed" };
  }
}
