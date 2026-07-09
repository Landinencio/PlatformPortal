"use client";

import { Users, FolderGit2, UserCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export interface ScopeBannerProps {
  /** Equipos aplicados al alcance. Vacío ⇒ todos los equipos. */
  teams: string[];
  /** Proyectos aplicados al alcance. Vacío ⇒ todos los proyectos. */
  projects: { id: number; name: string }[];
  /** Canonical_Author_Identity aplicadas (Author_Filter). Vacío ⇒ sin filtro de autor. */
  authors: { key: string; name: string }[];
  /** Máximo de nombres de autor mostrados antes de "+N más". Default 5. */
  maxAuthorsShown?: number;
}

/**
 * Banner permanente de alcance de las métricas DORA: muestra SIEMPRE las tres
 * dimensiones (equipo, proyecto, autores), aunque alguna no tenga filtro activo.
 *
 * - authors vacío ⇒ "Sin filtro de autor".
 * - ni equipo ni proyecto ni autores ⇒ "Todos los equipos y proyectos".
 * - >maxAuthorsShown autores ⇒ primeros N + "+M más".
 * - Es un componente controlado por props: al recalcular las métricas (estado React
 *   del dashboard) se re-renderiza con el alcance actualizado, sin recarga manual.
 *
 * i18n: tiene su propio `useI18n()` (las closures de t() se rompen al minificar si se
 * capturan desde el componente padre — gotcha conocido del portal).
 */
export function ScopeBanner({
  teams,
  projects,
  authors,
  maxAuthorsShown = 5,
}: ScopeBannerProps) {
  const { t } = useI18n();

  const hasTeams = teams.length > 0;
  const hasProjects = projects.length > 0;
  const hasAuthors = authors.length > 0;

  // Ni equipo ni proyecto ni autores ⇒ alcance global.
  if (!hasTeams && !hasProjects && !hasAuthors) {
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-2xl border border-border/70 bg-secondary/30 px-4 py-3 text-sm"
        data-testid="dora-scope-banner"
      >
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {t("metrics.dora.scope.title", "Alcance")}
        </span>
        <span className="text-muted-foreground">
          {t("metrics.dora.scope.allTeamsProjects", "Todos los equipos y proyectos")}
        </span>
      </div>
    );
  }

  const shownAuthors = authors.slice(0, maxAuthorsShown);
  const remainingAuthors = authors.length - shownAuthors.length;

  return (
    <div
      className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-border/70 bg-secondary/30 px-4 py-3 text-sm"
      data-testid="dora-scope-banner"
    >
      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {t("metrics.dora.scope.title", "Alcance")}
      </span>

      {/* Dimensión: equipos (siempre presente) */}
      <ScopeDimension
        icon={Users}
        label={t("metrics.dora.scope.team", "Equipo")}
        testId="dora-scope-team"
      >
        {hasTeams ? (
          <span className="font-medium text-foreground">{teams.join(", ")}</span>
        ) : (
          <span className="text-muted-foreground">
            {t("metrics.dora.scope.allTeams", "Todos los equipos")}
          </span>
        )}
      </ScopeDimension>

      {/* Dimensión: proyectos (siempre presente) */}
      <ScopeDimension
        icon={FolderGit2}
        label={t("metrics.dora.scope.project", "Proyecto")}
        testId="dora-scope-project"
      >
        {hasProjects ? (
          <span className="font-medium text-foreground">
            {projects.map((p) => p.name).join(", ")}
          </span>
        ) : (
          <span className="text-muted-foreground">
            {t("metrics.dora.scope.allProjects", "Todos los proyectos")}
          </span>
        )}
      </ScopeDimension>

      {/* Dimensión: autores (siempre presente) */}
      <ScopeDimension
        icon={UserCircle2}
        label={t("metrics.dora.scope.authors", "Autores")}
        testId="dora-scope-authors"
      >
        {hasAuthors ? (
          <span className="flex flex-wrap items-center gap-1">
            <span className="font-medium text-foreground">
              {shownAuthors.map((a) => a.name).join(", ")}
            </span>
            {remainingAuthors > 0 && (
              <span
                className="rounded-full bg-warning/12 px-2 py-0.5 text-xs font-semibold text-warning"
                data-testid="dora-scope-authors-more"
              >
                {t("metrics.dora.scope.moreAuthors", "+{n} más").replace(
                  "{n}",
                  String(remainingAuthors)
                )}
              </span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground">
            {t("metrics.dora.scope.noAuthorFilter", "Sin filtro de autor")}
          </span>
        )}
      </ScopeDimension>
    </div>
  );
}

function ScopeDimension({
  icon: Icon,
  label,
  testId,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <span className={cn("flex items-center gap-2")} data-testid={testId}>
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}:
      </span>
      {children}
    </span>
  );
}
