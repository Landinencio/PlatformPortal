"use client";

import { AlertTriangle, Info } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export interface AttributionCoverageNoticeProps {
  /** Author_Attribution_Coverage (% de despliegues con autoría resoluble); null ⇒ no disponible. */
  coverage: number | null;
  /** Umbral configurable para el aviso best-effort (default servidor 80.0). */
  threshold: number;
}

/**
 * Aviso de cobertura de atribución por autor, bajo filtro de autor activo.
 *
 * - Si `coverage < threshold` (estrictamente) ⇒ aviso visible de que la atribución es
 *   best-effort y puede estar incompleta.
 * - `coverage === null` ⇒ "no disponible" (distinto de 0; no se evalúa el umbral).
 * - Siempre muestra la nota permanente de que la atribución se basa en los cambios
 *   registrados en `deployment_changes` (Requisito 7.6).
 *
 * El componente lo renderiza el caller solo cuando hay filtro de autor activo.
 *
 * i18n: tiene su propio `useI18n()` (gotcha de closures de t() al minificar).
 */
export function AttributionCoverageNotice({
  coverage,
  threshold,
}: AttributionCoverageNoticeProps): JSX.Element | null {
  const { t } = useI18n();

  const isUnavailable = coverage === null;
  const isBelowThreshold = coverage !== null && coverage < threshold;

  return (
    <div className="space-y-2" data-testid="dora-coverage-notice">
      {isBelowThreshold && (
        <div
          className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning"
          data-testid="dora-coverage-warning"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {t(
              "metrics.dora.coverageNotice.warning",
              "Atribución por autor best-effort: puede estar incompleta."
            )}{" "}
            {t("metrics.dora.coverageNotice.coverage", "Cobertura: {pct}%").replace(
              "{pct}",
              (coverage as number).toFixed(1)
            )}
          </span>
        </div>
      )}

      <div
        className="flex items-start gap-2 rounded-lg border border-border/60 bg-secondary/30 px-4 py-2 text-xs text-muted-foreground"
        data-testid="dora-coverage-note"
      >
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          {t(
            "metrics.dora.coverageNotice.note",
            "La atribución por autor se basa en los cambios registrados en deployment_changes."
          )}
          {isUnavailable && (
            <>
              {" "}
              <span data-testid="dora-coverage-unavailable">
                {t(
                  "metrics.dora.coverageNotice.unavailable",
                  "Cobertura de atribución: no disponible."
                )}
              </span>
            </>
          )}
        </span>
      </div>
    </div>
  );
}
