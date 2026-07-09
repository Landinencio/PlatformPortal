/**
 * Fachada del módulo EKS Cost Optimization.
 *
 * Este fichero compone las capas puras (`node-cost`, `rightsizing`,
 * `promql`, `k8s-units`) en el único punto de entrada consumido por el
 * route handler `GET /api/finops/k8s-cost`:
 *
 *   1. Construye un {@link NodeCostContext} con `usdToEur = 0.92`,
 *      `hoursPerMonth = 730`, un `now` por defecto y una instancia recién
 *      creada de {@link GrafanaMetricsClient}. Cualquiera de esos campos
 *      puede reemplazarse vía `overrides` para tests unitarios / de
 *      propiedad.
 *
 *   2. Construye {@link RightsizingParams} a partir de
 *      {@link DEFAULT_RIGHTSIZING_PARAMS} aplicando los overrides.
 *
 *   3. Encadena `fetchNodegroups → fetchWorkloads → fetchRecommendations`;
 *      cada capa propaga sus warnings sin lanzar (Requirement 8.2).
 *
 *   4. Propaga `overprovisioningEur` y `excessNodes` a cada
 *      {@link Nodegroup} a partir de las recomendaciones `over-*`
 *      agrupadas por `(cluster, nodegroup)`, vía {@link computeExcessNodes}
 *      (Requirement 5.5).
 *
 *   5. Agrega los squads con {@link aggregateSquadCost} y los entornos con
 *      {@link aggregateEnvironments} (Property 2 / Property 5).
 *
 *   6. Aplica los filtros server-side vía {@link applyFilters} — la
 *      operación es idempotente y conmutativa entre dimensiones
 *      (Property 12, tarea 6.2).
 *
 *   7. Corta `workloads` al top-200 por `monthlyCostEur` DESC y
 *      `recommendations` al top-100 por `estimatedSavingsEur` DESC para
 *      mantener el payload bajo control.
 *
 *   8. Recalcula los totales de primer nivel a partir de los entornos
 *      filtrados y de las recomendaciones ya recortadas.
 *
 * See:
 *   - `.kiro/specs/eks-cost-optimization/design.md`
 *     §Backend > index.ts + §Data Models
 *   - `.kiro/specs/eks-cost-optimization/tasks.md` §Fase 1 > task 6.1
 */

import { GrafanaMetricsClient } from "@/lib/grafana-metrics";
import {
  DEFAULT_USD_TO_EUR,
  HOURS_PER_MONTH,
  aggregateEnvironments,
  aggregateSquadCost,
  computeExcessNodes,
  fetchNodegroups,
  fetchWorkloads,
} from "@/lib/eks-cost/node-cost";
import type { NodeCostContext } from "@/lib/eks-cost/node-cost";
import {
  DEFAULT_RIGHTSIZING_PARAMS,
  fetchRecommendations,
} from "@/lib/eks-cost/rightsizing";
import type { RightsizingParams } from "@/lib/eks-cost/rightsizing";
import type {
  AllocationResponse,
  Filters,
  Nodegroup,
  Recommendation,
  Warning as EksWarning,
  Workload,
} from "@/lib/eks-cost/types";

/**
 * Payload cap for `workloads[]`. The full workload universe is kept
 * internally for aggregation but only the top-N by monthly cost travels
 * to the browser, aligned with §Backend > index.ts.
 */
const WORKLOADS_TOP_N = 200;

/**
 * Payload cap for `recommendations[]`. Recommendations are sorted DESC by
 * `estimatedSavingsEur` before slicing, so the most valuable proposals
 * are always kept.
 */
const RECOMMENDATIONS_TOP_N = 100;

/** Sentinel used to build `<cluster>::<nodegroup>` keys without collisions. */
const KEY_SEP = "\u0000";

/** Round a monetary EUR value to 2 decimals. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Round a percentage to 1 decimal. */
const roundPct1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Compose the full EKS cost summary consumed by the `/api/finops/k8s-cost`
 * route.
 *
 * `filters` is applied server-side so the payload sent to the browser is
 * already narrowed down. `overrides` is the injection seam used by unit
 * and property tests: any subset of {@link NodeCostContext} +
 * {@link RightsizingParams} can be replaced (metrics client, FX rate,
 * clock, rightsizing headroom, …).
 *
 * The pipeline never throws for expected failure modes: partial Grafana
 * outages surface as {@link EksWarning}s in `warnings[]` and the rest of
 * the response is computed on the remaining data (Requirement 8.2). Only
 * unexpected exceptions propagate up to the route handler, which converts
 * them into an opaque 500.
 *
 * @param filters   Server-side filters (env / nodegroup / squad).
 * @param overrides Optional injection seams — every field is optional and
 *                  falls back to the module default.
 * @returns A fully-composed {@link AllocationResponse}.
 */
export async function fetchEksCostSummary(
  filters: Filters,
  overrides?: Partial<NodeCostContext & RightsizingParams>,
): Promise<AllocationResponse> {
  const {
    metrics,
    usdToEur,
    hoursPerMonth,
    now,
    ...rightsizingOverrides
  } = overrides ?? {};

  const ctx: NodeCostContext = {
    metrics: metrics ?? new GrafanaMetricsClient(),
    usdToEur: usdToEur ?? DEFAULT_USD_TO_EUR,
    hoursPerMonth: hoursPerMonth ?? HOURS_PER_MONTH,
    now: now ?? (() => new Date()),
  };
  const params: RightsizingParams = {
    ...DEFAULT_RIGHTSIZING_PARAMS,
    ...rightsizingOverrides,
  };

  const warnings: EksWarning[] = [];

  const {
    nodegroups: rawNodegroups,
    warnings: ngWarnings,
  } = await fetchNodegroups(ctx);
  warnings.push(...ngWarnings);

  const { workloads, warnings: wlWarnings } = await fetchWorkloads(ctx);
  warnings.push(...wlWarnings);

  const {
    recommendations,
    warnings: recWarnings,
  } = await fetchRecommendations(ctx, params, workloads);
  warnings.push(...recWarnings);

  // Aggregate over-* savings per (cluster, nodegroup) so we can populate
  // `overprovisioningEur` / `excessNodes` on each nodegroup. `under-*`
  // recommendations carry `estimatedSavingsEur === 0`, but we still gate
  // on the `over-` prefix to make the intent explicit (Requirement 5.4).
  const overByKey = new Map<string, number>();
  for (const rec of recommendations) {
    if (!rec.kind.startsWith("over-")) continue;
    const key = `${rec.cluster}${KEY_SEP}${rec.nodegroup}`;
    overByKey.set(key, (overByKey.get(key) ?? 0) + rec.estimatedSavingsEur);
  }

  const nodegroups: Nodegroup[] = rawNodegroups.map((ng) => {
    const key = `${ng.cluster}${KEY_SEP}${ng.name}`;
    const overprovisioningEur = round2(overByKey.get(key) ?? 0);
    const withOver: Nodegroup = { ...ng, overprovisioningEur };
    return { ...withOver, excessNodes: computeExcessNodes(withOver) };
  });

  const environments = aggregateEnvironments(nodegroups);
  const squads = aggregateSquadCost(workloads, recommendations);

  const composed: AllocationResponse = {
    generatedAt: ctx.now().toISOString(),
    // Totals are recomputed after filtering + capping below.
    totalMonthlyEur: 0,
    totalNodeCount: 0,
    totalSpotCoveragePct: 0,
    totalEstimatedSavingsEur: 0,
    environments,
    nodegroups,
    squads,
    workloads,
    recommendations,
    warnings,
  };

  const filtered = applyFilters(composed, filters);

  // Cap after filtering so the top-N always reflects what the user will
  // actually see. Both sorts are stable in modern V8 → deterministic order
  // for equal-cost items (matches the input order).
  const cappedWorkloads = [...filtered.workloads]
    .sort((a, b) => b.monthlyCostEur - a.monthlyCostEur)
    .slice(0, WORKLOADS_TOP_N);
  const cappedRecommendations = [...filtered.recommendations]
    .sort((a, b) => b.estimatedSavingsEur - a.estimatedSavingsEur)
    .slice(0, RECOMMENDATIONS_TOP_N);

  // Top-level totals: sums from the filtered environments and the (already
  // filtered + capped) recommendations. `totalSpotCoveragePct` is the
  // weighted average across environments (`spotCount / nodeCount`), not the
  // arithmetic mean of the per-env percentages.
  const totalMonthlyEur = round2(
    filtered.environments.reduce((s, e) => s + e.monthlyCostEur, 0),
  );
  const totalNodeCount = filtered.environments.reduce(
    (s, e) => s + e.nodeCount,
    0,
  );
  const totalSpotCount = filtered.environments.reduce(
    (s, e) => s + e.spotCount,
    0,
  );
  const totalSpotCoveragePct =
    totalNodeCount > 0
      ? roundPct1((totalSpotCount / totalNodeCount) * 100)
      : 0;
  const totalEstimatedSavingsEur = round2(
    cappedRecommendations.reduce((s, r) => s + r.estimatedSavingsEur, 0),
  );

  return {
    ...filtered,
    workloads: cappedWorkloads,
    recommendations: cappedRecommendations,
    totalMonthlyEur,
    totalNodeCount,
    totalSpotCoveragePct,
    totalEstimatedSavingsEur,
  };
}

/**
 * Apply server-side filters to an {@link AllocationResponse} without
 * touching the source data.
 *
 * Semantics (design §Backend > index.ts):
 *
 *   - `filters.env`       → keep only environments whose name matches.
 *                            Filter top-level `nodegroups`, `workloads`
 *                            and `recommendations` to that environment.
 *   - `filters.nodegroup` → keep only nodegroups with the given name.
 *                            Filter workloads and recommendations to those
 *                            attributed to that nodegroup.
 *   - `filters.squad`     → keep only that squad. Filter workloads and
 *                            recommendations to that squad.
 *
 * Invariants preserved by construction (validated by Property 12,
 * task 6.2):
 *
 *   - **Identity**: `applyFilters(r, {})` returns `r` itself
 *     (reference-equal; therefore structurally equal).
 *   - **Idempotent**:
 *     `applyFilters(applyFilters(r, f), f)` is deep-equal to
 *     `applyFilters(r, f)`. Since each filter is a projection on
 *     primitive fields, applying it a second time is a no-op on already
 *     matching items.
 *   - **Commutative between dimensions**: applying env then nodegroup is
 *     deep-equal to applying nodegroup then env (and any combination
 *     thereof). Filters are independent primitive-field predicates, so
 *     the intersection they define is order-independent.
 *
 * After filtering, `environments` is recomputed via
 * {@link aggregateEnvironments} from the filtered nodegroups so per-env
 * totals stay consistent with their filtered nested nodegroups; top-level
 * totals are recomputed accordingly.
 *
 * The function is total: it never throws and never returns `undefined`.
 *
 * @param response Fully-composed response to filter.
 * @param filters  Server-side filters (each dimension optional).
 * @returns A new response with filtered collections and recomputed totals.
 *          Reference-equal to `response` when `filters` is fully empty.
 */
export function applyFilters(
  response: AllocationResponse,
  filters: Filters,
): AllocationResponse {
  const { env, nodegroup, squad } = filters;
  if (!env && !nodegroup && !squad) {
    // Identity: `applyFilters(r, {}) === r` (design §Backend > index.ts).
    // Returning the same reference is the strongest form of structural
    // equality and lets callers safely early-exit without a deep copy.
    return response;
  }

  const passesNg = (ng: Nodegroup): boolean =>
    (!env || ng.environment === env) &&
    (!nodegroup || ng.name === nodegroup);

  const passesWl = (w: Workload): boolean =>
    (!env || w.environment === env) &&
    (!nodegroup || w.nodegroup === nodegroup) &&
    (!squad || w.squad === squad);

  const passesRec = (r: Recommendation): boolean =>
    (!env || r.environment === env) &&
    (!nodegroup || r.nodegroup === nodegroup) &&
    (!squad || r.squad === squad);

  const filteredNodegroups = response.nodegroups.filter(passesNg);
  const filteredWorkloads = response.workloads.filter(passesWl);
  const filteredRecommendations = response.recommendations.filter(passesRec);
  // Recompute squads from the *filtered* workloads + recommendations, not
  // from the pre-filter estate: otherwise filtering by env or nodegroup
  // (without touching squad) would leave the KPI showing every squad
  // regardless of which subset of workloads is actually visible. We reuse
  // `aggregateSquadCost` — the same pure aggregator used to compose the
  // response initially — so the recomposition is deterministic and
  // preserves the pipeline's semantics (Requirements 6.1-6.4).
  const recomposedSquads = aggregateSquadCost(
    filteredWorkloads,
    filteredRecommendations,
  );
  const filteredSquads = squad
    ? recomposedSquads.filter((s) => s.name === squad)
    : recomposedSquads;

  // Recompose environments from the filtered top-level nodegroups so each
  // env's `monthlyCostEur`, `nodeCount`, `spotCount` and nested
  // `nodegroups[]` reflect the current view. Envs that keep no nodegroup
  // are dropped implicitly by the aggregator.
  const environments = aggregateEnvironments(filteredNodegroups);

  const totalMonthlyEur = round2(
    environments.reduce((s, e) => s + e.monthlyCostEur, 0),
  );
  const totalNodeCount = environments.reduce((s, e) => s + e.nodeCount, 0);
  const totalSpotCount = environments.reduce((s, e) => s + e.spotCount, 0);
  const totalSpotCoveragePct =
    totalNodeCount > 0
      ? roundPct1((totalSpotCount / totalNodeCount) * 100)
      : 0;
  const totalEstimatedSavingsEur = round2(
    filteredRecommendations.reduce((s, r) => s + r.estimatedSavingsEur, 0),
  );

  return {
    ...response,
    environments,
    nodegroups: filteredNodegroups,
    squads: filteredSquads,
    workloads: filteredWorkloads,
    recommendations: filteredRecommendations,
    totalMonthlyEur,
    totalNodeCount,
    totalSpotCoveragePct,
    totalEstimatedSavingsEur,
  };
}
