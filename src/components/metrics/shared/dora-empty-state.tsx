"use client";

import { SearchX } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export interface DoraEmptyStateProps {
  /** Canonical_Author_Identity aplicadas (Author_Filter). */
  authors: { key: string; name: string }[];
  /** Despliegues atribuibles en el alcance (siempre 0 en este estado). Default 0. */
  deployments?: number;
  /** Cambios atribuibles en el alcance (siempre 0 en este estado). Default 0. */
  attributableChanges?: number;
}

/**
 * Estado vacío honesto de la pestaña DORA bajo filtro de autor: el o los autores
 * seleccionados no tienen actividad atribuible en el alcance.
 *
 * - Identifica los autores seleccionados.
 * - Indica 0 despliegues y 0 cambios atribuibles.
 * - Es visualmente distinto de un estado de error (gestionado por SectionShell con
 *   estilo danger) y de un estado de carga (skeletons): usa un panel informativo
 *   con borde discontinuo neutro.
 *
 * i18n: tiene su propio `useI18n()` (las closures de t() se rompen al minificar si se
 * capturan desde el componente padre — gotcha conocido del portal).
 */
export function DoraEmptyState({
  authors,
  deployments = 0,
  attributableChanges = 0,
}: DoraEmptyStateProps): JSX.Element {
  const { t } = useI18n();

  const names = authors.map((a) => a.name).join(", ");

  return (
    <div
      className="rounded-2xl border border-dashed border-info/40 bg-info/5 px-6 py-8 text-center"
      data-testid="dora-empty-state"
      role="status"
    >
      <SearchX className="mx-auto mb-3 h-10 w-10 text-info/50" />
      <p className="text-sm font-semibold text-foreground">
        {t("metrics.dora.emptyState.title", "Sin actividad atribuible en el alcance")}
      </p>
      {names && (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="dora-empty-state-authors">
          {t("metrics.dora.emptyState.authors", "Autores seleccionados: {names}").replace(
            "{names}",
            names
          )}
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        {t("metrics.dora.emptyState.deployments", "{n} despliegues atribuibles").replace(
          "{n}",
          String(deployments)
        )}
        {" · "}
        {t("metrics.dora.emptyState.changes", "{n} cambios atribuibles").replace(
          "{n}",
          String(attributableChanges)
        )}
      </p>
      <p className="mt-3 text-xs text-muted-foreground/80">
        {t(
          "metrics.dora.emptyState.description",
          "No hay despliegues ni cambios de estos autores en el periodo, equipo y proyecto seleccionados. Esto no es un error: ajusta el filtro de autor o amplía el alcance."
        )}
      </p>
    </div>
  );
}
