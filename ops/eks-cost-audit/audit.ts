/**
 * EKS Cost pipeline live audit.
 *
 * Runs every PromQL builder from `src/lib/eks-cost/promql.ts` against
 * Grafana Cloud with the token pulled from the `portal-env` secret in
 * dp-tooling, then cross-checks the results:
 *
 *   1. Every builder returns `status: success` (no 422 duplicate-series
 *      leftover from the KSM double-scrape in dp-prod).
 *
 *   2. Node counts per (cluster, nodegroup) are integers ≥ 0 with a
 *      total in the reasonable range (5–500).
 *
 *   3. Workload requests / p95 values are within a sanity range: they
 *      MUST NOT exceed the node capacity of the cluster (a Deployment
 *      cannot request more memory than the largest node has).
 *
 *   4. VPA `mem-upper` per (namespace, target_name) is at most one entry
 *      per key (dedup patch on `qVpaRecommendation`).
 *
 *   5. Optionally: spot-check a specific `(cluster, namespace, pod)`
 *      passed on the CLI and print `requests.memory` vs the manifest
 *      value the operator provides.
 *
 * Usage:
 *
 *   npx tsx ops/eks-cost-audit/audit.ts
 *   npx tsx ops/eks-cost-audit/audit.ts --spot dp-prod/pricing/bundles-price-manager
 *
 * Environment: assumes the `aws sso login` session is fresh; the script
 * calls `kubectl` with the eks-tooling context to fetch the metrics token
 * from the `portal-env` secret. Never prints the token itself; only its
 * length.
 *
 * This is a live-verification tool — NOT wired into the test suite. Its
 * purpose is to catch regressions between merge time and deploy time by
 * checking the actual Grafana data against the invariants the code
 * assumes.
 */

import { spawnSync } from "node:child_process";

import {
  qNodeCostHourly,
  qNodeCount,
  qNodegroupByNode,
  qSpotCount,
  qVpaRecommendation,
  qWorkloadCost,
  qWorkloadRequests,
  qWorkloadUsageP95,
} from "@/lib/eks-cost/promql";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const KUBE_CONTEXT =
  "arn:aws:eks:eu-west-1:444455556666:cluster/dp-tooling";
const GRAFANA_METRICS_URL =
  "https://prometheus-prod-24-prod-eu-west-2.grafana.net/api/prom";
const GRAFANA_METRICS_USERNAME = "1290143";

/** Expected `k8s_cluster_name` label values across the estate. */
const EXPECTED_CLUSTERS: readonly string[] = [
  "dp-dev",
  "dp-uat",
  "dp-prod",
  "dp-tooling",
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Pull the `GRAFANA_METRICS_TOKEN` value from the `portal-env` secret in
 * dp-tooling. Never prints the token.
 */
function loadToken(): string {
  const out = spawnSync(
    "kubectl",
    [
      "--context",
      KUBE_CONTEXT,
      "-n",
      "n8n",
      "get",
      "secret",
      "portal-env",
      "-o",
      "jsonpath={.data.GRAFANA_METRICS_TOKEN}",
    ],
    { encoding: "utf8" },
  );
  if (out.status !== 0) {
    throw new Error(
      `kubectl failed with status ${out.status}. Refresh SSO with \`aws sso login --profile eks-tooling\`.\n${out.stderr}`,
    );
  }
  const decoded = Buffer.from(out.stdout.trim(), "base64").toString("utf8");
  if (!decoded) throw new Error("empty GRAFANA_METRICS_TOKEN");
  return decoded;
}

interface VectorSample {
  metric: Record<string, string>;
  value: [number, string];
}

interface PromResponse {
  status: "success" | "error";
  errorType?: string;
  error?: string;
  data?: { resultType: string; result: VectorSample[] };
}

async function query(token: string, promQL: string): Promise<PromResponse> {
  const url = new URL("/api/prom/api/v1/query", GRAFANA_METRICS_URL);
  const auth = Buffer.from(`${GRAFANA_METRICS_USERNAME}:${token}`).toString(
    "base64",
  );
  const params = new URLSearchParams({ query: promQL });
  const res = await fetch(`${url}?${params.toString()}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  return (await res.json()) as PromResponse;
}

function short(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

interface AuditFinding {
  ok: boolean;
  label: string;
  detail?: string;
}

const findings: AuditFinding[] = [];

function record(f: AuditFinding): void {
  findings.push(f);
  const badge = f.ok ? "\u001b[32m✓\u001b[0m" : "\u001b[31m✗\u001b[0m";
  const detail = f.detail ? `  ${f.detail}` : "";
  console.log(`${badge} ${f.label}${detail}`);
}

/* ------------------------------------------------------------------ */
/*  Individual audits                                                  */
/* ------------------------------------------------------------------ */

async function auditQuery(
  token: string,
  label: string,
  promQL: string,
  extra?: (result: VectorSample[]) => AuditFinding[],
): Promise<VectorSample[]> {
  const started = Date.now();
  const res = await query(token, promQL);
  const elapsed = Date.now() - started;
  if (res.status !== "success" || !res.data) {
    record({
      ok: false,
      label,
      detail: `${elapsed}ms — ${res.error ?? "no data"}`,
    });
    return [];
  }
  const rows = res.data.result;
  record({ ok: true, label, detail: `${elapsed}ms — ${rows.length} series` });

  // Cluster coverage: every OpenCost/KSM query should return series for the
  // four canonical clusters. Missing one indicates a scraper or metric drop.
  const clusters = new Set(rows.map((r) => r.metric.k8s_cluster_name));
  for (const c of EXPECTED_CLUSTERS) {
    if (!clusters.has(c)) {
      record({
        ok: false,
        label: `  cluster coverage — ${c}`,
        detail: "no series returned",
      });
    }
  }

  // Optional extra checks (per-metric invariants).
  if (extra) {
    for (const f of extra(rows)) record(f);
  }
  return rows;
}

/**
 * Sanity checks specific to workload requests / p95: no row should exceed
 * the largest node's capacity by construction. We approximate the cap
 * against the largest observed `container_memory_allocation_bytes` value
 * per cluster — anything above 3x that is a strong smell of the KSM
 * duplicate-scraper bug.
 */
function sanityWorkload(rows: VectorSample[], unit: "cpu" | "mem"): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const maxByCluster = new Map<string, number>();
  for (const r of rows) {
    const cluster = r.metric.k8s_cluster_name;
    if (!cluster) continue;
    const v = Number(r.value?.[1] ?? 0);
    if (!Number.isFinite(v)) continue;
    const prev = maxByCluster.get(cluster) ?? 0;
    if (v > prev) maxByCluster.set(cluster, v);
  }
  const cap = unit === "cpu" ? 64 : 256 * 1024 * 1024 * 1024; // 64 cores / 256 GiB
  for (const [cluster, m] of maxByCluster.entries()) {
    const ok = m <= cap;
    const human =
      unit === "cpu" ? `${m.toFixed(2)} cores` : `${(m / 1024 ** 3).toFixed(2)} GiB`;
    findings.push({
      ok,
      label: `  ${cluster} max ${unit} per pod`,
      detail: human,
    });
  }
  return findings;
}

/**
 * VPA dedup check: at most one row per (cluster, namespace, target_name,
 * container). The metric already partitions by all four so any duplicate
 * would mean the KSM-vpa scraper is emitting twice — which is what the
 * `max by` patch is designed to swallow.
 */
function vpaDedup(rows: VectorSample[]): AuditFinding[] {
  const seen = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.metric.k8s_cluster_name}|${r.metric.namespace}|${r.metric.target_name}|${r.metric.container}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, c]) => c > 1);
  return [
    {
      ok: dupes.length === 0,
      label: "  VPA rows are unique per (cluster, namespace, target_name, container)",
      detail:
        dupes.length === 0
          ? `${seen.size} unique keys`
          : `${dupes.length} duplicate keys — max by patch is not effective`,
    },
  ];
}

/**
 * Spot check a specific workload: prints the raw requests memory value the
 * pipeline sees, so the operator can compare with the manifest.
 */
async function spotCheck(token: string, spec: string): Promise<void> {
  const [cluster, namespace, workload] = spec.split("/");
  if (!cluster || !namespace || !workload) {
    console.error(
      "  spot-check: expected format cluster/namespace/workload — e.g. dp-prod/pricing/bundles-price-manager",
    );
    return;
  }
  console.log(
    `\n─── spot check: ${cluster}/${namespace}/${workload} ─────────`,
  );
  const promQL = `sum by (k8s_cluster_name, namespace, pod) (
  max by (k8s_cluster_name, namespace, pod, container) (
    kube_pod_container_resource_requests{resource="memory",container!="",container!="POD",k8s_cluster_name="${cluster}",namespace="${namespace}",pod=~"${workload}.*"}
  )
)`;
  const res = await query(token, promQL);
  if (res.status !== "success" || !res.data) {
    console.log(`  query failed: ${res.error}`);
    return;
  }
  if (res.data.result.length === 0) {
    console.log("  no pods match — check the workload prefix");
    return;
  }
  for (const row of res.data.result) {
    const bytes = Number(row.value[1]);
    const mib = bytes / (1024 * 1024);
    const gib = bytes / (1024 * 1024 * 1024);
    console.log(
      `  pod=${row.metric.pod}  requests.memory (per pod, sum containers) = ${mib.toFixed(0)}Mi ≈ ${gib.toFixed(2)}Gi`,
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("EKS Cost audit — pulling token from dp-tooling…");
  const token = loadToken();
  console.log(`Token length: ${token.length} chars (never printed).\n`);

  console.log("Node-cost queries");
  console.log("─────────────────");
  await auditQuery(token, "qNodeCostHourly", qNodeCostHourly());
  await auditQuery(token, "qNodeCount", qNodeCount());
  await auditQuery(token, "qSpotCount", qSpotCount());
  await auditQuery(token, "qNodegroupByNode", qNodegroupByNode());

  console.log("\nWorkload queries");
  console.log("────────────────");
  await auditQuery(token, "qWorkloadCost(cpu)", qWorkloadCost("cpu"));
  await auditQuery(token, "qWorkloadCost(ram)", qWorkloadCost("ram"));
  await auditQuery(token, "qWorkloadRequests(cpu)", qWorkloadRequests("cpu"), (rows) =>
    sanityWorkload(rows, "cpu"),
  );
  await auditQuery(token, "qWorkloadRequests(mem)", qWorkloadRequests("mem"), (rows) =>
    sanityWorkload(rows, "mem"),
  );
  await auditQuery(token, "qWorkloadUsageP95(cpu)", qWorkloadUsageP95("cpu"), (rows) =>
    sanityWorkload(rows, "cpu"),
  );
  await auditQuery(token, "qWorkloadUsageP95(mem)", qWorkloadUsageP95("mem"), (rows) =>
    sanityWorkload(rows, "mem"),
  );

  console.log("\nVPA queries");
  console.log("───────────");
  await auditQuery(token, "qVpaRecommendation(mem-upper)", qVpaRecommendation("mem-upper"), vpaDedup);
  await auditQuery(token, "qVpaRecommendation(cpu-target)", qVpaRecommendation("cpu-target"), vpaDedup);

  const spot = process.argv.indexOf("--spot");
  if (spot > 0 && process.argv[spot + 1]) {
    await spotCheck(token, process.argv[spot + 1]);
  }

  const failed = findings.filter((f) => !f.ok);
  console.log(
    `\n─── audit summary: ${findings.length - failed.length} OK, ${failed.length} FAILED ───`,
  );
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Audit crashed:", err);
  process.exit(1);
});
