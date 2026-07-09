/**
 * EKS Cost Optimization — shared fast-check arbitraries and fixtures.
 *
 * Feature: eks-cost-optimization
 *
 * Generadores compartidos por los property-based tests de `src/lib/eks-cost/*`.
 * Todos producen valores en **unidades canónicas SI** (cores como `number`,
 * memoria como `bytes`) para casar con `types.ts`.
 *
 * Invariantes preservados por construcción (así los tests pueden asumirlos
 * sin volver a comprobarlos):
 *
 *   - `Nodegroup.spotCount <= Nodegroup.nodeCount`.
 *   - `Nodegroup.spotCoveragePct ∈ [0, 100]` (redondeado a 1 decimal).
 *   - `Nodegroup.avgNodeCostEur = monthlyCostEur / nodeCount` cuando
 *     `nodeCount > 0`, si no `0`.
 *   - `Nodegroup.excessNodes = Math.floor(overprovisioningEur / avgNodeCostEur)`
 *     cuando `avgNodeCostEur > 0`, si no `0`.
 *   - `Environment.spotCoveragePct ∈ [0, 100]` y coincide con
 *     `spotCount / nodeCount * 100` a 1 decimal.
 *   - `Environment.monthlyCostEur == Σ nodegroups[].monthlyCostEur` (± 0.01€ de
 *     redondeo, tolerancia usada en Property 2).
 *   - `AllocationResponse.totalMonthlyEur == Σ environments[].monthlyCostEur`
 *     (± 0.01€).
 *   - `AllocationResponse.totalNodeCount == Σ environments[].nodeCount`.
 *
 * _Requirements: 10.4_
 */

import * as fc from "fast-check";

import type {
  AllocationResponse,
  Environment,
  EnvironmentName,
  Filters,
  Nodegroup,
  Recommendation,
  RecommendationKind,
  Squad,
  Warning as EksWarning,
  WarningCode,
  Workload,
} from "@/lib/eks-cost/types";

/* ------------------------------------------------------------------ */
/*  Static catalogs                                                    */
/* ------------------------------------------------------------------ */

/** Portal-canonical environment names (mirror `types.ts`). */
export const ENVIRONMENT_NAMES: readonly EnvironmentName[] = [
  "dev",
  "uat",
  "prod",
  "tooling",
] as const;

/** Cluster physical name per environment. Fixed, so generators are consistent. */
const CLUSTER_BY_ENV: Record<EnvironmentName, string> = {
  dev: "dp-dev",
  uat: "dp-uat",
  prod: "dp-prod",
  tooling: "dp-tooling",
};

/** Nodegroup shortnames typical across the four EKS clusters. */
const NODEGROUP_NAMES: readonly string[] = [
  "main",
  "spot-4xl",
  "gpu",
  "batch",
  "system",
  "arm",
] as const;

/** Squad names typical of the portal + the mandatory fallback. */
const SQUAD_NAMES: readonly string[] = [
  "digital",
  "retail",
  "marktech",
  "data",
  "sre",
  "commerce",
  "backoffice",
  "sin asignar",
] as const;

/** Namespaces typical across dp-dev/uat/prod. */
const NAMESPACE_NAMES: readonly string[] = [
  "oms",
  "basket",
  "checkout",
  "payments",
  "customers",
  "products",
  "shipping",
  "loyalty",
  "auth",
  "marketplace",
  "core",
  "n8n",
  "argocd",
  "harbor",
] as const;

/** Warning codes (mirror `types.ts` union). */
const WARNING_CODES: readonly WarningCode[] = [
  "metrics-not-configured",
  "metrics-partial-fail",
  "vpa-missing",
  "no-nodegroup-label",
  "no-squad-label",
  "empty-window",
] as const;

/** Recommendation kinds (mirror `types.ts` union). */
const RECOMMENDATION_KINDS: readonly RecommendationKind[] = [
  "over-cpu",
  "over-mem",
  "under-cpu",
  "under-mem",
] as const;

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */

const round2 = (n: number): number => Math.round(n * 100) / 100;
const roundPct1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Local mirror of `RightsizingParams`. Will live in
 * `src/lib/eks-cost/rightsizing.ts` from task 5.1 onwards; kept here so that
 * `arbRightsizingParams` is usable in tests that predate that module.
 */
export interface RightsizingParams {
  headroomCpu: number;
  headroomMem: number;
  floorCpuPerPod: number;
  floorMemPerPod: number;
  savingsCapFraction: number;
  minUptimeMinutes: number;
  minMonthlyCostEur: number;
}

/* ------------------------------------------------------------------ */
/*  Reusable primitives                                                */
/* ------------------------------------------------------------------ */

/**
 * CPU quantity in canonical SI units (cores). Bounded to keep property tests
 * cheap and floating-point predictable; rounded to milicore precision.
 */
export const arbCoreCount: fc.Arbitrary<number> = fc
  .double({ min: 0, max: 64, noNaN: true, noDefaultInfinity: true })
  .map((v) => Math.round(v * 1000) / 1000);

/**
 * Memory quantity in canonical SI units (bytes). Bounded to 512 GiB — enough
 * for any single workload/nodegroup in the portal without overflowing 32-bit
 * ranges in downstream code.
 */
export const arbByteCount: fc.Arbitrary<number> = fc.integer({
  min: 0,
  max: 512 * 1024 * 1024 * 1024,
});

/** A canonical environment name (dev / uat / prod / tooling). */
export const arbEnvironmentName: fc.Arbitrary<EnvironmentName> =
  fc.constantFrom(...ENVIRONMENT_NAMES);

/** Recommendation kinds. */
export const arbRecommendationKind: fc.Arbitrary<RecommendationKind> =
  fc.constantFrom(...RECOMMENDATION_KINDS);

/** Warning codes. */
export const arbWarningCode: fc.Arbitrary<WarningCode> =
  fc.constantFrom(...WARNING_CODES);

const arbNodegroupName: fc.Arbitrary<string> = fc.constantFrom(...NODEGROUP_NAMES);
const arbSquadName: fc.Arbitrary<string> = fc.constantFrom(...SQUAD_NAMES);
const arbNamespaceName: fc.Arbitrary<string> = fc.constantFrom(...NAMESPACE_NAMES);

/** A workload name that is a safe lowercase slug (2-32 chars, ends alnum). */
const arbWorkloadName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
    fc.array(
      fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-".split("")),
      { minLength: 1, maxLength: 20 },
    ),
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
  )
  .map(([first, mid, last]) => `${first}${mid.join("")}${last}`);

/* ------------------------------------------------------------------ */
/*  Warning                                                            */
/* ------------------------------------------------------------------ */

/** A single machine-readable warning entry. */
export const arbWarning: fc.Arbitrary<EksWarning> = fc.record({
  code: arbWarningCode,
  message: fc.string({ minLength: 1, maxLength: 80 }),
  source: fc.constantFrom(
    "node-cost.fetchNodegroups",
    "node-cost.fetchWorkloads",
    "rightsizing.fetchRecommendations",
    "index.fetchEksCostSummary",
  ),
});

/* ------------------------------------------------------------------ */
/*  Nodegroup                                                          */
/* ------------------------------------------------------------------ */

/**
 * A single `Nodegroup` respecting all documented invariants:
 * `spotCount <= nodeCount`, `spotCoveragePct ∈ [0,100]`,
 * `avgNodeCostEur = monthlyCostEur / nodeCount` (or 0), and
 * `excessNodes = Math.floor(overprovisioningEur / avgNodeCostEur)` (or 0).
 */
export const arbNodegroup: fc.Arbitrary<Nodegroup> = fc
  .record({
    name: arbNodegroupName,
    environment: arbEnvironmentName,
    nodeCount: fc.integer({ min: 0, max: 40 }),
    spotFraction: fc.double({
      min: 0,
      max: 1,
      noNaN: true,
      noDefaultInfinity: true,
    }),
    rawMonthlyCost: fc.double({
      min: 0,
      max: 20_000,
      noNaN: true,
      noDefaultInfinity: true,
    }),
    overprovisioningFraction: fc.double({
      min: 0,
      max: 1,
      noNaN: true,
      noDefaultInfinity: true,
    }),
  })
  .map(
    ({
      name,
      environment,
      nodeCount,
      spotFraction,
      rawMonthlyCost,
      overprovisioningFraction,
    }): Nodegroup => {
      const cluster = CLUSTER_BY_ENV[environment];
      const spotCount = Math.floor(nodeCount * spotFraction);
      const spotCoveragePct =
        nodeCount > 0 ? roundPct1((spotCount / nodeCount) * 100) : 0;
      const monthlyCostEur = round2(rawMonthlyCost);
      const avgNodeCostEur =
        nodeCount > 0 ? monthlyCostEur / nodeCount : 0;
      const overprovisioningEur = round2(monthlyCostEur * overprovisioningFraction);
      const excessNodes =
        avgNodeCostEur > 0
          ? Math.floor(overprovisioningEur / avgNodeCostEur)
          : 0;
      return {
        name,
        cluster,
        environment,
        nodeCount,
        spotCount,
        spotCoveragePct,
        monthlyCostEur,
        avgNodeCostEur,
        overprovisioningEur,
        excessNodes,
      };
    },
  );

/* ------------------------------------------------------------------ */
/*  Environment                                                        */
/* ------------------------------------------------------------------ */

/**
 * A single `Environment` composed of 1..5 nodegroups, all belonging to the
 * same cluster. Totals are derived from the children so aggregation
 * properties hold with 0.01€ tolerance.
 */
export const arbEnvironment: fc.Arbitrary<Environment> = fc
  .record({
    name: arbEnvironmentName,
    nodegroups: fc.array(arbNodegroup, { minLength: 1, maxLength: 5 }),
  })
  .map(({ name, nodegroups: rawNgs }): Environment => {
    const cluster = CLUSTER_BY_ENV[name];
    // Re-home all nodegroups under the picked env/cluster and deduplicate
    // names within the env so aggregation is unambiguous.
    const seen = new Set<string>();
    const nodegroups: Nodegroup[] = [];
    for (let i = 0; i < rawNgs.length; i++) {
      const ng = rawNgs[i];
      let ngName = ng.name;
      if (seen.has(ngName)) {
        ngName = `${ng.name}-${i}`;
      }
      seen.add(ngName);
      nodegroups.push({ ...ng, name: ngName, cluster, environment: name });
    }
    const monthlyCostEur = round2(
      nodegroups.reduce((s, n) => s + n.monthlyCostEur, 0),
    );
    const nodeCount = nodegroups.reduce((s, n) => s + n.nodeCount, 0);
    const spotCount = nodegroups.reduce((s, n) => s + n.spotCount, 0);
    const spotCoveragePct =
      nodeCount > 0 ? roundPct1((spotCount / nodeCount) * 100) : 0;
    return {
      name,
      cluster,
      monthlyCostEur,
      nodeCount,
      spotCount,
      spotCoveragePct,
      nodegroups,
    };
  });

/* ------------------------------------------------------------------ */
/*  Workload                                                           */
/* ------------------------------------------------------------------ */

/**
 * A single `Workload` with internally consistent CPU/memory values and a
 * non-negative monthly cost. Does not enforce cross-object consistency with
 * `Environment` / `Nodegroup` — tests that need that composition build it
 * explicitly via `arbAllocationResponse`.
 */
export const arbWorkload: fc.Arbitrary<Workload> = fc
  .record({
    environment: arbEnvironmentName,
    namespace: arbNamespaceName,
    workload: arbWorkloadName,
    nodegroup: arbNodegroupName,
    squad: arbSquadName,
    podCount: fc.integer({ min: 1, max: 200 }),
    cpuRequestCores: arbCoreCount,
    cpuUsageP95Cores: arbCoreCount,
    memRequestBytes: arbByteCount,
    memUsageP95Bytes: arbByteCount,
    rawMonthlyCost: fc.double({
      min: 0,
      max: 5_000,
      noNaN: true,
      noDefaultInfinity: true,
    }),
  })
  .map(
    ({
      environment,
      namespace,
      workload,
      nodegroup,
      squad,
      podCount,
      cpuRequestCores,
      cpuUsageP95Cores,
      memRequestBytes,
      memUsageP95Bytes,
      rawMonthlyCost,
    }): Workload => ({
      cluster: CLUSTER_BY_ENV[environment],
      environment,
      namespace,
      workload,
      nodegroup,
      squad,
      podCount,
      cpuRequestCores,
      memRequestBytes,
      cpuUsageP95Cores,
      memUsageP95Bytes,
      monthlyCostEur: round2(rawMonthlyCost),
    }),
  );

/* ------------------------------------------------------------------ */
/*  Squad aggregate                                                    */
/* ------------------------------------------------------------------ */

/** A single `Squad` row (aggregated result, not workload-level). */
export const arbSquad: fc.Arbitrary<Squad> = fc
  .record({
    name: arbSquadName,
    workloadCount: fc.integer({ min: 0, max: 200 }),
    rawMonthlyCost: fc.double({
      min: 0,
      max: 30_000,
      noNaN: true,
      noDefaultInfinity: true,
    }),
    overprovisioningFraction: fc.double({
      min: 0,
      max: 1,
      noNaN: true,
      noDefaultInfinity: true,
    }),
  })
  .map(
    ({ name, workloadCount, rawMonthlyCost, overprovisioningFraction }): Squad => {
      const monthlyCostEur = round2(rawMonthlyCost);
      return {
        name,
        monthlyCostEur,
        workloadCount,
        overprovisioningEur: round2(monthlyCostEur * overprovisioningFraction),
      };
    },
  );

/* ------------------------------------------------------------------ */
/*  Recommendation                                                     */
/* ------------------------------------------------------------------ */

const buildResourceValue = (kind: RecommendationKind, value: number): {
  value: number;
  k8s: string;
} => {
  const isCpu = kind === "over-cpu" || kind === "under-cpu";
  if (isCpu) {
    // Render as milicores (rounded up) when <1 core, else as decimal cores.
    if (value < 1) {
      const milli = Math.max(1, Math.ceil(value * 1000));
      return { value: milli / 1000, k8s: `${milli}m` };
    }
    const cores = Math.max(1, Math.ceil(value));
    return { value: cores, k8s: `${cores}` };
  }
  // Memory: pick Mi step of 16 under 1 GiB, otherwise Gi with 1 decimal.
  if (value < 1024 * 1024 * 1024) {
    const mi = Math.max(16, Math.ceil(value / (1024 * 1024) / 16) * 16);
    return { value: mi * 1024 * 1024, k8s: `${mi}Mi` };
  }
  const gi = Math.max(0.1, Math.ceil((value / (1024 * 1024 * 1024)) * 10) / 10);
  return { value: gi * 1024 * 1024 * 1024, k8s: `${gi}Gi` };
};

/**
 * A single `Recommendation`. Invariants preserved:
 *   - `estimatedSavingsEur >= 0` and `== 0` for `under-*` kinds.
 *   - `estimatedSavingsEur` never exceeds the 70% cap the design applies
 *     (Property 9 / Requirement 5.2). Since Recommendation does not carry the
 *     workload's monthly cost, we bound raw savings to a modest range.
 *   - `unitYamlBlock` always contains `requests.cpu`, `requests.memory` and
 *     `limits.memory` and never `limits.cpu`.
 */
export const arbRecommendation: fc.Arbitrary<Recommendation> = fc
  .record({
    environment: arbEnvironmentName,
    namespace: arbNamespaceName,
    workload: arbWorkloadName,
    nodegroup: arbNodegroupName,
    squad: arbSquadName,
    kind: arbRecommendationKind,
    currentCpuCores: arbCoreCount,
    targetCpuCores: arbCoreCount,
    currentMemBytes: arbByteCount,
    targetMemBytes: arbByteCount,
    rawSavings: fc.double({
      min: 0,
      max: 5_000,
      noNaN: true,
      noDefaultInfinity: true,
    }),
  })
  .map(
    ({
      environment,
      namespace,
      workload,
      nodegroup,
      squad,
      kind,
      currentCpuCores,
      targetCpuCores,
      currentMemBytes,
      targetMemBytes,
      rawSavings,
    }): Recommendation => {
      const isCpu = kind === "over-cpu" || kind === "under-cpu";
      const isOver = kind === "over-cpu" || kind === "over-mem";
      const currentSource = isCpu ? currentCpuCores : currentMemBytes;
      const targetSource = isCpu ? targetCpuCores : targetMemBytes;
      const currentRequest = buildResourceValue(kind, currentSource);
      const recommendedRequest = buildResourceValue(kind, targetSource);
      const estimatedSavingsEur = isOver ? round2(rawSavings) : 0;
      // Build a YAML block that always exposes requests.cpu/mem and limits.mem.
      const cpuReq = isCpu
        ? recommendedRequest.k8s
        : buildResourceValue("over-cpu", currentCpuCores).k8s;
      const memReq = isCpu
        ? buildResourceValue("over-mem", currentMemBytes).k8s
        : recommendedRequest.k8s;
      const unitYamlBlock = [
        `# EKS Cost recommendation for ${namespace}/${workload}`,
        `# reason: ${kind}`,
        `resources:`,
        `  requests:`,
        `    cpu: "${cpuReq}"`,
        `    memory: "${memReq}"`,
        `  limits:`,
        `    memory: "${memReq}"`,
      ].join("\n");
      return {
        cluster: CLUSTER_BY_ENV[environment],
        environment,
        namespace,
        workload,
        nodegroup,
        squad,
        kind,
        currentRequest,
        recommendedRequest,
        estimatedSavingsEur,
        unitYamlBlock,
        reason: `${kind} (${isCpu ? "cpu" : "memory"})`,
      };
    },
  );

/* ------------------------------------------------------------------ */
/*  AllocationResponse                                                 */
/* ------------------------------------------------------------------ */

/**
 * A full `AllocationResponse`. Cross-section totals are derived from the
 * generated environments so aggregation properties hold. Workloads,
 * recommendations, squads and warnings are produced independently: consumers
 * that need cross-object consistency (e.g. squad totals matching workload
 * cost) build that manually in their own test.
 */
export const arbAllocationResponse: fc.Arbitrary<AllocationResponse> = fc
  .record({
    generatedAtMs: fc.integer({
      min: Date.UTC(2024, 0, 1),
      max: Date.UTC(2030, 11, 31),
    }),
    environments: fc.array(arbEnvironment, { minLength: 1, maxLength: 4 }),
    squads: fc.array(arbSquad, { minLength: 0, maxLength: 8 }),
    workloads: fc.array(arbWorkload, { minLength: 0, maxLength: 50 }),
    recommendations: fc.array(arbRecommendation, { minLength: 0, maxLength: 50 }),
    warnings: fc.array(arbWarning, { minLength: 0, maxLength: 6 }),
    rawSavings: fc.double({
      min: 0,
      max: 100_000,
      noNaN: true,
      noDefaultInfinity: true,
    }),
  })
  .map(
    ({
      generatedAtMs,
      environments: rawEnvs,
      squads,
      workloads,
      recommendations,
      warnings,
      rawSavings,
    }): AllocationResponse => {
      // Deduplicate environments by name; keep the first occurrence.
      const byName = new Map<EnvironmentName, Environment>();
      for (const env of rawEnvs) {
        if (!byName.has(env.name)) {
          byName.set(env.name, env);
        }
      }
      const environments = Array.from(byName.values());
      const nodegroups: Nodegroup[] = environments.flatMap((e) => e.nodegroups);
      const totalMonthlyEur = round2(
        environments.reduce((s, e) => s + e.monthlyCostEur, 0),
      );
      const totalNodeCount = environments.reduce((s, e) => s + e.nodeCount, 0);
      const totalSpotCount = environments.reduce((s, e) => s + e.spotCount, 0);
      const totalSpotCoveragePct =
        totalNodeCount > 0
          ? roundPct1((totalSpotCount / totalNodeCount) * 100)
          : 0;
      return {
        generatedAt: new Date(generatedAtMs).toISOString(),
        totalMonthlyEur,
        totalNodeCount,
        totalSpotCoveragePct,
        totalEstimatedSavingsEur: round2(rawSavings),
        environments,
        nodegroups,
        squads,
        workloads,
        recommendations,
        warnings,
      };
    },
  );

/* ------------------------------------------------------------------ */
/*  RightsizingParams                                                  */
/* ------------------------------------------------------------------ */

/**
 * `RightsizingParams` around the documented defaults (`headroomCpu=0.5`,
 * `headroomMem=0.7`, `floorCpuPerPod=0.1`, `floorMemPerPod=128Mi`,
 * `savingsCapFraction=0.7`, `minUptimeMinutes=60`, `minMonthlyCostEur=10`).
 * Ranges are wide enough to stress fractional and boundary behaviour while
 * remaining physically meaningful.
 */
export const arbRightsizingParams: fc.Arbitrary<RightsizingParams> = fc.record({
  headroomCpu: fc
    .double({ min: 0.1, max: 1, noNaN: true, noDefaultInfinity: true })
    .map((v) => Math.round(v * 100) / 100),
  headroomMem: fc
    .double({ min: 0.1, max: 1, noNaN: true, noDefaultInfinity: true })
    .map((v) => Math.round(v * 100) / 100),
  floorCpuPerPod: fc
    .double({ min: 0.01, max: 1, noNaN: true, noDefaultInfinity: true })
    .map((v) => Math.round(v * 1000) / 1000),
  floorMemPerPod: fc.integer({
    min: 16 * 1024 * 1024,
    max: 2 * 1024 * 1024 * 1024,
  }),
  savingsCapFraction: fc
    .double({ min: 0.1, max: 1, noNaN: true, noDefaultInfinity: true })
    .map((v) => Math.round(v * 100) / 100),
  minUptimeMinutes: fc.integer({ min: 0, max: 240 }),
  minMonthlyCostEur: fc
    .double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true })
    .map((v) => Math.round(v * 100) / 100),
});

/* ------------------------------------------------------------------ */
/*  Filters                                                            */
/* ------------------------------------------------------------------ */

/**
 * Server-side `Filters`. Each dimension may be undefined (no restriction) or
 * pick from the same catalogs used by the aggregates so filter application
 * tests can find matches.
 */
export const arbFilters: fc.Arbitrary<Filters> = fc.record({
  env: fc.option(arbEnvironmentName, { nil: undefined }),
  nodegroup: fc.option(arbNodegroupName, { nil: undefined }),
  squad: fc.option(arbSquadName, { nil: undefined }),
}) as fc.Arbitrary<Filters>;
