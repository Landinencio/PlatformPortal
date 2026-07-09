import { SESClient, SendEmailCommand, SendRawEmailCommand } from "@aws-sdk/client-ses";

const SES_REGION = "eu-west-1";
const FROM_EMAIL = "portal@tooling.dp.iskaypet.com";
const FROM_NAME = "Platform Portal";

const ses = new SESClient({ region: SES_REGION });

export interface SendEmailInput {
  to: string[];
  subject: string;
  bodyHtml: string;
  bodyText?: string;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendEmailWithAttachmentsInput extends SendEmailInput {
  attachments: EmailAttachment[];
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const command = new SendEmailCommand({
    Source: `${FROM_NAME} <${FROM_EMAIL}>`,
    Destination: { ToAddresses: input.to },
    Message: {
      Subject: { Data: input.subject, Charset: "UTF-8" },
      Body: {
        Html: { Data: input.bodyHtml, Charset: "UTF-8" },
        ...(input.bodyText ? { Text: { Data: input.bodyText, Charset: "UTF-8" } } : {}),
      },
    },
  });

  try {
    await ses.send(command);
  } catch (err) {
    console.error("SES send error:", err);
  }
}

/**
 * Send an email with file attachments via SES Raw Email.
 * Used for onboarding emails that include PDF guides.
 */
export async function sendEmailWithAttachments(input: SendEmailWithAttachmentsInput): Promise<void> {
  const boundary = `----=_Part_${Date.now()}`;
  const toHeader = input.to.join(", ");

  let rawMessage = [
    `From: ${FROM_NAME} <${FROM_EMAIL}>`,
    `To: ${toHeader}`,
    `Subject: ${input.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${boundary}_alt"`,
    ``,
    `--${boundary}_alt`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    input.bodyText || "",
    ``,
    `--${boundary}_alt`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    input.bodyHtml,
    ``,
    `--${boundary}_alt--`,
  ].join("\r\n");

  // Add attachments
  for (const attachment of input.attachments) {
    rawMessage += [
      ``,
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      attachment.content.toString("base64"),
    ].join("\r\n");
  }

  rawMessage += `\r\n--${boundary}--`;

  const command = new SendRawEmailCommand({
    RawMessage: { Data: Buffer.from(rawMessage) },
  });

  try {
    await ses.send(command);
  } catch (err) {
    console.error("SES raw send error:", err);
  }
}

/** Build an approval request email */
export function buildApprovalRequestEmail(params: {
  resourceType: string;
  resourceName: string;
  team: string;
  requestorName: string;
  requestorEmail: string;
  portalUrl: string;
  estimatedCost?: number;
  costBreakdown?: string;
  costSpecs?: string;
  costDetails?: string;
  costBillingWarning?: string | null;
  costRecommendation?: string | null;
  environments?: string[];
}): { subject: string; bodyHtml: string; bodyText: string } {
  const { resourceType, resourceName, team, requestorName, requestorEmail, portalUrl, estimatedCost, costBreakdown, costSpecs, costDetails, costBillingWarning, costRecommendation, environments } = params;
  const typeLabel = resourceType.toUpperCase();
  const costLine = estimatedCost && estimatedCost > 0 ? ` (~$${estimatedCost}/mes)` : "";
  const envList = environments?.join(", ") || "N/A";

  const subject = `[Portal] Nueva solicitud de ${typeLabel}: ${resourceName}${costLine}`;

  const bodyText = `${requestorName} (${requestorEmail}) solicita crear ${typeLabel} "${resourceName}" para el equipo ${team}. Entornos: ${envList}.${costSpecs ? ` Specs: ${costSpecs}.` : ""}${costBreakdown ? ` Coste: ${costBreakdown}` : ""}${costBillingWarning ? ` ${costBillingWarning}` : ""}\n\nRevisa y aprueba en: ${portalUrl}/infra-requests`;

  const costRow = estimatedCost && estimatedCost > 0
    ? `<tr><td style="padding:8px 12px;background:#f8f9fa;font-weight:600;">Coste estimado</td><td style="padding:8px 12px;font-weight:700;color:#16a34a;">~$${estimatedCost}/mes</td></tr>`
    : "";
  const specsRow = costSpecs
    ? `<tr><td style="padding:8px 12px;background:#f8f9fa;font-weight:600;">Specs</td><td style="padding:8px 12px;font-family:monospace;font-size:12px;">${costSpecs}</td></tr>`
    : "";
  const envsRow = `<tr><td style="padding:8px 12px;background:#f8f9fa;font-weight:600;">Entornos</td><td style="padding:8px 12px;">${envList}</td></tr>`;
  const breakdownRow = costBreakdown
    ? `<tr><td style="padding:8px 12px;background:#f8f9fa;font-weight:600;">Desglose</td><td style="padding:8px 12px;">${costBreakdown}</td></tr>`
    : "";
  const detailsRow = costDetails
    ? `<tr><td style="padding:8px 12px;background:#f8f9fa;font-weight:600;">Detalles</td><td style="padding:8px 12px;font-size:12px;">${costDetails}</td></tr>`
    : "";
  const warningBlock = costBillingWarning
    ? `<div style="margin:16px 0;padding:12px;background:#fef2f2;border:1px solid #ef4444;border-radius:8px;font-size:13px;color:#991b1b;">${costBillingWarning}</div>`
    : "";
  const recoBlock = costRecommendation
    ? `<div style="margin:16px 0;padding:12px;background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;font-size:13px;">💡 ${costRecommendation}</div>`
    : "";

  const bodyHtml = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a1a;">
  <div style="border-bottom:3px solid #6366f1;padding-bottom:16px;margin-bottom:24px;">
    <h2 style="margin:0;color:#6366f1;">🚀 Solicitud de Infraestructura</h2>
  </div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
    <tr><td style="padding:8px 12px;background:#f8f9fa;font-weight:600;width:140px;">Recurso</td><td style="padding:8px 12px;">${typeLabel} — ${resourceName}</td></tr>
    <tr><td style="padding:8px 12px;background:#f8f9fa;font-weight:600;">Equipo</td><td style="padding:8px 12px;">${team}</td></tr>
    <tr><td style="padding:8px 12px;background:#f8f9fa;font-weight:600;">Solicitante</td><td style="padding:8px 12px;">${requestorName} (${requestorEmail})</td></tr>
    ${envsRow}
    ${specsRow}
    ${costRow}
    ${breakdownRow}
    ${detailsRow}
  </table>
  ${warningBlock}
  ${recoBlock}
  <div style="text-align:center;margin:32px 0;">
    <a href="${portalUrl}/infra-requests" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:600;font-size:14px;">Revisar solicitud</a>
  </div>
  <p style="font-size:12px;color:#6b7280;text-align:center;">Este email fue enviado automáticamente por Platform Portal.</p>
</body></html>`;

  return { subject, bodyHtml, bodyText };
}

/** Build an approval result email for the requestor */
export function buildApprovalResultEmail(params: {
  approved: boolean;
  resourceType: string;
  resourceName: string;
  reviewerName: string;
  comment?: string;
  portalUrl: string;
}): { subject: string; bodyHtml: string; bodyText: string } {
  const { approved, resourceType, resourceName, reviewerName, comment, portalUrl } = params;
  const typeLabel = resourceType.toUpperCase();
  const status = approved ? "Aprobada ✅" : "Rechazada ❌";
  const color = approved ? "#16a34a" : "#dc2626";

  const subject = `[Portal] Solicitud ${approved ? "aprobada" : "rechazada"}: ${typeLabel} ${resourceName}`;

  const bodyText = `Tu solicitud de ${typeLabel} "${resourceName}" ha sido ${approved ? "aprobada" : "rechazada"} por ${reviewerName}.${comment ? ` Motivo: ${comment}` : ""}`;

  const bodyHtml = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a1a;">
  <div style="border-bottom:3px solid ${color};padding-bottom:16px;margin-bottom:24px;">
    <h2 style="margin:0;color:${color};">${status}</h2>
  </div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
    <tr><td style="padding:8px 12px;background:#f8f9fa;font-weight:600;width:140px;">Recurso</td><td style="padding:8px 12px;">${typeLabel} — ${resourceName}</td></tr>
    <tr><td style="padding:8px 12px;background:#f8f9fa;font-weight:600;">Revisado por</td><td style="padding:8px 12px;">${reviewerName}</td></tr>
    ${comment ? `<tr><td style="padding:8px 12px;background:#f8f9fa;font-weight:600;">Comentario</td><td style="padding:8px 12px;">${comment}</td></tr>` : ""}
  </table>
  ${approved ? `<p style="color:#16a34a;font-weight:600;">El recurso se está creando automáticamente.</p>` : ""}
  <div style="text-align:center;margin:32px 0;">
    <a href="${portalUrl}/infra-requests" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:600;font-size:14px;">Ver en el portal</a>
  </div>
  <p style="font-size:12px;color:#6b7280;text-align:center;">Este email fue enviado automáticamente por Platform Portal.</p>
</body></html>`;

  return { subject, bodyHtml, bodyText };
}
