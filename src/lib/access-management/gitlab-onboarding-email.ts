/**
 * GitLab onboarding email templates.
 *
 * Two variants:
 * - Internal users (@iskaypet.com, @emefinpetcare.com): Already have Office account,
 *   just need to register in GitLab and configure MFA.
 * - External users (any other domain, or "ext" in email): Need to accept Office
 *   collaboration invite first, then register in GitLab and configure MFA.
 */

const GITLAB_INSTANCE_URL = "https://gitlab.com/iskaypetcom";
const SUPPORT_EMAIL = "portal@tooling.dp.iskaypet.com";

/**
 * Determine if an email belongs to an external user.
 * External users have "ext" in their email or use a non-iskaypet domain.
 */
function isExternalUser(email: string): boolean {
  const lower = email.toLowerCase();
  if (lower.includes("ext")) return true;
  if (lower.endsWith("@iskaypet.com")) return false;
  if (lower.endsWith("@emefinpetcare.com")) return false;
  return true;
}

export function buildGitLabOnboardingEmail(params: {
  targetEmail: string;
  groupName: string;
  roleName: string;
}): { subject: string; bodyHtml: string; bodyText: string } {
  const { targetEmail, groupName, roleName } = params;
  const isExternal = isExternalUser(targetEmail);

  const subject = `[GitLab] Acceso concedido - ${groupName}`;

  if (isExternal) {
    return buildExternalEmail(targetEmail, groupName, roleName);
  }
  return buildInternalEmail(targetEmail, groupName, roleName);
}

function buildInternalEmail(
  targetEmail: string, groupName: string, roleName: string
): { subject: string; bodyHtml: string; bodyText: string } {
  const subject = `[GitLab] Acceso concedido - ${groupName}`;

  const bodyText = [
    `Hola,`,
    "",
    `Se te ha concedido acceso al grupo "${groupName}" en GitLab con el rol "${roleName}".`,
    "",
    "=== Pasos para acceder ===",
    "",
    "1. Registro en GitLab:",
    "   - Si no tienes cuenta en GitLab, regístrate con tu cuenta de correo corporativa.",
    `   - URL: ${GITLAB_INSTANCE_URL}`,
    "",
    "2. Acceso:",
    `   - Accede a: ${GITLAB_INSTANCE_URL}`,
    "   - Se te solicitará que configures MFA (autenticación multifactor).",
    "   - Usa tu cuenta de correo corporativa para iniciar sesión.",
    "",
    "=== Soporte ===",
    `Si tienes problemas, contacta con: ${SUPPORT_EMAIL}`,
    "",
    "Saludos,",
    "Platform Engineering - IskayPet",
  ].join("\n");

  const bodyHtml = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a1a;">
  <div style="border-bottom:3px solid #fc6d26;padding-bottom:16px;margin-bottom:24px;">
    <h2 style="margin:0;color:#fc6d26;">🦊 Acceso a GitLab</h2>
  </div>

  <p>Hola,</p>
  <p>Se te ha concedido acceso al grupo <strong>"${groupName}"</strong> en GitLab con el rol <strong>"${roleName}"</strong>.</p>

  <h3 style="color:#333;margin-top:24px;">📋 Pasos para acceder</h3>

  <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
    <tr>
      <td style="padding:12px;background:#f8f9fa;border-radius:8px;">
        <strong>1. Registro en GitLab</strong><br>
        <ul style="margin:8px 0;padding-left:20px;">
          <li>Si no tienes cuenta en GitLab, regístrate con tu cuenta de correo corporativa.</li>
          <li>URL: <a href="${GITLAB_INSTANCE_URL}" style="color:#fc6d26;">${GITLAB_INSTANCE_URL}</a></li>
        </ul>
      </td>
    </tr>
    <tr><td style="padding:4px;"></td></tr>
    <tr>
      <td style="padding:12px;background:#fff3cd;border:1px solid #ffc107;border-radius:8px;">
        <strong>2. Acceso y MFA</strong><br>
        <ul style="margin:8px 0;padding-left:20px;">
          <li>Accede a <a href="${GITLAB_INSTANCE_URL}" style="color:#fc6d26;">${GITLAB_INSTANCE_URL}</a></li>
          <li>Se te solicitará que configures <strong>MFA</strong> (autenticación multifactor).</li>
          <li>Usa tu cuenta de correo corporativa para iniciar sesión.</li>
        </ul>
      </td>
    </tr>
  </table>

  <h3 style="color:#333;">🆘 Soporte</h3>
  <p>Si tienes problemas para acceder, contacta con: <a href="mailto:${SUPPORT_EMAIL}" style="color:#fc6d26;">${SUPPORT_EMAIL}</a></p>

  <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
  <p style="font-size:12px;color:#6b7280;text-align:center;">Este email fue enviado automáticamente por Platform Portal — IskayPet.</p>
</body></html>`;

  return { subject, bodyHtml, bodyText };
}

function buildExternalEmail(
  targetEmail: string, groupName: string, roleName: string
): { subject: string; bodyHtml: string; bodyText: string } {
  const subject = `[GitLab] Acceso concedido - ${groupName}`;

  const bodyText = [
    `Hola,`,
    "",
    `Se te ha concedido acceso al grupo "${groupName}" en GitLab con el rol "${roleName}".`,
    "",
    "A continuación te detallamos todo el proceso para que puedas acceder a GitLab.",
    "",
    "=== Cuenta de Invitado ===",
    "1. Añadiremos tu cuenta como invitado a Office de Iskaypet.",
    "2. Tendrás que aceptar la invitación y registrarte.",
    "",
    "=== Registro en GitLab ===",
    "1. Debes tener cuenta en GitLab.",
    "2. Si no tienes cuenta, deberás realizar el registro con tu cuenta de correo.",
    "",
    "=== Acceso a GitLab ===",
    `1. Tras registrarte, accede a: ${GITLAB_INSTANCE_URL}`,
    "2. Se te solicitará que configures MFA (autenticación multifactor).",
    "3. Para el acceso, utiliza tu cuenta de correo y las credenciales que asignaste al aceptar la invitación.",
    "",
    "=== Soporte ===",
    `Si tienes problemas, contacta con: ${SUPPORT_EMAIL}`,
    "",
    "Saludos,",
    "Platform Engineering - IskayPet",
  ].join("\n");

  const bodyHtml = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a1a;">
  <div style="border-bottom:3px solid #fc6d26;padding-bottom:16px;margin-bottom:24px;">
    <h2 style="margin:0;color:#fc6d26;">🦊 Acceso a GitLab</h2>
  </div>

  <p>Hola,</p>
  <p>Se te ha concedido acceso al grupo <strong>"${groupName}"</strong> en GitLab con el rol <strong>"${roleName}"</strong>.</p>
  <p>A continuación te detallamos todo el proceso para que puedas acceder a GitLab.</p>

  <h3 style="color:#333;margin-top:24px;">👤 Cuenta de Invitado</h3>
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
    <tr>
      <td style="padding:12px;background:#e8f4fd;border:1px solid #bee5eb;border-radius:8px;">
        <ol style="margin:0;padding-left:20px;">
          <li>Añadiremos tu cuenta como invitado a Office de Iskaypet.</li>
          <li>Tendrás que <strong>aceptar la invitación</strong> y registrarte.</li>
        </ol>
      </td>
    </tr>
  </table>

  <h3 style="color:#333;">📝 Registro en GitLab</h3>
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
    <tr>
      <td style="padding:12px;background:#f8f9fa;border-radius:8px;">
        <ol style="margin:0;padding-left:20px;">
          <li>Debes tener cuenta en GitLab.</li>
          <li>Si no tienes cuenta, deberás realizar el registro con tu cuenta de correo.</li>
        </ol>
      </td>
    </tr>
  </table>

  <h3 style="color:#333;">🔐 Acceso a GitLab</h3>
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
    <tr>
      <td style="padding:12px;background:#fff3cd;border:1px solid #ffc107;border-radius:8px;">
        <ol style="margin:0;padding-left:20px;">
          <li>Tras registrarte, accede a: <a href="${GITLAB_INSTANCE_URL}" style="color:#fc6d26;">${GITLAB_INSTANCE_URL}</a></li>
          <li>Se te solicitará que configures <strong>MFA</strong> (autenticación multifactor).</li>
          <li>Para el acceso, utiliza tu cuenta de correo y las credenciales que asignaste al aceptar la invitación.</li>
        </ol>
      </td>
    </tr>
  </table>

  <h3 style="color:#333;">🆘 Soporte</h3>
  <p>Si tienes problemas para acceder, contacta con: <a href="mailto:${SUPPORT_EMAIL}" style="color:#fc6d26;">${SUPPORT_EMAIL}</a></p>

  <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
  <p style="font-size:12px;color:#6b7280;text-align:center;">Este email fue enviado automáticamente por Platform Portal — IskayPet.</p>
</body></html>`;

  return { subject, bodyHtml, bodyText };
}
