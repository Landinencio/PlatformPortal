/**
 * Domain normalizer for email addresses.
 *
 * Handles the domain migration between @iskaypet.com and @emefinpetcare.com,
 * treating both as equivalent for all email comparisons.
 */

const CANONICAL_DOMAIN = "@iskaypet.com";
const LEGACY_DOMAIN = "@emefinpetcare.com";

/**
 * Normalize an email address:
 * - Lowercase the entire email
 * - Convert @emefinpetcare.com → @iskaypet.com
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().replace(LEGACY_DOMAIN, CANONICAL_DOMAIN);
}

/**
 * Compare two emails with domain normalization.
 * Returns true if both emails resolve to the same canonical form.
 */
export function emailsMatch(a: string, b: string): boolean {
  return normalizeEmail(a) === normalizeEmail(b);
}

/**
 * Get the alternate domain variant of an email for fallback lookup.
 *
 * - @emefinpetcare.com → returns @iskaypet.com variant
 * - @iskaypet.com → returns @emefinpetcare.com variant
 * - Any other domain → returns null
 */
export function getAlternateDomainEmail(email: string): string | null {
  const lower = email.toLowerCase();

  if (lower.endsWith(LEGACY_DOMAIN)) {
    return lower.replace(LEGACY_DOMAIN, CANONICAL_DOMAIN);
  }

  if (lower.endsWith(CANONICAL_DOMAIN)) {
    return lower.replace(CANONICAL_DOMAIN, LEGACY_DOMAIN);
  }

  return null;
}
