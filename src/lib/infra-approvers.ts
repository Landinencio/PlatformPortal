/**
 * Infrastructure request approvers.
 *
 * SELECTABLE: managers that the developer picks in the form (one of them).
 * ALWAYS_NOTIFIED: architect + director, always receive the notification.
 * All of them can approve or reject any request.
 *
 * Domain migration: @iskaypet.com → @emefinpetcare.com
 * Both domains are accepted for all approvers.
 */

/** Normalize email to handle domain migration (iskaypet ↔ emefinpetcare) */
function normalizeEmail(email: string): string {
  return email.toLowerCase().replace("@emefinpetcare.com", "@iskaypet.com");
}

export const SELECTABLE_APPROVERS = [
  { email: "jaime.palomo@iskaypet.com", name: "Jaime Palomo" },
  { email: "jorge.marcial@iskaypet.com", name: "Jorge Marcial" },
  { email: "santy.prada@iskaypet.com", name: "Santy Prada" },
  { email: "ruben.landin@iskaypet.com", name: "Rubén Landín" },
  { email: "jesus.furio@iskaypet.com", name: "Jesús Furió" },
  // Temporal: Vanessa ocupa el puesto de aprobadora de Ariel (salida) — revisar al reincorporarse el titular.
  { email: "vanessa.lopez@iskaypet.com", name: "Vanessa López" },
];

export const ALWAYS_NOTIFIED = [
  "agustin.medina@iskaypet.com",
  "vanessa.lopez@iskaypet.com",
];

/** All emails that can approve (for permission checks) */
export const ALL_APPROVER_EMAILS = [
  ...SELECTABLE_APPROVERS.map((a) => a.email),
  ...ALWAYS_NOTIFIED,
];

export function isApprover(email: string): boolean {
  const normalized = normalizeEmail(email);
  return ALL_APPROVER_EMAILS.includes(normalized);
}

/** Infra admins — can approve but selecting them does NOT notify architect/director */
const INFRA_ADMINS = [
  "ruben.landin@iskaypet.com",
  "jesus.furio@iskaypet.com",
];

/** Given the selected approver email, return the full list to notify */
export function getNotifyList(selectedApproverEmail: string): string[] {
  const lower = selectedApproverEmail.toLowerCase();
  // If selected approver is an infra admin, only notify them (no architect/director)
  const normalizedLower = normalizeEmail(lower);
  if (INFRA_ADMINS.includes(normalizedLower)) {
    return [lower];
  }
  // Otherwise notify: selected manager + architect + director
  const set = new Set<string>([lower, ...ALWAYS_NOTIFIED]);
  return [...set];
}
