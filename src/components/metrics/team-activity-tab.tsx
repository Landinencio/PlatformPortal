"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MiniStat } from "@/components/metrics/shared/mini-stat";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format-utils";
import { useI18n } from "@/lib/i18n";
import { MRDetailsTable } from "@/components/metrics/mr-details-table";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RecentMR = {
  title: string;
  projectName: string;
  mergedAt: string;
  lifetimeHours: number;
  webUrl: string | null;
};

type Contributor = {
  username: string;
  name: string;
  avatarUrl: string | null;
  teams: string[];
  mrsMerged: number;
  mrsOpen: number;
  reviewsGiven: number;
  avgTimeToMergeHours: number;
  avgReviewTimeHours: number;
  lastMergedAt: string | null;
  recentMRs: RecentMR[];
};

type TeamActivityData = {
  summary: {
    totalMRsMerged: number;
    totalMRsOpen: number;
    totalReviews: number;
    activeContributors: number;
    avgTimeToMergeHours: number;
  };
  contributors: Contributor[];
  filters: { days: number; teams: string[]; projectIds: number[] };
};

type FilterKey = "all" | "active" | "inactive";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name.slice(0, 2) || "??").toUpperCase();
}

function isActive(c: Contributor): boolean {
  return c.mrsMerged >= 1 || c.reviewsGiven >= 1;
}

function relativeDate(isoDate: string | null, locale: string): string {
  if (!isoDate) return "-";
  const diff = Date.now() - new Date(isoDate).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return locale === "es" ? "hoy" : locale === "pt" ? "hoje" : locale === "fr" ? "aujourd'hui" : "today";
  if (days === 1) return locale === "es" ? "ayer" : locale === "pt" ? "ontem" : locale === "fr" ? "hier" : "yesterday";
  if (locale === "es") return `hace ${days}d`;
  if (locale === "pt") return `há ${days}d`;
  if (locale === "fr") return `il y a ${days}j`;
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TeamActivityTab({
  teams,
  projectIds,
  days,
  from,
  to,
  authorUsernames = [],
}: {
  teams: string[];
  projectIds: number[];
  days: number;
  from?: string;
  to?: string;
  /** GitLab usernames expanded from the global canonical author filter. */
  authorUsernames?: string[];
}) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<TeamActivityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // Fetch data
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (from && to) {
        params.set("from", from);
        params.set("to", to);
      } else {
        params.set("days", String(days));
      }
      if (teams.length) params.set("teams", teams.join(","));
      if (projectIds.length) params.set("projectIds", projectIds.join(","));
      if (authorUsernames.length) params.set("authors", authorUsernames.join(","));
      const res = await fetch(`/api/metrics/team-activity?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e: any) {
      setError(e.message || "Error");
    } finally {
      setLoading(false);
    }
  }, [days, teams, projectIds, from, to, authorUsernames]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Filtered + sorted contributors
  const contributors = useMemo(() => {
    if (!data) return [];
    let list = data.contributors;
    if (filter === "active") list = list.filter(isActive);
    if (filter === "inactive") list = list.filter((c) => !isActive(c));
    return [...list].sort((a, b) => {
      const aActive = isActive(a) ? 1 : 0;
      const bActive = isActive(b) ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return b.mrsMerged - a.mrsMerged;
    });
  }, [data, filter]);

  const selected = useMemo(
    () => data?.contributors.find((c) => c.username === selectedUser) ?? null,
    [data, selectedUser]
  );

  // Loading / error states
  if (loading) {
    return <div className="py-12 text-center text-sm text-muted-foreground">{t("common.loading")}</div>;
  }
  if (error || !data) {
    return <div className="py-12 text-center text-sm text-destructive">{error || t("common.error")}</div>;
  }
  // Detail view
  if (selected) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setSelectedUser(null)}
          className="text-sm font-medium text-primary hover:underline"
        >
          {t("team.back")}
        </button>
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 pb-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
              {getInitials(selected.name || selected.username)}
            </div>
            <div>
              <CardTitle className="text-base">{selected.name || selected.username}</CardTitle>
              <p className="text-xs text-muted-foreground">@{selected.username}</p>
            </div>
            <Badge className={cn("ml-auto text-[10px]", isActive(selected) ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-gray-100 text-gray-600 dark:bg-gray-800/50 dark:text-gray-400")}>
              {isActive(selected) ? t("team.active") : t("team.inactive")}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MiniStat label={t("team.mrsMerged")} value={String(selected.mrsMerged)} />
              <MiniStat label={t("team.avgMerge")} value={formatDuration(selected.avgTimeToMergeHours)} />
              <MiniStat label={t("team.reviews")} value={String(selected.reviewsGiven)} />
              <MiniStat label={t("team.lastMerge")} value={relativeDate(selected.lastMergedAt, locale)} />
            </div>
            <div>
              <h4 className="mb-2 text-sm font-semibold">{t("team.recentMRs")}</h4>
              {selected.recentMRs.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("team.noActivity")}</p>
              ) : (
                <ul className="space-y-2">
                  {selected.recentMRs.map((mr, i) => (
                    <li key={i} className="rounded-lg border border-border/70 px-3 py-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          {mr.webUrl ? (
                            <a href={mr.webUrl} target="_blank" rel="noopener noreferrer" className="truncate text-sm font-medium text-primary hover:underline">
                              {mr.title}
                            </a>
                          ) : (
                            <span className="truncate text-sm font-medium">{mr.title}</span>
                          )}
                          <p className="text-xs text-muted-foreground">{mr.projectName}</p>
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground">{formatDuration(mr.lifetimeHours)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Main view
  const filterCounts = {
    all: data.contributors.length,
    active: data.contributors.filter(isActive).length,
    inactive: data.contributors.filter((c) => !isActive(c)).length,
  };

  const filters: { key: FilterKey; labelKey: string }[] = [
    { key: "all", labelKey: "team.filterAll" },
    { key: "active", labelKey: "team.filterActive" },
    { key: "inactive", labelKey: "team.filterInactive" },
  ];

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MiniStat label={t("team.mrsMerged")} value={String(data.summary.totalMRsMerged)} tone="success" />
        <MiniStat label={t("team.mrsOpen")} value={String(data.summary.totalMRsOpen)} tone="info" />
        <MiniStat label={t("team.reviews")} value={String(data.summary.totalReviews)} />
        <MiniStat label={t("team.people")} value={String(data.summary.activeContributors)} />
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-2">
        {filters.map(({ key, labelKey }) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === key
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-background text-muted-foreground hover:bg-muted"
            )}
          >
            {t(labelKey)}
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
              {filterCounts[key]}
            </span>
          </button>
        ))}
      </div>

      {/* Scorecard grid */}
      {teams.length === 0 && projectIds.length === 0 ? (
        /* No filter selected — show prompt to filter */
        <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {t("team.selectTeamPrompt")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("team.selectTeamHint")}
          </p>
        </div>
      ) : (
        /* Filtered view — show top 12 with "show all" option */
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {contributors.slice(0, showAll ? undefined : 12).map((c) => (
              <Card
                key={c.username}
                className="cursor-pointer border-border/70 transition-shadow hover:shadow-md"
                onClick={() => setSelectedUser(c.username)}
              >
                <CardHeader className="flex flex-row items-center gap-3 p-4 pb-2">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                    {getInitials(c.name || c.username)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{c.name || c.username}</div>
                    <div className="truncate text-[11px] text-muted-foreground">@{c.username}</div>
                  </div>
                  <Badge className={cn("shrink-0 text-[10px]", isActive(c) ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-gray-100 text-gray-600 dark:bg-gray-800/50 dark:text-gray-400")}>
                    {isActive(c) ? t("team.active") : t("team.inactive")}
                  </Badge>
                </CardHeader>
                <CardContent className="px-4 pb-4 pt-2">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                    <StatCell label={t("team.mrsMerged")} value={String(c.mrsMerged)} />
                    <StatCell label={t("team.avgMerge")} value={formatDuration(c.avgTimeToMergeHours)} />
                    <StatCell label={t("team.reviews")} value={String(c.reviewsGiven)} />
                    <StatCell label={t("team.lastMerge")} value={relativeDate(c.lastMergedAt, locale)} />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          {!showAll && contributors.length > 12 && (
            <div className="text-center">
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="text-xs font-medium text-primary hover:underline"
              >
                {t("team.showAll")} ({contributors.length})
              </button>
            </div>
          )}
        </>
      )}

      {contributors.length === 0 && (
        <div className="py-8 text-center text-sm text-muted-foreground">{t("team.noActivity")}</div>
      )}

      {/* MR Details Table */}
      <MRDetailsTable days={days} teams={teams} projectIds={projectIds} authors={authorUsernames} from={from} to={to} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatCell
// ---------------------------------------------------------------------------
function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="truncate text-xs font-semibold">{value}</div>
    </div>
  );
}
