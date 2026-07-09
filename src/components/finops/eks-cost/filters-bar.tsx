"use client";

/**
 * FiltersBar — filter and refresh controls for the EKS Cost Optimization dashboard.
 *
 * Renders three shadcn `Select`s (env / nodegroup / squad), a refresh button
 * and the `Generado: HH:mm:ss` timestamp derived from `summary.generatedAt`
 * in the user's local time zone (design.md §FiltersBar).
 *
 * The three dimensions:
 *   - **env**       — options come from `summary.environments[].name`.
 *   - **nodegroup** — options come from `summary.nodegroups[]`, filtered to
 *                     the selected `env` (if any). This is why the dropdown
 *                     re-populates when the user changes the environment.
 *   - **squad**     — options come from `summary.squads[].name`.
 *
 * Each dropdown includes a leading "Todos" / "Sin filtro" option that clears
 * that dimension from the applied filters (Requirements 6.4, 6.5).
 *
 * Interactions:
 *   - Every change fires `onFiltersChange` with a fresh, immutable `Filters`
 *     object; parent state remains the single source of truth.
 *   - When the user changes `env`, we reset `nodegroup` (and `squad`, for
 *     safety) if the current value is no longer valid in the new subset —
 *     avoids the "stale filter" bug where the querystring still points to
 *     a nodegroup that does not belong to the freshly chosen env
 *     (Requirement 6.5).
 *   - Clicking "Refrescar" delegates to the parent via `onRefresh` — the
 *     dashboard is responsible for the actual refetch (Requirement 9.5).
 *
 * Note on Radix behaviour:
 *   `@radix-ui/react-select` does not accept the empty string as a
 *   `SelectItem` value (it reserves it for "no selection" / the placeholder
 *   state). We therefore use the sentinel `"__all__"` internally and map
 *   it back to `undefined` when propagating changes upstream. The parent
 *   never sees the sentinel.
 *
 * Timestamp handling:
 *   `summary.generatedAt` is an ISO 8601 UTC string produced by the
 *   backend. `Date#toLocaleTimeString` with the `es-ES` locale renders it
 *   in the user's browser time zone (Requirement 9.4). Non-parsable inputs
 *   fall back to `"—"` so the label never breaks the layout.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 9.4, 9.5.
 */

import { RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  AllocationResponse,
  EnvironmentName,
  Filters,
} from "@/lib/eks-cost/types";
import { prettySquadName } from "./theme";

/** Sentinel value used for the "Todos" / "Sin filtro" option in the Selects. */
const ALL_VALUE = "__all__";

/** Portal-canonical environment names. Kept aligned with `types.ts`. */
const ENV_NAMES: readonly EnvironmentName[] = [
  "dev",
  "uat",
  "prod",
  "tooling",
];

export interface FiltersBarProps {
  /**
   * The current (possibly filtered) response. Used for the timestamp
   * (`generatedAt`).
   */
  summary: AllocationResponse;
  /**
   * The full estate catalogue — the last response received without any
   * filters applied. Dropdown options ALWAYS come from here so a filtered
   * summary never shrinks the menu. When no unfiltered response is
   * available yet (very first render), the parent may pass `summary` as
   * a fallback and the dropdowns will simply mirror whatever came back.
   */
  catalog: AllocationResponse;
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  onRefresh: () => void;
}

/**
 * Format an ISO timestamp as `HH:mm:ss` in the user's local time zone.
 * Falls back to `"—"` for missing / invalid inputs so the label never
 * ends up rendering "Invalid Date".
 */
function formatLocalTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "—";
  return new Date(ts).toLocaleTimeString("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function FiltersBar({
  summary,
  catalog,
  filters,
  onFiltersChange,
  onRefresh,
}: FiltersBarProps) {
  // Environment options: only surface envs that appear in the CATALOG
  // (all four when the estate is healthy), rendered in the canonical order
  // dev → uat → prod → tooling to match the rest of the FinOps UI.
  const envOptions = useMemo<readonly EnvironmentName[]>(() => {
    const present = new Set<EnvironmentName>(
      catalog.environments.map((e) => e.name),
    );
    return ENV_NAMES.filter((name) => present.has(name));
  }, [catalog.environments]);

  // Nodegroup options, filtered by the currently selected env. Deduplicated
  // by name (`main` in dev and `main` in prod both surface as `main` but the
  // filter targets whichever env is active). Sorted alphabetically for
  // stable rendering. Sourced from the CATALOG so switching env still shows
  // every nodegroup available in that env, not the empty set left over
  // from a previous filter. We deliberately drop the `"unknown"` sentinel:
  // a workload whose pod->node mapping resolved to no nodegroup lands
  // there, and offering it as a filter option would produce a "0 results"
  // view that the user cannot escape without switching back to "Sin
  // filtro" (the fallback in `node-cost.fetchWorkloads` already attributes
  // to the sole nodegroup when the cluster has exactly one, so `unknown`
  // is truly ambiguous — no attribution possible).
  const nodegroupOptions = useMemo<readonly string[]>(() => {
    const seen = new Set<string>();
    for (const ng of catalog.nodegroups) {
      if (filters.env && ng.environment !== filters.env) continue;
      if (ng.name === "unknown") continue;
      seen.add(ng.name);
    }
    return Array.from(seen).sort();
  }, [catalog.nodegroups, filters.env]);

  // Squad options: derived from `catalog.squads[].name` so every squad in
  // the estate stays visible regardless of which one is currently picked.
  const squadOptions = useMemo<readonly string[]>(() => {
    return catalog.squads.map((s) => s.name).sort();
  }, [catalog.squads]);

  const handleEnvChange = (raw: string) => {
    const nextEnv: EnvironmentName | undefined =
      raw === ALL_VALUE ? undefined : (raw as EnvironmentName);

    // When env changes, invalidate the nodegroup selection if it no longer
    // belongs to the new env in the CATALOG (so we keep it whenever the
    // pair remains valid across the estate). Squad is checked against the
    // catalog too.
    const nextNodegroup = filters.nodegroup
      ? catalog.nodegroups.some(
          (ng) =>
            ng.name === filters.nodegroup &&
            (!nextEnv || ng.environment === nextEnv),
        )
        ? filters.nodegroup
        : undefined
      : undefined;

    const nextSquad = filters.squad
      ? catalog.squads.some((s) => s.name === filters.squad)
        ? filters.squad
        : undefined
      : undefined;

    onFiltersChange({
      env: nextEnv,
      nodegroup: nextNodegroup,
      squad: nextSquad,
    });
  };

  const handleNodegroupChange = (raw: string) => {
    onFiltersChange({
      ...filters,
      nodegroup: raw === ALL_VALUE ? undefined : raw,
    });
  };

  const handleSquadChange = (raw: string) => {
    onFiltersChange({
      ...filters,
      squad: raw === ALL_VALUE ? undefined : raw,
    });
  };

  const envValue = filters.env ?? ALL_VALUE;
  const nodegroupValue = filters.nodegroup ?? ALL_VALUE;
  const squadValue = filters.squad ?? ALL_VALUE;
  const generatedAt = formatLocalTime(summary.generatedAt);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border bg-card p-3 shadow-sm">
      {/* env */}
      <div className="flex min-w-[10rem] flex-col gap-1">
        <label
          htmlFor="eks-cost-env"
          className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
        >
          Entorno
        </label>
        <Select value={envValue} onValueChange={handleEnvChange}>
          <SelectTrigger id="eks-cost-env" className="w-full">
            <SelectValue placeholder="Todos los entornos" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>Todos</SelectItem>
            {envOptions.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* nodegroup (filtered by env) */}
      <div className="flex min-w-[12rem] flex-col gap-1">
        <label
          htmlFor="eks-cost-nodegroup"
          className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
        >
          Nodegroup
        </label>
        <Select value={nodegroupValue} onValueChange={handleNodegroupChange}>
          <SelectTrigger id="eks-cost-nodegroup" className="w-full">
            <SelectValue placeholder="Todos los nodegroups" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>Sin filtro</SelectItem>
            {nodegroupOptions.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* squad */}
      <div className="flex min-w-[12rem] flex-col gap-1">
        <label
          htmlFor="eks-cost-squad"
          className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
        >
          Squad
        </label>
        <Select value={squadValue} onValueChange={handleSquadChange}>
          <SelectTrigger id="eks-cost-squad" className="w-full">
            <SelectValue placeholder="Todos los squads" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>Sin filtro</SelectItem>
            {squadOptions.map((name) => (
              <SelectItem key={name} value={name}>
                {prettySquadName(name)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Timestamp + refresh, right-aligned */}
      <div className="ml-auto flex items-end gap-3">
        <div className="text-xs text-muted-foreground">
          <span className="font-medium">Generado:</span>{" "}
          <span
            data-testid="eks-cost-generated-at"
            className="font-mono tabular-nums"
          >
            {generatedAt}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          aria-label="Refrescar datos"
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refrescar
        </Button>
      </div>
    </div>
  );
}
