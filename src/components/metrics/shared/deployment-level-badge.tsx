"use client";

import { useId, useState } from "react";
import { Layers } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export interface DeploymentLevelBadgeProps {
  /** Métrica a la que acompaña la etiqueta. */
  metric: "cfr" | "recovery";
  /** Solo se renderiza cuando hay filtro de autor activo (authorScope.active). */
  visible: boolean;
}

/**
 * Etiqueta "Nivel despliegue/pipeline" con tooltip accesible para CFR y Pipeline
 * Recovery Time bajo filtro de autor.
 *
 * - Texto: "Nivel despliegue/pipeline".
 * - Tooltip accesible: `role="tooltip"` + `aria-describedby`, visible en hover Y en
 *   foco de teclado, y persistente mientras dure el hover o el foco. Explica que un
 *   despliegue fallido puede mezclar varios autores y que la métrica no responsabiliza
 *   a una persona concreta.
 * - visible=false (filtro de autor vacío) ⇒ no se renderiza nada (regresión cero).
 *
 * i18n: tiene su propio `useI18n()` (gotcha de closures de t() al minificar).
 */
export function DeploymentLevelBadge({
  metric,
  visible,
}: DeploymentLevelBadgeProps): JSX.Element | null {
  const { t } = useI18n();
  const tooltipId = useId();
  const [open, setOpen] = useState(false);

  if (!visible) return null;

  const show = () => setOpen(true);
  const hide = () => setOpen(false);

  return (
    <span className="relative inline-flex" data-testid={`dora-deployment-level-${metric}`}>
      <span
        tabIndex={0}
        role="button"
        aria-describedby={tooltipId}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className="inline-flex cursor-help items-center gap-1 rounded-full border border-info/30 bg-info/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-info focus:outline-none focus:ring-2 focus:ring-info/50"
      >
        <Layers className="h-3 w-3" />
        {t("metrics.dora.deploymentLevel.label", "Nivel despliegue/pipeline")}
      </span>
      {open && (
        <span
          role="tooltip"
          id={tooltipId}
          className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-popover px-3 py-2 text-xs font-normal normal-case leading-relaxed text-popover-foreground shadow-lg"
        >
          {t(
            "metrics.dora.deploymentLevel.tooltip",
            "Un despliegue fallido puede mezclar cambios de varios autores. Esta métrica se calcula a nivel de despliegue/pipeline y no responsabiliza a una persona concreta."
          )}
        </span>
      )}
    </span>
  );
}
