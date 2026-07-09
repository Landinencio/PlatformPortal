/**
 * Guardia_Duplicado — comprobación de colisión de ficheros IaC.
 *
 * Evita crear un fichero que ya existe en el repo del equipo (Req 2). La API
 * pura (`IDENTIFIER_PATTERN`, `validateIdentifier`, `DUPLICATE_CACHE_TTL_MS`,
 * `DUPLICATE_CHECK_TIMEOUT_MS`, `DuplicateCheckResult`) se mantiene intacta
 * y testeable por propiedades sin tocar red ni cache. La I/O (`checkDuplicate`,
 * `invalidateDuplicateCache`) vive al final del fichero.
 */

import { cached, hasCacheEntry, invalidateCache } from "@/lib/cache";
import { InfraLogger } from "@/lib/logger";

/**
 * Regex canónico para identificadores IaC (Req 2.8).
 *
 * - Empieza por [a-z0-9] (no puede empezar por guion).
 * - Longitud 1..63 (0..62 más el carácter inicial).
 * - Cuerpo en [a-z0-9-].
 *
 * Deliberadamente NO permite mayúsculas ni underscores; los generadores de
 * upstream deben normalizar (`toLowerCase().trim()`) antes de matchear.
 */
export const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * TTL de la cache de comprobaciones de duplicado (Req 2.6).
 * Ver `src/lib/cache.ts`, prefijo `duplicate-guard:` (usado en Fase 3).
 */
export const DUPLICATE_CACHE_TTL_MS = 60_000;

/**
 * Timeout total de la comprobación de duplicado (Req 2.7, Req 9.4).
 * Aplica al `AbortController` de la llamada a GitLab en Fase 3.
 */
export const DUPLICATE_CHECK_TIMEOUT_MS = 5_000;

/**
 * Resultado de una comprobación de duplicado.
 *
 * `unavailable` sólo se puebla cuando la comprobación falló por causa
 * transitoria (timeout / 5xx / red); en ese caso `exists` es siempre `false`
 * y el llamador decide qué hacer (Req 2.7).
 */
export interface DuplicateCheckResult {
  exists: boolean;
  filePath?: string;
  ref: string;
  unavailable?: { reason: string };
}

/**
 * Normaliza un identificador crudo (lowercase + trim) y valida contra
 * `IDENTIFIER_PATTERN` (Req 2.8).
 *
 * Función pura, sin I/O. Devuelve el valor normalizado en `value` cuando
 * matchea, o `{ ok: false }` en caso contrario. El llamador debe usar
 * SIEMPRE `value` (no el input crudo) para construir rutas de fichero.
 */
export function validateIdentifier(
  raw: string
): { ok: true; value: string } | { ok: false } {
  const value = raw.toLowerCase().trim();
  if (!IDENTIFIER_PATTERN.test(value)) {
    return { ok: false };
  }
  return { ok: true, value };
}

/* ------------------------------------------------------------------ */
/*  I/O                                                                */
/* ------------------------------------------------------------------ */

/**
 * Prefijo de la caché (`src/lib/cache.ts`). El TTL efectivo se rige por
 * `DUPLICATE_CACHE_TTL_MS` (Req 2.6).
 */
const CACHE_PREFIX = "duplicate-guard";

/** Base de la API de GitLab (misma que `src/lib/gitlab.ts`). */
const GITLAB_API_BASE = "https://gitlab.com/api/v4";

/**
 * Construye la clave de cache canónica.
 * Formato: `duplicate-guard:${projectId}:${ref}:${filePath}`.
 * `filePath` va sin encodear porque las claves de cache son internas al
 * proceso; la URL sí encodea el path al llamar a GitLab.
 */
function buildCacheKey(projectId: number, ref: string, filePath: string): string {
  return `${CACHE_PREFIX}:${projectId}:${ref}:${filePath}`;
}

/**
 * Realiza la comprobación real contra GitLab: HEAD sobre
 * `/projects/:id/repository/files/:path?ref=:ref`.
 *
 * - 200 → fichero existe → `{ exists: true, filePath, ref }`
 * - 404 → fichero no existe → `{ exists: false, ref }`
 * - timeout / red / cualquier otro status → `{ exists: false, ref,
 *   unavailable: { reason } }` (Req 2.7). El llamador decide si degradar.
 *
 * Nunca lanza.
 */
async function performCheck(
  projectId: number,
  ref: string,
  filePath: string
): Promise<DuplicateCheckResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    DUPLICATE_CHECK_TIMEOUT_MS
  );
  try {
    const encodedPath = encodeURIComponent(filePath);
    const encodedRef = encodeURIComponent(ref);
    const url = `${GITLAB_API_BASE}/projects/${projectId}/repository/files/${encodedPath}?ref=${encodedRef}`;
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        "PRIVATE-TOKEN": process.env.GITLAB_TOKEN ?? "",
      },
      signal: controller.signal,
    });

    if (response.status === 200) {
      return { exists: true, filePath, ref };
    }
    if (response.status === 404) {
      return { exists: false, ref };
    }
    return {
      exists: false,
      ref,
      unavailable: { reason: `http_${response.status}` },
    };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? "timeout"
        : err instanceof Error
          ? err.message
          : "unknown";
    return { exists: false, ref, unavailable: { reason } };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Comprueba si `filePath` ya existe en `projectId@ref` (Req 2.1, 2.2, 2.3).
 *
 * - Cacheado por `(projectId, ref, filePath)` con TTL 60 s (Req 2.6).
 * - Timeout total 5 000 ms via `AbortController` (Req 2.7, 9.4).
 * - Nunca lanza: fallos transitorios (timeout / 5xx / red) se propagan como
 *   `{ exists: false, unavailable: {...} }` para que el llamador decida.
 * - 404 (p.ej. sobre un fichero compartido `iac/s3/s3.tf` cuando aún no
 *   existe) se trata como "no duplicado" (Req 2.7).
 * - Sólo consulta la rama por defecto que le pase el llamador; la resolución
 *   se hace en `repo_catalog.getByTeam(team).default_branch` upstream
 *   (Req 2.1, 2.9).
 *
 * Emite un log `InfraLogger` con `outcome ∈ {hit, miss, duplicate, error}` y
 * `latencyMs` (Req 7.1).
 */
export async function checkDuplicate(
  projectId: number,
  ref: string,
  filePath: string
): Promise<DuplicateCheckResult> {
  const key = buildCacheKey(projectId, ref, filePath);
  const startedAt = Date.now();
  const wasCached = hasCacheEntry(key);

  const result = await cached<DuplicateCheckResult>(
    key,
    () => performCheck(projectId, ref, filePath),
    DUPLICATE_CACHE_TTL_MS
  );

  const latencyMs = Date.now() - startedAt;
  const outcome: "hit" | "miss" | "duplicate" | "error" = wasCached
    ? "hit"
    : result.unavailable
      ? "error"
      : result.exists
        ? "duplicate"
        : "miss";

  new InfraLogger("duplicate-guard", "system").info("checkDuplicate", {
    outcome,
    latencyMs,
    projectId,
    ref,
    filePath,
  });

  return result;
}

/**
 * Invalidación explícita del cache tras un `createFile` exitoso (Req 2.10).
 * Devuelve `true` si había una entrada viva (no expirada) en cache, `false`
 * en caso contrario.
 *
 * Se llama desde el hook post-`createFile` del Execute_API para que la
 * siguiente comprobación no devuelva el estado previo cacheado.
 */
export function invalidateDuplicateCache(
  projectId: number,
  ref: string,
  filePath: string
): boolean {
  const key = buildCacheKey(projectId, ref, filePath);
  const existed = hasCacheEntry(key);
  invalidateCache(key);
  return existed;
}
