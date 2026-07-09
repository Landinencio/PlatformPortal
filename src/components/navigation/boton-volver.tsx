"use client";

/**
 * session-nav-hardening (Frente B) — Boton_Volver.
 *
 * Componente cliente delgado y único de "volver" que sustituye los 6 botones
 * inline inconsistentes. Toda la lógica decidible vive en módulos puros:
 *  - `resolveBackTarget` (navigation/back-target.ts) decide el destino de forma
 *    total y segura (nunca externo).
 *  - `resolveLabelWithSpanishFallback` (i18n/label-fallback.ts) resuelve la
 *    etiqueta con fallback total a español y, en último término, a la clave.
 *
 * El `useI18n()` se invoca DENTRO del cuerpo del componente (gotcha §10.8): el
 * minificador rompe los closures de helpers definidos fuera del componente que
 * capturen `t`.
 *
 * _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 5.7, 5.9, 6.5, 6.6, 7.2, 7.3_
 */

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { ES_BACK_LABEL, resolveLabelWithSpanishFallback } from "@/lib/i18n/label-fallback";
import { resolveBackTarget } from "@/lib/navigation/back-target";

export interface BotonVolverProps {
  /** Ruta interna de destino. Ausente => history-or-home. */
  destination?: string;
  className?: string;
  /**
   * Handler de navegación interna (R6.4). Cuando se proporciona, SUSTITUYE la
   * navegación por ruta (`router.push`/`router.back`): el Boton_Volver invoca
   * este callback en su lugar. Pensado para vistas que navegan entre niveles
   * internos por estado local (p.ej. el drill-down cuenta→servicio→recurso de
   * `finops/comparison-explorer.tsx`), donde NO existe una ruta a la que
   * empujar y un `router.push` rompería la vista. Ignora `destination` si ambos
   * se pasan.
   */
  onClick?: () => void;
  /** Deshabilita el control (p.ej. cuando ya se está en el nivel raíz). */
  disabled?: boolean;
}

export function BotonVolver({
  destination,
  className,
  onClick,
  disabled,
}: BotonVolverProps): JSX.Element {
  const { t } = useI18n();
  const router = useRouter();

  const label = resolveLabelWithSpanishFallback(t("common.back", ""), ES_BACK_LABEL, "common.back");

  function handleClick(): void {
    // Navegación interna por estado local (R6.4): tiene prioridad sobre la ruta.
    if (onClick) {
      onClick();
      return;
    }
    const target = resolveBackTarget(destination);
    if (target.kind === "explicit") {
      router.push(target.path);
      return;
    }
    // history-or-home: usa el historial interno si existe, si no cae a la home.
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push("/");
    }
  }

  return (
    <Button
      variant="ghost"
      className={className}
      onClick={handleClick}
      disabled={disabled}
      aria-label={label}
    >
      <ArrowLeft className="mr-2 h-4 w-4" />
      {label}
    </Button>
  );
}
