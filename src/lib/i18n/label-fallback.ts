/**
 * Pure label-fallback helpers for the session-nav-hardening feature (Frente B).
 *
 * The i18n provider (`src/lib/i18n.tsx`) only keeps the ACTIVE locale in memory
 * (lazy load) and `t(key, fallback)` returns `translations[key] || fallback || key`
 * — it does NOT fall back to Spanish. R7.6 requires the "volver" label to fall
 * back to the Spanish value when the active locale lacks it, so the decision is
 * formalised here as a total, testable pure resolver with no React nor `node:*`
 * dependencies (importable from client, middleware edge and tests alike).
 */

/** true iff `value` is a string with at least one non-whitespace character. */
export function hasVisibleText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Shared "volver" label — canonical source of the Spanish fallback (es.json). */
export const ES_BACK_LABEL = "Volver";

/**
 * Total resolution of a translated label:
 *   - active locale value with visible text  -> active value
 *   - otherwise Spanish value with visible text -> Spanish value (R7.6)
 *   - otherwise                               -> the key
 *
 * Never returns an empty or whitespace-only string when a visible alternative
 * exists.
 */
export function resolveLabelWithSpanishFallback(
  activeValue: unknown,
  spanishValue: unknown,
  key: string,
): string {
  if (hasVisibleText(activeValue)) return activeValue as string;
  if (hasVisibleText(spanishValue)) return spanishValue as string;
  return key;
}
