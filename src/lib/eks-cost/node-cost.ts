/**
 * Node Cost Service — scaffolding for the EKS Cost Optimization backend.
 *
 * This module orchestrates the "node is the unit of cost" pipeline:
 *
 *   1. Fetch nodegroup-level metrics from Grafana Cloud (task 4.8).
 *   2. Fetch workload-level metrics and attribute them to nodegroups (task 4.8).
 *   3. Aggregate cost by environment / nodegroup / squad (task 4.3).
 *
 * All external dependencies live behind `NodeCostContext` so that pure
 * aggregators and property tests can inject deterministic fakes.
 *
 * Only the shared context type + hour/month conversion helpers land in this
 * scaffolding task (task 4.1). Aggregators (task 4.3) and Grafana fetchers
 * (task 4.8) are added by later tasks in the same phase.
 *
 * See:
 *   - `.kiro/specs/eks-cost-optimization/design.md` §Backend > node-cost.ts
 *   - `.kiro/specs/eks-cost-optimization/tasks.md` §Fase 1 > task 4
 *   - Requirement 1.3 (Monthly cost = hourly cost × 730)
 */

import { GrafanaMetricsClient } from "@/lib/grafana-metrics";

/**
 * Convention across all cloud FinOps tooling in the portal: monthly cost is
 * projected as `hourly cost × 730` (30 days average, aligned with AWS,
 * OpenCost and the rest of the FinOps stack). See Requirement 1.3.
 */
export const HOURS_PER_MONTH = 730;

/**
 * Default USD → EUR conversion rate. Documented as approximate; the goal of
 * the dashboard is order of magnitude and trend, not billing accuracy. See
 * `EKS_USD_EUR_RATE` in the design doc.
 */
export const DEFAULT_USD_TO_EUR = 0.92;

/**
 * Shared execution context threaded through every node-cost function.
 *
 * Making the metrics client, conversion rate, hours-per-month and clock
 * injectable keeps the aggregators pure and lets property tests exercise
 * them without touching Grafana or the wall clock.
 */
export interface NodeCostContext {
  /** Injectable Grafana metrics client — enables mocks in unit / property tests. */
  metrics: GrafanaMetricsClient;
  /** USD → EUR conversion rate. Default: {@link DEFAULT_USD_TO_EUR}. */
  usdToEur: number;
  /** Hours per month for cost projection. Default: {@link HOURS_PER_MONTH}. */
  hoursPerMonth: number;
  /** Clock. Default: `() => new Date()`. */
  now: () => Date;
}

/**
 * Convert an hourly cost to a monthly projection using {@link HOURS_PER_MONTH}.
 *
 * Pure and total: preserves the sign and the special values of the input
 * (including `NaN` / `Infinity`) so callers can decide how to sanitise
 * upstream data. Validates Requirement 1.3.
 *
 * @param hourlyCost Cost per hour in any currency (typically EUR after USD conversion).
 * @returns Cost projected over one month (`hourlyCost × 730`).
 */
export function hourlyToMonthly(hourlyCost: number): number {
  return hourlyCost * HOURS_PER_MONTH;
}
/* ------------------------------------------------------------------ */
/*  Pure aggregators (task 4.3)                                        */
/* ------------------------------------------------------------------ */

import type {
  Environment,
  EnvironmentName,
  Nodegroup,
  Recommendation,
  Squad,
  Warning as EksWarning,
  Workload,
} from "@/lib/eks-cost/types";

/**
 * Cluster physical name per portal-canonical environment. Kept aligned with
 * the EKS cluster catalog (dp-dev, dp-uat, dp-prod, dp-tooling); no runtime
 * lookup so the aggregators stay pure and total.
 *
 * NOTE: the production cluster is named `dp-prd` in the EKS ARN but the
 * `k8s_cluster_name` label emitted by kube-state-metrics / OpenCost in
 * Grafana Cloud is `dp-prod` (verified with `/api/v1/label/…/values`).
 * This constant carries the label value (what we see in the metric stream),
 * not the ARN name.
 */
const CLUSTER_BY_ENV: Record<EnvironmentName, string> = {
  dev: "dp-dev",
  uat: "dp-uat",
  prod: "dp-prod",
  tooling: "dp-tooling",
};

/** Round a monetary EUR value to 2 decimals. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Round a percentage to 1 decimal. */
const roundPct1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Normalize a pod name to its parent workload identity so downstream layers
 * (VPA join, recommendation grouping) collapse the N pods of a
 * Deployment / StatefulSet / DaemonSet into a single row.
 *
 * Handles the three common shapes emitted by Kubernetes:
 *   - Deployment:   `<workload>-<rs-hash-10c>-<pod-hash-5c>`
 *                   e.g. `oms-orders-api-7b9f4c8dd6-abc12`
 *                     → `oms-orders-api`
 *   - StatefulSet:  `<workload>-<ordinal>`
 *                   e.g. `sonarqube-sonarqube-0` → `sonarqube-sonarqube`
 *   - DaemonSet /
 *     controller-revision: `<workload>-<pod-hash-5c>`
 *                   e.g. `ksm-vpa-5f8bfcbb78-wzr7t` → `ksm-vpa`
 *
 * Rules of the strip (right-to-left, greedy but bounded):
 *   1. If the last segment matches `^[0-9]+$` (StatefulSet ordinal), strip it.
 *   2. Else, if the last segment matches `^[a-z0-9]{5}$` (pod-hash), strip it.
 *   3. Then, if the next-to-last segment matches `^[a-z0-9]{9,10}$`
 *      (ReplicaSet controller-revision hash), strip it too.
 *
 * All three steps are conservative: they only strip when the shape matches,
 * so a legitimately-named workload like `oms-orders-api` (no ReplicaSet
 * suffix) stays intact. Not perfect (a Deployment named `myapp-abcde` with
 * only one ordinal-shaped segment could be over-stripped) but matches the
 * heuristics used elsewhere in the portal (`mr-metrics-snapshot`, DORA
 * deployment correlation) with the same trade-off.
 *
 * Pure and total.
 */
export function normalizeWorkloadName(pod: string): string {
  if (!pod) return pod;
  const parts = pod.split("-");
  if (parts.length < 2) return pod;
  let end = parts.length;
  const last = parts[end - 1];
  if (/^[0-9]+$/.test(last)) {
    end -= 1;
  } else if (/^[a-z0-9]{5}$/.test(last)) {
    end -= 1;
    const prev = parts[end - 1];
    if (prev && /^[a-z0-9]{9,10}$/.test(prev)) {
      end -= 1;
    }
  }
  const normalized = parts.slice(0, end).join("-");
  return normalized || pod;
}

/**
 * Canonical namespace → squad mapping for the IskayPet EKS estate.
 *
 * The 4 clusters run ~30 distinct namespaces (see `.kiro/steering/portal-architecture.md`
 * §1 and §16). Most of them do NOT carry an explicit `owner` / `squad` /
 * `team` label on their pods, so `resolveSquad` falls back to a static
 * mapping to attribute cost to the right team.
 *
 * Groups (aligned with the AppSet catalogue in steering §16):
 *
 *   - **Digital**  — the ecommerce backend + apis: oms, basket, checkout,
 *     payments, loyalty, customers, products, pricing, shipping, returns,
 *     stores, marketplace, auth, identifiers, mobile, core,
 *     business-monitoring, animalis, websites (+ front-vue / vue-ssr).
 *   - **Retail**   — Comerzzia POS integration: czz, comerzzia and its
 *     workers.
 *   - **MarTech**  — Helios advertising / marketing stack.
 *   - **Data**     — data-science + data-apis (Bedrock / ML tooling).
 *   - **SRE**      — everything cluster-wide (kube-system, argocd,
 *     ingress-nginx, monitoring, harbor, sonarqube, external-secrets,
 *     gatekeeper, keda, cloud-agent, cert-manager, awx-ansible,
 *     gitlab-runner, dependencytrack, n8n, platformportal, tech-radar,
 *     synthetic-monitoring, k6-* and the AWS load-balancer / k8sgpt
 *     operators). These are shared platform namespaces — their cost
 *     bubbles up under a single SRE squad row instead of showing 20
 *     independent bars.
 *
 * Namespaces not present in the map fall through to the raw namespace
 * (never "sre") so a brand-new product namespace is still visible in the
 * dashboard while somebody classifies it here.
 */
const NAMESPACE_TO_SQUAD: Readonly<Record<string, string>> = Object.freeze({
  // ── Digital (ecommerce backend + apis) ─────────────────────────────
  animalis: "digital",
  auth: "digital",
  "auth-test": "digital",
  basket: "digital",
  "business-monitoring": "digital",
  checkout: "digital",
  ciao: "digital",
  core: "digital",
  customers: "digital",
  "front-vue": "digital",
  identifiers: "digital",
  loyalty: "digital",
  marketplace: "digital",
  mobile: "digital",
  nominatim: "digital",
  oms: "digital",
  payments: "digital",
  pricing: "digital",
  products: "digital",
  returns: "digital",
  shipping: "digital",
  stores: "digital",
  "vue-ssr": "digital",
  websites: "digital",

  // ── Retail (Comerzzia POS integration) ──────────────────────────────
  comerzzia: "retail",
  "comerzzia-workers": "retail",
  "comerzzia-czz": "retail",
  czz: "retail",
  "czz-proxysql": "retail",

  // ── MarTech (Helios) ─────────────────────────────────────────────────
  helios: "martech",

  // ── Data (data-science + data-apis) ──────────────────────────────────
  "data-science": "data",
  "data-apis": "data",

  // ── SRE / Platform (shared cluster-wide services) ────────────────────
  argo: "sre",
  argocd: "sre",
  "aws-load-balancer-controller": "sre",
  "awx-ansible": "sre",
  "cert-manager": "sre",
  "cloud-agent": "sre",
  crossplane: "sre",
  dependencytrack: "sre",
  "external-dns": "sre",
  "external-secrets": "sre",
  "flux-system": "sre",
  "gatekeeper-system": "sre",
  "gitlab-runner": "sre",
  grafana: "sre",
  harbor: "sre",
  "ingress-nginx": "sre",
  "istio-system": "sre",
  "k6-operator-system": "sre",
  "k6-tests": "sre",
  "k8sgpt-operator-system": "sre",
  keda: "sre",
  "kube-node-lease": "sre",
  "kube-public": "sre",
  "kube-system": "sre",
  logging: "sre",
  mattermost: "sre",
  monitoring: "sre",
  "mount-s3": "sre",
  n8n: "sre",
  "nfs-provisioner": "sre",
  "pact-broker": "sre",
  platformportal: "sre",
  prometheus: "sre",
  promtail: "sre",
  sonarqube: "sre",
  "synthetic-monitoring": "sre",
  "tech-radar": "sre",
  vault: "sre",
  waman: "sre",
});

/**
 * Resolve the nodegroup name from a Prometheus label bag. Priority:
 *
 *   1. `label_eks_amazonaws_com_nodegroup` (kube-state-metrics label prefix).
 *   2. `eks_amazonaws_com_nodegroup` (canonical Prometheus form of the EKS label).
 *   3. `label_eks.amazonaws.com/nodegroup` / `eks.amazonaws.com/nodegroup`
 *      (raw Kubernetes label name — accepted for flexibility).
 *   4. `nodegroup` (short custom label).
 *   5. `"unknown"` fallback.
 *
 * Returns the first non-empty match. Pure and total.
 */
export function resolveNodegroup(nodeLabels: Record<string, string>): string {
  return (
    nodeLabels["label_eks_amazonaws_com_nodegroup"] ||
    nodeLabels["eks_amazonaws_com_nodegroup"] ||
    nodeLabels["label_eks.amazonaws.com/nodegroup"] ||
    nodeLabels["eks.amazonaws.com/nodegroup"] ||
    nodeLabels["nodegroup"] ||
    "unknown"
  );
}

/**
 * Resolve the owning squad for a workload from a pod label bag and its
 * namespace. Priority:
 *
 *   1. Explicit `owner` / `squad` / `team` label on the pod (always wins).
 *   2. Namespace lookup in {@link NAMESPACE_TO_SQUAD} (canonical mapping —
 *      digital / retail / marktech / data / sre for platform namespaces).
 *   3. Raw namespace (so unknown workloads stay visible instead of getting
 *      lumped into "sre" — that is the bug we fixed after the first pass).
 *   4. `"sin asignar"` when nothing else is available.
 *
 * Pure and total; empty strings are treated as absent so downstream
 * aggregation groups them under the fallback.
 */
export function resolveSquad(
  podLabels: Record<string, string>,
  namespace: string,
): string {
  const explicit =
    podLabels["owner"] || podLabels["squad"] || podLabels["team"];
  if (explicit) return explicit;
  if (namespace) {
    const mapped = NAMESPACE_TO_SQUAD[namespace];
    if (mapped) return mapped;
    return namespace;
  }
  return "sin asignar";
}

/**
 * Compute `excessNodes` for a `Nodegroup` as `floor(overprovisioningEur /
 * avgNodeCostEur)` when `avgNodeCostEur > 0`, else 0. Validates Property 10
 * / Requirement 5.5 (the "N nodos de más" figure shown next to the nodegroup
 * breakdown chart).
 */
export function computeExcessNodes(ng: Nodegroup): number {
  if (ng.avgNodeCostEur <= 0) {
    return 0;
  }
  return Math.floor(ng.overprovisioningEur / ng.avgNodeCostEur);
}

/**
 * Group nodegroups by environment and derive the per-environment totals.
 *
 * - `cluster` is resolved from the environment name via {@link CLUSTER_BY_ENV}
 *   so the output is stable even if the input nodegroups carry inconsistent
 *   cluster labels (defensive against upstream data errors).
 * - `monthlyCostEur`, `nodeCount`, `spotCount` are simple sums; the monetary
 *   sum is rounded to 2 decimals (Property 2 tolerance: 0.01€).
 * - `spotCoveragePct` is `(spotCount / nodeCount) * 100` rounded to 1
 *   decimal, or `0` when `nodeCount === 0`. Guaranteed `∈ [0, 100]` because
 *   `spotCount <= nodeCount` by invariant of the `Nodegroup` type.
 * - `nodegroups[]` preserves input order within each environment.
 *
 * Validates Requirements 1.2, 1.4, 1.5, 1.6.
 */
export function aggregateEnvironments(nodegroups: Nodegroup[]): Environment[] {
  const byEnv = new Map<EnvironmentName, Nodegroup[]>();
  for (const ng of nodegroups) {
    const list = byEnv.get(ng.environment);
    if (list) {
      list.push(ng);
    } else {
      byEnv.set(ng.environment, [ng]);
    }
  }
  const result: Environment[] = [];
  for (const [name, ngs] of byEnv.entries()) {
    const cluster = CLUSTER_BY_ENV[name];
    const monthlyCostEur = round2(
      ngs.reduce((sum, ng) => sum + ng.monthlyCostEur, 0),
    );
    const nodeCount = ngs.reduce((sum, ng) => sum + ng.nodeCount, 0);
    const spotCount = ngs.reduce((sum, ng) => sum + ng.spotCount, 0);
    const spotCoveragePct =
      nodeCount > 0 ? roundPct1((spotCount / nodeCount) * 100) : 0;
    result.push({
      name,
      cluster,
      monthlyCostEur,
      nodeCount,
      spotCount,
      spotCoveragePct,
      nodegroups: ngs,
    });
  }
  return result;
}

/**
 * Attribute workloads to their dominant nodegroup and surface warnings for
 * data-quality issues. Pure and total — never throws.
 *
 * The returned map is keyed by `"<cluster>/<nodegroup>"` so cross-cluster
 * nodegroup name collisions (e.g. `main` in dp-dev vs dp-prd) do not merge.
 *
 * Semantics:
 *
 * - Workloads whose `nodegroup === "unknown"` are excluded from the map and
 *   trigger a single aggregated `no-nodegroup-label` warning (Requirement
 *   2.1 — costs we can't attribute are visible, not silently dropped).
 * - The conservative cap `sum(w.monthlyCostEur) <= ng.monthlyCostEur` is
 *   enforced as a **property** (Property 4). When exceeded, a
 *   `metrics-partial-fail` warning is emitted per offending nodegroup;
 *   cost values are **never mutated** — the aggregator only reports.
 *
 * @param workloads Attributed workloads (their `nodegroup` field is the
 *   resolved short name, e.g. `"main"`).
 * @param nodegroups Cluster-scoped nodegroups; used to enforce the cost cap.
 */
export function attributeWorkloadCostToNodegroup(
  workloads: Workload[],
  nodegroups: Nodegroup[],
): { workloadsByNodegroup: Map<string, Workload[]>; warnings: EksWarning[] } {
  const workloadsByNodegroup = new Map<string, Workload[]>();
  const warnings: EksWarning[] = [];

  const nodegroupByKey = new Map<string, Nodegroup>();
  for (const ng of nodegroups) {
    nodegroupByKey.set(`${ng.cluster}/${ng.name}`, ng);
  }

  let unknownCount = 0;
  for (const w of workloads) {
    if (!w.nodegroup || w.nodegroup === "unknown") {
      unknownCount++;
      continue;
    }
    const key = `${w.cluster}/${w.nodegroup}`;
    const list = workloadsByNodegroup.get(key);
    if (list) {
      list.push(w);
    } else {
      workloadsByNodegroup.set(key, [w]);
    }
  }

  for (const [key, ws] of workloadsByNodegroup.entries()) {
    const ng = nodegroupByKey.get(key);
    if (!ng) {
      continue;
    }
    const total = ws.reduce((sum, w) => sum + w.monthlyCostEur, 0);
    if (total > ng.monthlyCostEur) {
      warnings.push({
        code: "metrics-partial-fail",
        message: `Workload cost attribution (${round2(total)}€) exceeded nodegroup cost (${round2(ng.monthlyCostEur)}€) for ${key}`,
        source: "node-cost.attributeWorkloadCostToNodegroup",
      });
    }
  }

  if (unknownCount > 0) {
    warnings.push({
      code: "no-nodegroup-label",
      message: `${unknownCount} workload${unknownCount === 1 ? "" : "s"} without a resolvable nodegroup label`,
      source: "node-cost.attributeWorkloadCostToNodegroup",
    });
  }

  return { workloadsByNodegroup, warnings };
}

/**
 * Aggregate workload cost by squad and attribute `over-*` savings from the
 * companion recommendations set.
 *
 * - Every workload contributes to exactly one squad row (its `squad` field,
 *   which is the pre-resolved output of {@link resolveSquad}). Falsy/empty
 *   squad values fall back to `"sin asignar"` so we never drop cost.
 * - `overprovisioningEur` sums `estimatedSavingsEur` of recommendations
 *   whose `kind` starts with `over-` and whose `squad` matches. `under-*`
 *   recommendations carry no savings and are ignored (Requirement 5.4).
 * - Result is ordered DESC by `monthlyCostEur`; ties keep insertion order
 *   (stable sort in modern V8).
 *
 * Validates Requirements 2.2, 2.3, 2.4, 5.4.
 */
export function aggregateSquadCost(
  workloads: Workload[],
  recommendations: Recommendation[],
): Squad[] {
  interface Bucket {
    workloadCostTotal: number;
    workloadCount: number;
    overprovisioningEur: number;
  }
  const bySquad = new Map<string, Bucket>();
  const bucketFor = (name: string): Bucket => {
    let bucket = bySquad.get(name);
    if (!bucket) {
      bucket = { workloadCostTotal: 0, workloadCount: 0, overprovisioningEur: 0 };
      bySquad.set(name, bucket);
    }
    return bucket;
  };

  for (const w of workloads) {
    const name = w.squad || "sin asignar";
    const bucket = bucketFor(name);
    bucket.workloadCostTotal += w.monthlyCostEur;
    bucket.workloadCount += 1;
  }

  for (const r of recommendations) {
    if (!r.kind.startsWith("over-")) {
      continue;
    }
    const name = r.squad || "sin asignar";
    const bucket = bucketFor(name);
    bucket.overprovisioningEur += r.estimatedSavingsEur;
  }

  const squads: Squad[] = [];
  for (const [name, bucket] of bySquad.entries()) {
    squads.push({
      name,
      monthlyCostEur: round2(bucket.workloadCostTotal),
      workloadCount: bucket.workloadCount,
      overprovisioningEur: round2(bucket.overprovisioningEur),
    });
  }
  squads.sort((a, b) => b.monthlyCostEur - a.monthlyCostEur);
  return squads;
}

/* ------------------------------------------------------------------ */
/*  Grafana fetchers (task 4.8)                                        */
/* ------------------------------------------------------------------ */

import type { PrometheusVectorResult } from "@/lib/grafana-metrics";
import {
  qNodeCostHourly,
  qNodeCount,
  qSpotCount,
  qWorkloadCost,
  qWorkloadRequests,
  qWorkloadUsageP95,
  qNodegroupByNode,
  qPodToNode,
} from "@/lib/eks-cost/promql";

/**
 * Reverse of {@link CLUSTER_BY_ENV}: cluster physical name → canonical
 * environment name. Cluster labels not present here are treated as a data
 * quality issue upstream and their series are dropped with an aggregated
 * warning (never merged into a bogus environment).
 *
 * Includes both `dp-prd` (EKS ARN name) and `dp-prod` (Grafana Cloud label
 * value) so the pipeline stays robust regardless of which convention the
 * upstream metric adopts. `<aggregated>` — a Grafana-Cloud meta series that
 * shows up on the label values endpoint — is deliberately absent so we
 * discard it as noise.
 */
const ENV_BY_CLUSTER: Record<string, EnvironmentName> = {
  "dp-dev": "dev",
  "dp-uat": "uat",
  "dp-prd": "prod",
  "dp-prod": "prod",
  "dp-tooling": "tooling",
};

/** Single Prometheus instant-vector sample (labels + [ts, "value"] tuple). */
type MetricRow = PrometheusVectorResult;

/** Parse the numeric value of a Prometheus vector sample. Total. */
function readValue(sample: MetricRow | undefined): number {
  if (!sample) return 0;
  const n = Number(sample.value?.[1] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Collapse whitespace and cap a query at 200 chars for structured logs. */
function shortSnippet(query: string): string {
  return query.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Run one PromQL query through the injected client. Translates any failure
 * into a `metrics-partial-fail` warning; never throws. Follows Requirement
 * 8.2 (individual query failures preserve other sections).
 *
 * We do not log tokens (the client keeps auth internal) nor the full
 * Grafana URL. The query snippet is capped at 200 chars.
 */
async function safeQuery(
  ctx: NodeCostContext,
  label: string,
  query: string,
  source: string,
  warnings: EksWarning[],
): Promise<MetricRow[]> {
  const started = Date.now();
  try {
    const { result } = await ctx.metrics.query(query);
    console.info(
      `[eks-cost] ${label} ok in ${Date.now() - started}ms rows=${result.length} :: ${shortSnippet(query)}`,
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[eks-cost] ${label} failed after ${Date.now() - started}ms: ${message.slice(0, 200)} :: ${shortSnippet(query)}`,
    );
    warnings.push({
      code: "metrics-partial-fail",
      message: `Query "${label}" failed: ${message.slice(0, 200)}`,
      source,
    });
    return [];
  }
}

/**
 * Fetch per-nodegroup cost, node count and spot count from Grafana Cloud
 * and assemble `Nodegroup[]` + `Environment[]`.
 *
 * Runs `qNodeCostHourly`, `qNodeCount` and `qSpotCount` in parallel; each
 * query has its own `.catch` so a partial failure emits a
 * `metrics-partial-fail` warning without failing the whole call
 * (Requirement 8.2).
 *
 * Joins the three result sets by `(k8s_cluster_name, nodegroup)`. For each
 * combination:
 *
 *   - `environment` comes from {@link ENV_BY_CLUSTER}. Unknown clusters
 *     are skipped and counted in an aggregated `no-nodegroup-label`
 *     warning.
 *   - `monthlyCostEur = hourly × ctx.hoursPerMonth × ctx.usdToEur`.
 *   - `avgNodeCostEur = monthlyCostEur / nodeCount` when `nodeCount > 0`.
 *   - `spotCoveragePct = round1((spotCount / nodeCount) × 100)`.
 *   - `overprovisioningEur` and `excessNodes` are 0 here; the rightsizing
 *     pipeline (task 5.11) populates them later.
 *
 * `environments` is computed via {@link aggregateEnvironments} so the
 * per-env totals are consistent with the pure aggregators (Property 2).
 */
export async function fetchNodegroups(ctx: NodeCostContext): Promise<{
  nodegroups: Nodegroup[];
  environments: Environment[];
  warnings: EksWarning[];
}> {
  const warnings: EksWarning[] = [];
  const source = "node-cost.fetchNodegroups";

  const [costRows, countRows, spotRows] = await Promise.all([
    safeQuery(ctx, "nodeCostHourly", qNodeCostHourly(), source, warnings),
    safeQuery(ctx, "nodeCount", qNodeCount(), source, warnings),
    safeQuery(ctx, "spotCount", qSpotCount(), source, warnings),
  ]);

  if (
    costRows.length === 0 &&
    countRows.length === 0 &&
    spotRows.length === 0
  ) {
    warnings.push({
      code: "empty-window",
      message: "No nodegroup metrics returned by any query",
      source,
    });
    return { nodegroups: [], environments: [], warnings };
  }

  const key = (r: MetricRow): string =>
    `${r.metric.k8s_cluster_name || ""}::${r.metric.nodegroup || ""}`;

  const costByKey = new Map<string, MetricRow>();
  const countByKey = new Map<string, MetricRow>();
  const spotByKey = new Map<string, MetricRow>();
  for (const r of costRows) costByKey.set(key(r), r);
  for (const r of countRows) countByKey.set(key(r), r);
  for (const r of spotRows) spotByKey.set(key(r), r);

  const allKeys = new Set<string>([
    ...costByKey.keys(),
    ...countByKey.keys(),
    ...spotByKey.keys(),
  ]);

  const nodegroups: Nodegroup[] = [];
  let unknownClusterCount = 0;
  let missingNodegroupLabel = 0;

  for (const k of allKeys) {
    const anchor = costByKey.get(k) || countByKey.get(k) || spotByKey.get(k);
    if (!anchor) continue;
    const cluster = anchor.metric.k8s_cluster_name;
    const ngName = anchor.metric.nodegroup;
    if (!cluster) continue;
    if (!ngName) {
      missingNodegroupLabel += 1;
      continue;
    }
    const environment = ENV_BY_CLUSTER[cluster];
    if (!environment) {
      unknownClusterCount += 1;
      continue;
    }
    const nodeCount = Math.max(0, Math.round(readValue(countByKey.get(k))));
    const spotCount = Math.min(
      nodeCount,
      Math.max(0, Math.round(readValue(spotByKey.get(k)))),
    );
    const monthlyCostEur =
      readValue(costByKey.get(k)) * ctx.hoursPerMonth * ctx.usdToEur;
    const monthlyRounded = round2(monthlyCostEur);
    const avgNodeCostEur =
      nodeCount > 0 ? round2(monthlyRounded / nodeCount) : 0;
    const spotCoveragePct =
      nodeCount > 0 ? roundPct1((spotCount / nodeCount) * 100) : 0;
    nodegroups.push({
      name: ngName,
      cluster,
      environment,
      nodeCount,
      spotCount,
      spotCoveragePct,
      monthlyCostEur: monthlyRounded,
      avgNodeCostEur,
      overprovisioningEur: 0,
      excessNodes: 0,
    });
  }

  if (missingNodegroupLabel > 0) {
    warnings.push({
      code: "no-nodegroup-label",
      message: `${missingNodegroupLabel} nodegroup metric series without a resolvable nodegroup label`,
      source,
    });
  }
  if (unknownClusterCount > 0) {
    warnings.push({
      code: "no-nodegroup-label",
      message: `${unknownClusterCount} nodegroup series from unknown clusters (expected dp-dev/uat/prod/tooling)`,
      source,
    });
  }

  const environments = aggregateEnvironments(nodegroups);
  return { nodegroups, environments, warnings };
}

/**
 * Fetch per-workload cost + resource requests + p95 usage and attribute
 * each workload to its dominant nodegroup.
 *
 * Runs 7 queries in parallel (each with its own `.catch`, same partial-fail
 * semantics as {@link fetchNodegroups}): workload cost for CPU and RAM,
 * requests for CPU and memory, p95 usage over 7d for CPU and memory, and
 * `qNodegroupByNode()` for the pod→nodegroup attribution.
 *
 * Results are joined by `(k8s_cluster_name, namespace, pod)`. The workload
 * name is the pod name in this plumbing task; task 5.11 refines it back to
 * the parent Deployment/StatefulSet.
 *
 * **Per-pod nodegroup attribution.** Every pod is mapped to the node it
 * runs on via `qPodToNode` (KSM `kube_pod_info`), and the node is then
 * mapped to the nodegroup via `qNodegroupByNode`. When a workload has
 * replicas spread across several nodegroups (anti-affinity, spot mix),
 * we pick the nodegroup with the most pods of that workload — a real
 * majority per workload, NOT the "one nodegroup per cluster" heuristic
 * the first pass used. Workloads with no resolvable node fall back to
 * `"unknown"` and trigger an aggregated `no-nodegroup-label` warning
 * (Requirement 2.1).
 *
 * `squad` uses {@link resolveSquad} with an empty pod-label bag (labels
 * are not carried by the current queries), so it falls back to the
 * namespace, and to `"sin asignar"` when even that is empty.
 */
export async function fetchWorkloads(ctx: NodeCostContext): Promise<{
  workloads: Workload[];
  warnings: EksWarning[];
}> {
  const warnings: EksWarning[] = [];
  const source = "node-cost.fetchWorkloads";

  const [cpuCost, ramCost, cpuReq, memReq, cpuP95, memP95, ngByNode, podToNode] =
    await Promise.all([
      safeQuery(ctx, "workloadCpuCost", qWorkloadCost("cpu"), source, warnings),
      safeQuery(ctx, "workloadRamCost", qWorkloadCost("ram"), source, warnings),
      safeQuery(
        ctx,
        "workloadCpuRequests",
        qWorkloadRequests("cpu"),
        source,
        warnings,
      ),
      safeQuery(
        ctx,
        "workloadMemRequests",
        qWorkloadRequests("mem"),
        source,
        warnings,
      ),
      safeQuery(
        ctx,
        "workloadCpuUsageP95",
        qWorkloadUsageP95("cpu"),
        source,
        warnings,
      ),
      safeQuery(
        ctx,
        "workloadMemUsageP95",
        qWorkloadUsageP95("mem"),
        source,
        warnings,
      ),
      safeQuery(ctx, "nodegroupByNode", qNodegroupByNode(), source, warnings),
      safeQuery(ctx, "podToNode", qPodToNode(), source, warnings),
    ]);

  const anyPodData =
    cpuCost.length +
    ramCost.length +
    cpuReq.length +
    memReq.length +
    cpuP95.length +
    memP95.length;
  if (anyPodData === 0) {
    warnings.push({
      code: "empty-window",
      message: "No workload metrics returned by any query",
      source,
    });
    return { workloads: [], warnings };
  }

  // (cluster, node) → nodegroup: every node maps to exactly one nodegroup
  // (as long as `qNodegroupByNode` returned a series for it). Nodes without
  // a nodegroup label just do not appear here; downstream pods on those
  // nodes fall through to the `"unknown"` bucket.
  const nodegroupByNodeMap = new Map<string, string>();
  for (const r of ngByNode) {
    const cluster = r.metric.k8s_cluster_name;
    const node = r.metric.node;
    const ng = r.metric.nodegroup;
    if (!cluster || !node || !ng) continue;
    nodegroupByNodeMap.set(`${cluster}::${node}`, ng);
  }

  // (cluster, namespace, pod) → nodegroup, resolved by chaining through
  // the node. Pods whose node is not in `nodegroupByNodeMap` are dropped
  // silently — the workload-level majority below will surface them as
  // `"unknown"` if every replica ends up unmapped.
  const nodegroupByPodMap = new Map<string, string>();
  for (const r of podToNode) {
    const cluster = r.metric.k8s_cluster_name;
    const ns = r.metric.namespace;
    const pod = r.metric.pod;
    const node = r.metric.node;
    if (!cluster || !ns || !pod || !node) continue;
    const ng = nodegroupByNodeMap.get(`${cluster}::${node}`);
    if (!ng) continue;
    nodegroupByPodMap.set(`${cluster}::${ns}::${pod}`, ng);
  }

  const podKey = (r: MetricRow): string => {
    const cluster = r.metric.k8s_cluster_name || "";
    const namespace = r.metric.namespace || "";
    const pod = r.metric.pod || "";
    // Collapse the many pods of a Deployment / StatefulSet / DaemonSet into a
    // single row by keying on the workload identity (Deployment name), not
    // on the pod name. Cost, requests and p95 usage are summed across every
    // running replica — which is exactly the number we want to report and
    // to compare against the workload's VPA target.
    const workload = normalizeWorkloadName(pod);
    return `${cluster}::${namespace}::${workload}`;
  };

  interface Bucket {
    cluster: string;
    namespace: string;
    workload: string;
    podCount: number;
    /** Count of the workload's pods on each nodegroup (majority wins). */
    nodegroupCounts: Map<string, number>;
    cpuCost: number;
    ramCost: number;
    cpuReqCores: number;
    memReqBytes: number;
    cpuP95Cores: number;
    memP95Bytes: number;
  }
  const bucketByKey = new Map<string, Bucket>();
  // Track distinct pods per bucket so we can populate `podCount` correctly
  // when the same source metric happens to emit multiple pods for the same
  // workload (Deployment with replicas > 1).
  const podsByKey = new Map<string, Set<string>>();
  const ensureBucket = (r: MetricRow): Bucket | null => {
    const cluster = r.metric.k8s_cluster_name;
    const namespace = r.metric.namespace;
    const pod = r.metric.pod;
    if (!cluster || !namespace || !pod) return null;
    const workload = normalizeWorkloadName(pod);
    const k = `${cluster}::${namespace}::${workload}`;
    let b = bucketByKey.get(k);
    if (!b) {
      b = {
        cluster,
        namespace,
        workload,
        podCount: 0,
        nodegroupCounts: new Map<string, number>(),
        cpuCost: 0,
        ramCost: 0,
        cpuReqCores: 0,
        memReqBytes: 0,
        cpuP95Cores: 0,
        memP95Bytes: 0,
      };
      bucketByKey.set(k, b);
    }
    let pods = podsByKey.get(k);
    if (!pods) {
      pods = new Set<string>();
      podsByKey.set(k, pods);
    }
    if (!pods.has(pod)) {
      pods.add(pod);
      b.podCount = pods.size;
      const ng = nodegroupByPodMap.get(`${cluster}::${namespace}::${pod}`);
      if (ng) {
        b.nodegroupCounts.set(ng, (b.nodegroupCounts.get(ng) ?? 0) + 1);
      }
    }
    return b;
  };
  for (const r of cpuCost) {
    const b = ensureBucket(r);
    if (b) b.cpuCost += readValue(r);
  }
  for (const r of ramCost) {
    const b = ensureBucket(r);
    if (b) b.ramCost += readValue(r);
  }
  for (const r of cpuReq) {
    const b = ensureBucket(r);
    if (b) b.cpuReqCores += readValue(r);
  }
  for (const r of memReq) {
    const b = ensureBucket(r);
    if (b) b.memReqBytes += readValue(r);
  }
  for (const r of cpuP95) {
    const b = ensureBucket(r);
    if (b) b.cpuP95Cores += readValue(r);
  }
  for (const r of memP95) {
    const b = ensureBucket(r);
    if (b) b.memP95Bytes += readValue(r);
  }

  const workloads: Workload[] = [];
  let unknownNgCount = 0;
  let unknownEnvCount = 0;

  // Precompute, per cluster, the set of nodegroups actually observed in the
  // `nodegroupByNodeMap`. Used below as a fallback attribution when a
  // workload's pods failed to resolve into any nodegroup (KSM
  // `kube_pod_info` misses the newest pods sometimes, especially on
  // dp-tooling where `unknown` collapses to the majority bucket) and the
  // cluster only has one nodegroup active — in that case there is no
  // ambiguity and attributing to the sole nodegroup keeps the filter usable.
  // O(N) over the node map; N ≤ ~16 total in the estate.
  const ngsByCluster = new Map<string, Set<string>>();
  for (const [k, ng] of nodegroupByNodeMap.entries()) {
    const idx = k.indexOf("::");
    if (idx <= 0) continue;
    const cluster = k.slice(0, idx);
    let s = ngsByCluster.get(cluster);
    if (!s) {
      s = new Set<string>();
      ngsByCluster.set(cluster, s);
    }
    s.add(ng);
  }

  for (const b of bucketByKey.values()) {
    const environment = ENV_BY_CLUSTER[b.cluster];
    if (!environment) {
      unknownEnvCount += 1;
      continue;
    }
    // Fallback: if we couldn't resolve any pod → nodegroup mapping for
    // this workload but the cluster has exactly one nodegroup active,
    // attribute to that one. Handles clusters like dp-tooling where the
    // KSM `kube_pod_info` sometimes misses the newest pods but there is
    // only one nodegroup to choose from — otherwise those workloads land
    // in `"unknown"` and disappear when the user filters by nodegroup.
    if (b.nodegroupCounts.size === 0) {
      const ngs = ngsByCluster.get(b.cluster);
      if (ngs && ngs.size === 1) {
        const [only] = ngs;
        b.nodegroupCounts.set(only, 1);
      }
    }
    // Majority nodegroup across this workload's replicas. Ties are broken
    // by insertion order (first observed wins) — which is stable enough
    // for a display attribution.
    let nodegroup = "unknown";
    let bestCount = -1;
    for (const [ng, c] of b.nodegroupCounts.entries()) {
      if (c > bestCount) {
        nodegroup = ng;
        bestCount = c;
      }
    }
    if (nodegroup === "unknown") {
      unknownNgCount += 1;
    }
    const monthlyCostEur =
      (b.cpuCost + b.ramCost) * ctx.hoursPerMonth * ctx.usdToEur;
    workloads.push({
      cluster: b.cluster,
      environment,
      namespace: b.namespace,
      // `workload` is the Deployment/StatefulSet identity produced by
      // `normalizeWorkloadName(pod)` upstream — every pod of the same
      // controller collapses into one row (cost / requests / p95 are
      // summed across replicas, `podCount` tracks how many).
      workload: b.workload,
      nodegroup,
      squad: resolveSquad({}, b.namespace),
      podCount: Math.max(1, b.podCount),
      cpuRequestCores: b.cpuReqCores,
      memRequestBytes: b.memReqBytes,
      cpuUsageP95Cores: b.cpuP95Cores,
      memUsageP95Bytes: b.memP95Bytes,
      monthlyCostEur: round2(monthlyCostEur),
    });
  }

  if (unknownNgCount > 0) {
    warnings.push({
      code: "no-nodegroup-label",
      message: `${unknownNgCount} workload${unknownNgCount === 1 ? "" : "s"} without a resolvable nodegroup`,
      source,
    });
  }
  if (unknownEnvCount > 0) {
    warnings.push({
      code: "no-nodegroup-label",
      message: `${unknownEnvCount} workload series from unknown clusters (expected dp-dev/uat/prod/tooling)`,
      source,
    });
  }

  return { workloads, warnings };
}
