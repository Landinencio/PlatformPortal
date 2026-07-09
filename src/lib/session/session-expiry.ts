/**
 * Pure session-expiry helpers for the session-nav-hardening feature (Frente A).
 *
 * All the decidable logic around detecting that the NextAuth session is about to
 * expire (or already expired) lives here as total, testable pure functions with
 * no React nor `node:*` dependencies, so it is importable from the client
 * `Guardia_Sesion`, from tests and from anywhere else without pulling runtime deps.
 *
 * `session.expires` is an ISO-8601 string (see `SessionShape` in the design).
 * Any invalid / missing value is treated as "already expired" (msUntilExpiry -> 0),
 * degrading safely towards prompting a re-login rather than trusting a dead session.
 */

/** Umbral_Aviso: window (ms) before expiry during which the warning is shown. */
export const WARNING_THRESHOLD_MS = 120_000;

/**
 * Milliseconds until the session expires.
 *
 * Returns `expiryEpochMs - now` when `expiresIso` parses to a valid instant.
 * For a `null`/`undefined`/non-string value or an unparseable date (NaN),
 * returns `0` (treated as expired). Never returns NaN.
 */
export function msUntilExpiry(
  expiresIso: string | null | undefined,
  now: number,
): number {
  if (typeof expiresIso !== "string") return 0;
  const expiryEpochMs = Date.parse(expiresIso);
  if (Number.isNaN(expiryEpochMs)) return 0;
  return expiryEpochMs - now;
}

/** true iff the time until expiry is within `(0, WARNING_THRESHOLD_MS]`. */
export function shouldWarn(
  expiresIso: string | null | undefined,
  now: number,
): boolean {
  const remaining = msUntilExpiry(expiresIso, now);
  return remaining > 0 && remaining <= WARNING_THRESHOLD_MS;
}

/** true iff the session is expired (msUntilExpiry <= 0), incl. invalid input. */
export function isExpired(
  expiresIso: string | null | undefined,
  now: number,
): boolean {
  return msUntilExpiry(expiresIso, now) <= 0;
}

/**
 * Seconds remaining until expiry, rounded up (`Math.ceil`), never negative.
 * Invalid input or an already-expired session yields `0`.
 */
export function secondsRemaining(
  expiresIso: string | null | undefined,
  now: number,
): number {
  const remaining = msUntilExpiry(expiresIso, now);
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / 1000);
}
