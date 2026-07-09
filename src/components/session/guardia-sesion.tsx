/**
 * session-nav-hardening — Guardia de sesión (cliente).
 *
 * Feature: session-nav-hardening
 *
 * Componente cliente montado UNA sola vez dentro del `SessionProvider` (junto al
 * `ReloginOrchestrator` y el `HttpInterceptor`). Observa el estado de la Sesión
 * (`useSession`) y reacciona a su expiración de forma no bloqueante:
 *
 *  - En la Ruta_Publica `/` se abstiene por completo: ni avisa ni dispara
 *    re-login (R1.7).
 *  - En una Pagina_Interna, cada 1000 ms evalúa `shouldWarn`/`secondsRemaining`
 *    (módulo puro `session-expiry`) y muestra/actualiza un `Aviso_Expiracion`
 *    no bloqueante (banner con contador + botón "Continuar") mientras se cumpla
 *    el Umbral_Aviso, ocultándolo cuando deja de cumplirse (R1.3, R1.4).
 *  - Si `status` transita a `"unauthenticated"` en Pagina_Interna, dispara el
 *    flujo de re-login (R1.2).
 *  - "Continuar" revalida la sesión con `update()` bajo un timeout de 10 000 ms
 *    (R1.5); si vuelve una sesión válida a tiempo oculta el aviso, y ante
 *    fallo/timeout/sesión inválida dispara re-login e informa (R1.6).
 *
 * Toda la lógica decidible vive en `src/lib/session/session-expiry.ts`; aquí solo
 * quedan los efectos React/DOM.
 *
 * _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { usePathname } from "next/navigation";
import { AlertTriangle } from "lucide-react";

import {
  isExpired,
  secondsRemaining,
  shouldWarn,
} from "@/lib/session/session-expiry";
import { useReloginOrchestrator } from "@/components/session/relogin-orchestrator";
import { useToast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";

/** Timeout (ms) de la revalidación disparada por "Continuar" (R1.5). */
export const CONTINUE_REFRESH_TIMEOUT_MS = 10_000;

/** Sentinela para distinguir el timeout de la carrera con `update()`. */
const REFRESH_TIMEOUT = Symbol("refresh-timeout");

export function GuardiaSesion(): JSX.Element | null {
  const { data, status, update } = useSession();
  const pathname = usePathname();
  const { triggerRelogin } = useReloginOrchestrator();
  const { toast } = useToast();
  const { t } = useI18n();

  // Segundos restantes cuando el aviso está visible; null => aviso oculto.
  const [warningSeconds, setWarningSeconds] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // En la Ruta_Publica el guard se abstiene por completo (R1.7).
  const isPublicRoute = pathname === "/";

  const expires = data?.expires;

  // Refs para leer el estado vigente desde el intervalo sin recrearlo.
  const expiresRef = useRef<string | null | undefined>(expires);
  expiresRef.current = expires;
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (isPublicRoute) {
      // Fuera de Pagina_Interna: sin aviso ni disparo (R1.7).
      setWarningSeconds(null);
      return;
    }

    const evaluate = () => {
      const now = Date.now();

      // status "unauthenticated" en Pagina_Interna → re-login (R1.2).
      if (statusRef.current === "unauthenticated") {
        setWarningSeconds(null);
        triggerRelogin("guard");
        return;
      }

      const currentExpires = expiresRef.current;
      if (shouldWarn(currentExpires, now)) {
        // Muestra/actualiza el aviso con el contador (R1.3).
        setWarningSeconds(secondsRemaining(currentExpires, now));
      } else {
        // El Umbral_Aviso ya no se cumple → ocultar (R1.4).
        setWarningSeconds(null);
      }
    };

    // Evaluación inmediata para que el aviso aparezca ≤1s al cruzar el umbral.
    evaluate();
    const intervalId = setInterval(evaluate, 1000);
    return () => clearInterval(intervalId);
  }, [isPublicRoute, triggerRelogin]);

  const handleContinue = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const result = await Promise.race([
        update(),
        new Promise<typeof REFRESH_TIMEOUT>((resolve) =>
          setTimeout(() => resolve(REFRESH_TIMEOUT), CONTINUE_REFRESH_TIMEOUT_MS)
        ),
      ]);

      const refreshedValid =
        result !== REFRESH_TIMEOUT &&
        !!result &&
        !isExpired((result as { expires?: string }).expires, Date.now());

      if (refreshedValid) {
        // Sesión válida a tiempo → ocultar aviso ≤1s (R1.5).
        setWarningSeconds(null);
      } else {
        // Fallo / timeout / sesión inválida → re-login e informar (R1.6).
        toast(
          "warning",
          t(
            "session.refreshFailed",
            "No se pudo renovar la sesión. Redirigiendo para autenticarte de nuevo…"
          )
        );
        triggerRelogin("guard-refresh-failed");
      }
    } catch {
      toast(
        "warning",
        t(
          "session.refreshFailed",
          "No se pudo renovar la sesión. Redirigiendo para autenticarte de nuevo…"
        )
      );
      triggerRelogin("guard-refresh-failed");
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, update, toast, t, triggerRelogin]);

  if (isPublicRoute || warningSeconds === null) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      className="fixed top-4 left-1/2 z-[100] -translate-x-1/2 flex items-center gap-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-warning shadow-lg backdrop-blur-sm"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="text-sm font-medium">
        {t("session.expiryWarning", "Tu sesión caducará pronto.")}{" "}
        <span className="tabular-nums">
          {warningSeconds} {t("session.secondsRemaining", "segundos restantes")}
        </span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleContinue}
        disabled={refreshing}
        className="ml-1 h-7 shrink-0"
      >
        {t("session.continue", "Continuar")}
      </Button>
    </div>
  );
}
