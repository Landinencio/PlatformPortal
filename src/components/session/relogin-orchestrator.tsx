/**
 * session-nav-hardening — Orquestador de re-login (single-flight).
 *
 * Feature: session-nav-hardening
 *
 * Contexto React montado UNA sola vez dentro del `SessionProvider`. Es el punto
 * de entrada ÚNICO al flujo de re-login, compartido por `GuardiaSesion` (R1) y
 * `HttpInterceptor` (R2). La decisión de disparar se delega en la función pura
 * `shouldTriggerRelogin` (ventana de 5000 ms), de modo que ante disparos
 * concurrentes de ambas fuentes el re-login se ejecuta una única vez (R2.6, R4.7).
 *
 * El estado (`ReloginState`) vive en un `useRef`: no provoca re-render y
 * sobrevive entre disparos sin recrear el contexto.
 *
 * _Requirements: 2.6, 4.1, 4.2, 4.3, 4.5, 4.6, 4.7_
 */

"use client";

import { createContext, useCallback, useContext, useRef, type ReactNode } from "react";
import { signIn } from "next-auth/react";
import { usePathname, useSearchParams } from "next/navigation";

import {
  markTriggered,
  shouldTriggerRelogin,
  type ReloginState,
} from "@/lib/session/relogin-dedupe";
import { buildNextParam, sanitizeInternalPath } from "@/lib/navigation/internal-path";
import { useToast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";

/** Origen del disparo. Solo informativo (telemetría); no altera la lógica. */
export type ReloginSource = "guard" | "http-401" | "guard-refresh-failed";

export interface ReloginApi {
  /** Punto de entrada ÚNICO al re-login. */
  triggerRelogin(source: ReloginSource): void;
}

/**
 * Retraso antes de ejecutar `signIn`. Debe ser ≤ 3000 ms (R4.6) para no dejar
 * al usuario en una página inservible; deja un margen para leer el aviso.
 */
export const RELOGIN_REDIRECT_DELAY_MS = 1500;

const ReloginContext = createContext<ReloginApi>({ triggerRelogin: () => {} });

/** Acceso al orquestador de re-login desde cualquier componente descendiente. */
export function useReloginOrchestrator(): ReloginApi {
  return useContext(ReloginContext);
}

export function ReloginOrchestrator({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { t } = useI18n();

  // Estado del single-flight: en useRef para no re-renderizar ni recrear el
  // valor del contexto en cada disparo.
  const stateRef = useRef<ReloginState>({ lastTriggeredAt: null });

  // Refs siempre sincronizados con la ubicación vigente, de modo que el
  // callback estable capture la Ruta_Previa del momento exacto del disparo.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  const triggerRelogin = useCallback(
    (_source: ReloginSource) => {
      const now = Date.now();
      // 1. Single-flight: disparos dentro de la ventana de 5000 ms son no-op
      //    (R2.6, R4.7), con independencia del origen (`_source`).
      if (!shouldTriggerRelogin(stateRef.current, now)) return;

      // 2. Marca el disparo (estado inmutable).
      stateRef.current = markTriggered(stateRef.current, now);

      // 3. Captura INMUTABLE del callbackUrl (R4.1). En "/" siempre "/" (R4.5);
      //    en Pagina_Interna, la Ruta_Previa interna válida (R4.2/R4.4) o "/"
      //    ante cualquier anomalía (R4.3).
      const currentPath = pathnameRef.current ?? "/";
      const rawSearch = searchParamsRef.current?.toString() ?? "";
      const callbackUrl =
        currentPath === "/" ? "/" : callbackUrlFor(currentPath, rawSearch);

      // 4. Mensaje inmediato (≤500 ms) vía toast (R4.6).
      toast("info", t("session.reloginRedirecting", "Sesión caducada, redirigiendo…"));

      // 5. Redirección programada (≤3000 ms) al proveedor de identidad (R4.6).
      setTimeout(() => {
        void signIn(undefined, { callbackUrl });
      }, RELOGIN_REDIRECT_DELAY_MS);
    },
    [toast, t]
  );

  return (
    <ReloginContext.Provider value={{ triggerRelogin }}>{children}</ReloginContext.Provider>
  );
}

/**
 * callbackUrl seguro a partir de pathname + search de una Pagina_Interna.
 * Reutiliza los módulos puros anti open-redirect: nunca devuelve un destino
 * externo; degrada a "/" ante cualquier entrada anómala.
 */
function callbackUrlFor(pathname: string, search: string): string {
  const next = buildNextParam(pathname, search);
  if (!next) return "/";
  try {
    return sanitizeInternalPath(decodeURIComponent(next));
  } catch {
    return "/";
  }
}
