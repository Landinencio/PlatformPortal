/**
 * Deduplicación temporal del flujo de re-login (single-flight).
 *
 * Módulo puro, sin dependencias de React ni de `node:*`, importable desde el
 * cliente, el interceptor HTTP y el orquestador de re-login. Formaliza la
 * ventana de 5000 ms durante la cual, con independencia del origen del disparo
 * (Guardia_Sesion o Interceptor_HTTP) o de la concurrencia, el re-login se
 * dispara una única vez.
 *
 * Requirements: 2.6, 4.7
 */

/** Ventana de deduplicación del re-login, en milisegundos. */
export const RELOGIN_DEDUPE_MS = 5000;

export interface ReloginState {
  /** epoch ms del último disparo, o null si nunca. */
  lastTriggeredAt: number | null;
}

/**
 * true sii no hay disparo previo o el previo es de hace >= 5000 ms.
 *
 * Entradas anómalas (lastTriggeredAt no finito) se tratan como "sin disparo
 * previo" para no bloquear indefinidamente el re-login.
 */
export function shouldTriggerRelogin(state: ReloginState, now: number): boolean {
  const last = state.lastTriggeredAt;
  if (last === null || !Number.isFinite(last)) {
    return true;
  }
  return now - last >= RELOGIN_DEDUPE_MS;
}

/** Nuevo estado tras un disparo (inmutable: no muta `state`). */
export function markTriggered(state: ReloginState, now: number): ReloginState {
  return { ...state, lastTriggeredAt: now };
}
