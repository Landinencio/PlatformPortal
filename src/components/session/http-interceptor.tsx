/**
 * session-nav-hardening — Interceptor HTTP (monkey-patch de `window.fetch`).
 *
 * Feature: session-nav-hardening
 *
 * Componente cliente de solo efecto (`HttpInterceptor(): null`). Sustituye
 * `window.fetch` UNA sola vez por un wrapper que, tras cada respuesta a una URL
 * mismo-origen `/api/*` (excluyendo `/api/auth/*`), decide vía el núcleo puro
 * `http-interceptor-core.ts`:
 *   - 401 → dispara re-login single-flight (`triggerRelogin("http-401")`).
 *   - 403 → aviso no bloqueante (toast) durante 5000 ms.
 *   - resto → passthrough.
 *
 * El wrapper NUNCA lee el cuerpo (`.json()/.text()/.clone()`): solo inspecciona
 * `status` y la URL, y devuelve SIEMPRE el `Response` original con su cuerpo
 * intacto (R2.5/R2.7). Los rechazos de red se propagan sin envolver: el `await`
 * a `originalFetch` no está protegido por un `try/catch` que los trague (R2.8).
 *
 * La instalación es idempotente: el marcador `__portalPatched` evita doble
 * parcheo (p.ej. bajo StrictMode o remontajes) (R2.1). El cleanup restaura el
 * `fetch` original.
 *
 * _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 2.8_
 */

"use client";

import { useEffect } from "react";

import {
  classifyApiResponse,
  shouldInterceptApiUrl,
} from "@/lib/session/http-interceptor-core";
import { useReloginOrchestrator } from "@/components/session/relogin-orchestrator";
import { useToast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";

/** `window.fetch` parcheado por el Portal, con marcador de idempotencia. */
type PatchedFetch = typeof window.fetch & { __portalPatched?: true };

/**
 * Normaliza la entrada de `fetch` (`string | URL | Request`) a la cadena de URL
 * a inspeccionar. Total: ante entradas inesperadas devuelve `""`, que el núcleo
 * puro trata como no interceptable (degrada a passthrough).
 */
function toUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return "";
}

export function HttpInterceptor(): null {
  const { triggerRelogin } = useReloginOrchestrator();
  const { toast } = useToast();
  const { t } = useI18n();

  useEffect(() => {
    if (typeof window === "undefined") return;

    const patched = window.fetch as PatchedFetch;
    // Instalación idempotente: si ya está parcheado, no volver a envolver (R2.1).
    if (patched.__portalPatched) return;

    const originalFetch = window.fetch.bind(window);

    const wrapper: PatchedFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      // El rechazo de red se propaga sin envolver: sin try/catch (R2.8).
      const res = await originalFetch(input, init);

      const url = toUrlString(input);
      // Fuera de ámbito (cross-origin, no-/api/, /api/auth/*) → passthrough (R2.1/2.4/2.7).
      if (!shouldInterceptApiUrl(url, window.location.origin)) return res;

      switch (classifyApiResponse(res.status)) {
        case "relogin":
          triggerRelogin("http-401"); // R2.2/2.6
          break;
        case "forbidden":
          toast("warning", t("http.forbidden"), { durationMs: 5000 }); // R2.3
          break;
        default:
          break;
      }

      // SIEMPRE el Response original, cuerpo intacto (no leído) (R2.5/R2.7).
      return res;
    };

    wrapper.__portalPatched = true;
    window.fetch = wrapper;

    return () => {
      // Restaura el fetch original solo si sigue siendo nuestro wrapper.
      if ((window.fetch as PatchedFetch).__portalPatched) {
        window.fetch = originalFetch;
      }
    };
  }, [triggerRelogin, toast, t]);

  return null;
}
