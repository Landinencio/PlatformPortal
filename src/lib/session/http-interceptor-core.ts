/**
 * session-nav-hardening — Núcleo puro del interceptor HTTP.
 *
 * Feature: session-nav-hardening
 *
 * Lógica decidible del Interceptor_HTTP aislada en un módulo puro y determinista,
 * sin dependencias de React ni de Node runtime. Decide (a) qué respuestas de
 * `fetch` deben inspeccionarse (ámbito mismo-origen `/api/*` excluyendo
 * `/api/auth/*`) y (b) cómo clasificar el status HTTP resultante. El componente
 * cliente `HttpInterceptor` aplica los efectos (re-login, toast, passthrough)
 * sobre esta clasificación.
 *
 * Se apoya únicamente en `String`/regex y en el `URL` estándar (disponible en
 * navegador y edge runtime), por lo que no arrastra `node:*` ni `Buffer`.
 *
 * _Requirements: 2.1, 2.2, 2.3, 2.4, 2.7_
 */

/** Acción derivada de una respuesta interceptada de `/api/*`. */
export type InterceptAction = "relogin" | "forbidden" | "passthrough";

/**
 * true si y solo si la URL resuelve al MISMO origen que el Portal, su path
 * empieza por `/api/` y NO empieza por `/api/auth/`. Acepta indistintamente
 * URLs relativas al origen (p.ej. `/api/foo`) o absolutas (`https://host/api/foo`),
 * con independencia del método HTTP (que aquí no se inspecciona).
 *
 * Es TOTAL: para cualquier entrada (incluidas URLs u orígenes malformados)
 * devuelve un booleano sin lanzar. Ante ambigüedad, degrada a `false`
 * (no interceptar) para no interferir con llamadas ajenas al Portal.
 */
export function shouldInterceptApiUrl(url: string, origin: string): boolean {
  if (typeof url !== "string" || typeof origin !== "string") return false;

  let resolved: URL;
  try {
    // Resuelve `url` (relativa o absoluta) contra el origen del Portal.
    resolved = new URL(url, origin);
  } catch {
    return false;
  }

  // Debe pertenecer exactamente al mismo origen que el Portal.
  if (resolved.origin !== origin) return false;

  const { pathname } = resolved;
  if (!pathname.startsWith("/api/")) return false;
  if (pathname.startsWith("/api/auth/")) return false;

  return true;
}

/**
 * Clasificación TOTAL del status HTTP: `401 → "relogin"`, `403 → "forbidden"`,
 * cualquier otro valor → `"passthrough"`. El resultado siempre pertenece al
 * conjunto `{ relogin, forbidden, passthrough }`.
 */
export function classifyApiResponse(status: number): InterceptAction {
  if (status === 401) return "relogin";
  if (status === 403) return "forbidden";
  return "passthrough";
}
