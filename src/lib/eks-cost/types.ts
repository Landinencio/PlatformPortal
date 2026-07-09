/**
 * Shared types for the EKS Cost Optimization module.
 *
 * Canonical SI units used across the backend:
 *   - CPU: cores (`number`, e.g. `0.5` = 500 milicores)
 *   - Memory: bytes (`number`, e.g. `134217728` = 128 MiB)
 *
 * The Kubernetes-friendly representation ("500m", "128Mi", "2Gi") lives in the
 * `.k8s` field of `Recommendation.currentRequest` / `recommendedRequest` and is
 * produced by `k8s-units.ts`.
 *
 * Monetary values are expressed in EUR. The backend converts USD to EUR with a
 * fixed rate (`EKS_USD_EUR_RATE`, default `0.92`). The dashboard's goal is
 * magnitude and trend, not billing accuracy.
 *
 * See:
 *   - `.kiro/specs/eks-cost-optimization/design.md` §Backend > types.ts
 *   - `.kiro/specs/eks-cost-optimization/requirements.md`
 */

/**
 * Portal-canonical environment names. Kept in sync with the EKS cluster
 * catalog (dp-dev, dp-uat, dp-prd, dp-tooling).
 */
export type EnvironmentName = "dev" | "uat" | "prod" | "tooling";

/**
 * Aggregate of one environment (one physical EKS cluster).
 *
 * `spotCoveragePct` is rounded to one decimal and always lives in `[0, 100]`.
 * The sum of `nodegroups[].monthlyCostEur` equals `monthlyCostEur` modulo
 * rounding (Property 2 tolerance: 0.01€).
 */
export interface Environment {
  name: EnvironmentName;
  cluster: string;
  monthlyCostEur: number;
  nodeCount: number;
  spotCount: number;
  spotCoveragePct: number;
  nodegroups: Nodegroup[];
}

/**
 * A single EKS nodegroup within an environment.
 *
 * `avgNodeCostEur = monthlyCostEur / nodeCount` when `nodeCount > 0`, else 0.
 * `overprovisioningEur` is the sum of `estimatedSavingsEur` for `over-*`
 * recommendations attributed to this nodegroup.
 * `excessNodes = Math.floor(overprovisioningEur / avgNodeCostEur)` when
 * `avgNodeCostEur > 0`, else 0 (Property 10).
 */
export interface Nodegroup {
  name: string;
  cluster: string;
  environment: EnvironmentName;
  nodeCount: number;
  spotCount: number;
  spotCoveragePct: number;
  monthlyCostEur: number;
  avgNodeCostEur: number;
  overprovisioningEur: number;
  excessNodes: number;
}

/**
 * A workload (typically a Deployment/StatefulSet) attributed to its dominant
 * nodegroup and its owning squad.
 *
 * `squad` falls back to `"sin asignar"` when no owner/squad/team label is
 * present and the namespace does not resolve to a known squad.
 */
export interface Workload {
  cluster: string;
  environment: EnvironmentName;
  namespace: string;
  workload: string;
  nodegroup: string;
  squad: string;
  podCount: number;
  cpuRequestCores: number;
  memRequestBytes: number;
  cpuUsageP95Cores: number;
  memUsageP95Bytes: number;
  monthlyCostEur: number;
}

/**
 * Closed enum of recommendation types.
 *
 *   - `over-cpu`  — requests exceed the computed CPU target (savings).
 *   - `over-mem`  — requests exceed the computed memory target (savings).
 *   - `under-cpu` — p95 CPU usage exceeds the current CPU request (risk).
 *   - `under-mem` — p95 memory usage exceeds the current memory request (OOM risk).
 *
 * `over-*` and `under-*` on the same dimension are mutually exclusive per
 * workload. When both `under-cpu` and `under-mem` apply, `priorityFilter`
 * emits only `under-mem` (higher OOM risk).
 */
export type RecommendationKind =
  | "over-cpu"
  | "over-mem"
  | "under-cpu"
  | "under-mem";

/**
 * A single rightsizing recommendation for one workload dimension.
 *
 * `estimatedSavingsEur` is `0` for `under-*` (no savings, only risk mitigation)
 * and non-negative for `over-*`. It is capped at 70% of the current monthly
 * cost (Property 9, Requirements 5.1, 5.2).
 *
 * `unitYamlBlock` is a ready-to-copy `resources:` block. It always contains
 * `requests.cpu`, `requests.memory` and `limits.memory`, and never
 * `limits.cpu` (aligned with Guaranteed QoS best practice).
 */
export interface Recommendation {
  cluster: string;
  environment: EnvironmentName;
  namespace: string;
  workload: string;
  nodegroup: string;
  squad: string;
  kind: RecommendationKind;
  /** Current request in canonical SI units + its Kubernetes expression. */
  currentRequest: { value: number; k8s: string };
  /** Recommended request in canonical SI units + its Kubernetes expression. */
  recommendedRequest: { value: number; k8s: string };
  estimatedSavingsEur: number;
  unitYamlBlock: string;
  reason: string;
}

/**
 * A squad (or namespace fallback) with its aggregated cost and
 * overprovisioning share.
 */
export interface Squad {
  name: string;
  monthlyCostEur: number;
  workloadCount: number;
  overprovisioningEur: number;
}

/**
 * Machine-readable warning codes surfaced by the backend when data is
 * partial or configuration is missing. The UI shows a collapsible yellow
 * banner listing these; failures never cause 500s (see Property 14).
 */
export type WarningCode =
  | "metrics-not-configured"
  | "metrics-partial-fail"
  | "vpa-missing"
  | "no-nodegroup-label"
  | "no-squad-label"
  | "empty-window";

/**
 * A single warning entry attached to `AllocationResponse.warnings[]`.
 */
export interface Warning {
  code: WarningCode;
  message: string;
  /** Source module.function, e.g. `"node-cost.fetchNodegroups"`. */
  source: string;
}

/**
 * The full payload returned by `GET /api/finops/k8s-cost`.
 *
 * `workloads` is capped at 200 items (for the table); `recommendations` at
 * 100, ordered DESC by `estimatedSavingsEur`.
 */
export interface AllocationResponse {
  /** ISO 8601 timestamp (UTC) of when the summary was computed. */
  generatedAt: string;
  totalMonthlyEur: number;
  totalNodeCount: number;
  totalSpotCoveragePct: number;
  totalEstimatedSavingsEur: number;
  environments: Environment[];
  nodegroups: Nodegroup[];
  squads: Squad[];
  workloads: Workload[];
  recommendations: Recommendation[];
  warnings: Warning[];
}

/**
 * Server-side filters accepted by the route handler and applied by
 * `applyFilters()`. Application is idempotent and commutative across
 * dimensions (Property 12).
 */
export interface Filters {
  env?: EnvironmentName;
  nodegroup?: string;
  squad?: string;
}
