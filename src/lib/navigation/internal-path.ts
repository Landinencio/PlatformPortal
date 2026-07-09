/**
 * session-nav-hardening — Validación y saneamiento de rutas internas.
 *
 * Feature: session-nav-hardening
 *
 * Fuente ÚNICA de verdad (anti open-redirect) compartida por:
 *  - el `middleware.ts` (edge runtime) al construir el parámetro `?next=`,
 *  - el flujo de re-login al calcular el `callbackUrl`,
 *  - el `BotonVolver` al resolver su destino.
 *
 * Lógica pura y determinista, sin dependencias de React ni de Node runtime.
 * Usa exclusivamente `String`/regex (sin `node:*`, sin `Buffer`), por lo que es
 * importable desde el edge runtime del middleware.
 *
 * _Requirements: 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 5.8_
 */

/** Longitud máxima admitida para una ruta interna (sobre la ruta cruda, sin encode). */
export const MAX_INTERNAL_PATH_LENGTH = 2048;

/**
 * Validación TOTAL de ruta interna. Nunca lanza; para CUALQUIER entrada
 * (string, `null`, `undefined` o valor no-string) devuelve un booleano.
 *
 * Válida si y solo si: es `string`, longitud 1..2048, empieza por un único `/`
 * (no empieza por `//` ni por `/\`), no contiene `://` y no contiene los
 * caracteres de control `\r`, `\n` o `\t`.
 */
export function isInternalPath(candidate: unknown): boolean {
  if (typeof candidate !== "string") return false;
  if (candidate.length < 1 || candidate.length > MAX_INTERNAL_PATH_LENGTH) return false;
  // Debe empezar por un único "/": arranca con "/" pero no con "//" ni "/\".
  if (candidate.charCodeAt(0) !== 47 /* "/" */) return false;
  if (candidate.startsWith("//")) return false;
  if (candidate.startsWith("/\\")) return false;
  if (candidate.includes("://")) return false;
  if (candidate.includes("\r") || candidate.includes("\n") || candidate.includes("\t")) return false;
  return true;
}

/** Devuelve la ruta si es interna válida, o `"/"` en cualquier otro caso. */
export function sanitizeInternalPath(candidate: unknown): string {
  return isInternalPath(candidate) ? (candidate as string) : "/";
}

/**
 * pathname (+ search) → cadena de Ruta_Previa cruda (sin encode).
 *
 * Concatena `pathname` con `search`, anteponiendo `?` únicamente cuando `search`
 * es no vacío y no comienza ya por `?`. Determinista, sin estado externo.
 */
export function capturePreviousRoute(pathname: string, search?: string): string {
  if (!search) return pathname;
  if (search.startsWith("?")) return pathname + search;
  return pathname + "?" + search;
}

/**
 * Valor listo para `?next=`: `encodeURIComponent(rutaPrevia)` si la ruta cruda
 * es interna válida; en caso contrario `""` (el llamador omite el parámetro).
 *
 * El tope de 2048 se aplica sobre la ruta CRUDA (antes de codificar) vía
 * `isInternalPath`, de modo que el resultado siempre respeta ese límite.
 */
export function buildNextParam(pathname: string, search?: string): string {
  const raw = capturePreviousRoute(pathname, search);
  if (!isInternalPath(raw)) return "";
  return encodeURIComponent(raw);
}

/**
 * Decodifica y valida un `?next=` recibido → ruta interna válida o `"/"`.
 *
 * Entradas vacías, no-string o cuya decodificación falle (percent-encoding
 * malformado) degradan de forma segura a `"/"`, nunca a un host externo.
 */
export function resolveNextParam(rawNext: unknown): string {
  if (typeof rawNext !== "string" || rawNext.length === 0) return "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawNext);
  } catch {
    return "/";
  }
  return sanitizeInternalPath(decoded);
}
