import { correlateDeployments } from "@/lib/deployment-correlation";
import { generateDoraSnapshot } from "@/lib/dora-snapshot";
import { generateK8sSnapshots } from "@/lib/k8s-snapshot";
import { generateMrAnalyticsSnapshot } from "@/lib/mr-snapshot";
import { generateServiceComplianceSnapshot } from "@/lib/service-compliance";
import { generateSonarSnapshot } from "@/lib/sonarqube-snapshot";
import { invalidateCache } from "@/lib/cache";

export type SnapshotStepResult = {
  success: boolean;
  error: string | null;
  data: any;
  durationMs: number;
  retries: number;
};

export type UnifiedSnapshotPayload = {
  success: boolean;
  snapshotDate: string;
  duration: string;
  results: {
    dora: SnapshotStepResult;
    mrAnalytics: SnapshotStepResult;
    sonarqube: SnapshotStepResult;
    compliance: SnapshotStepResult;
    k8sMetrics: SnapshotStepResult;
    correlation: SnapshotStepResult;
  };
};

/** Prevent concurrent snapshot runs for the same date */
const runningSnapshots = new Set<string>();

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5_000;

/**
 * Execute a snapshot step with retry logic.
 */
async function runStep(
  name: string,
  fn: () => Promise<any>,
  maxRetries = MAX_RETRIES
): Promise<SnapshotStepResult> {
  const stepStart = Date.now();
  let lastError: string | null = null;
  let retries = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`  ↻ Retrying ${name} (attempt ${attempt + 1}/${maxRetries + 1})...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
      const data = await fn();
      return {
        success: true,
        error: null,
        data,
        durationMs: Date.now() - stepStart,
        retries: attempt,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      retries = attempt + 1;
      console.error(`  ✗ ${name} failed (attempt ${attempt + 1}): ${lastError}`);
    }
  }

  return {
    success: false,
    error: lastError,
    data: null,
    durationMs: Date.now() - stepStart,
    retries,
  };
}

/**
 * Unified snapshot pipeline.
 *
 * Execution strategy:
 *   Phase 1 (parallel): DORA + SonarQube + K8s metrics + Compliance
 *     - These are independent data sources that don't depend on each other
 *   Phase 2 (sequential, after Phase 1): MR Analytics
 *     - Depends on DORA project discovery being complete
 *   Phase 3 (sequential, after Phase 1): Deployment Correlation
 *     - Depends on DORA + K8s data being persisted
 *
 * Each step has retry with backoff (2 retries, 5s/10s delay).
 * Concurrent runs for the same date are rejected.
 */
export async function generateUnifiedSnapshot(snapshotDate: string): Promise<UnifiedSnapshotPayload> {
  if (runningSnapshots.has(snapshotDate)) {
    console.warn(`[snapshot] Snapshot for ${snapshotDate} is already running — skipping duplicate`);
    return {
      success: false,
      snapshotDate,
      duration: "0s",
      results: {
        dora: { success: false, error: "Duplicate run rejected", data: null, durationMs: 0, retries: 0 },
        mrAnalytics: { success: false, error: "Duplicate run rejected", data: null, durationMs: 0, retries: 0 },
        sonarqube: { success: false, error: "Duplicate run rejected", data: null, durationMs: 0, retries: 0 },
        compliance: { success: false, error: "Duplicate run rejected", data: null, durationMs: 0, retries: 0 },
        k8sMetrics: { success: false, error: "Duplicate run rejected", data: null, durationMs: 0, retries: 0 },
        correlation: { success: false, error: "Duplicate run rejected", data: null, durationMs: 0, retries: 0 },
      },
    };
  }

  runningSnapshots.add(snapshotDate);
  const startTime = Date.now();

  console.log(`=== Starting unified snapshot for ${snapshotDate} ===`);

  const results = {
    dora: { success: false, error: null, data: null, durationMs: 0, retries: 0 } as SnapshotStepResult,
    mrAnalytics: { success: false, error: null, data: null, durationMs: 0, retries: 0 } as SnapshotStepResult,
    sonarqube: { success: false, error: null, data: null, durationMs: 0, retries: 0 } as SnapshotStepResult,
    compliance: { success: false, error: null, data: null, durationMs: 0, retries: 0 } as SnapshotStepResult,
    k8sMetrics: { success: false, error: null, data: null, durationMs: 0, retries: 0 } as SnapshotStepResult,
    correlation: { success: false, error: null, data: null, durationMs: 0, retries: 0 } as SnapshotStepResult,
  };

  try {
    // Phase 1: Independent data sources in parallel
    console.log("Phase 1: Collecting independent data sources in parallel...");
    const anchorDate = new Date(`${snapshotDate}T00:00:00.000Z`);

    const [doraResult, sonarResult, k8sResult, complianceResult] = await Promise.all([
      runStep("DORA metrics", () => generateDoraSnapshot(snapshotDate)),
      runStep("SonarQube metrics", () => generateSonarSnapshot(snapshotDate)),
      runStep("K8s metrics", () => generateK8sSnapshots(anchorDate, 1)),
      runStep("Service compliance", () =>
        generateServiceComplianceSnapshot(snapshotDate, { skipHistoricalLiveCapture: true })
      ),
    ]);

    results.dora = doraResult;
    results.sonarqube = sonarResult;
    results.k8sMetrics = k8sResult;
    results.compliance = complianceResult;

    // Selective cache invalidation after Phase 1
    if (doraResult.success) invalidateCache("dora");
    if (sonarResult.success) invalidateCache("sonar");
    if (k8sResult.success) invalidateCache("k8s");

    console.log(
      `Phase 1 complete: DORA=${doraResult.success} (${(doraResult.durationMs / 1000).toFixed(0)}s), ` +
      `Sonar=${sonarResult.success} (${(sonarResult.durationMs / 1000).toFixed(0)}s), ` +
      `K8s=${k8sResult.success} (${(k8sResult.durationMs / 1000).toFixed(0)}s), ` +
      `Compliance=${complianceResult.success} (${(complianceResult.durationMs / 1000).toFixed(0)}s)`
    );

    // Phase 2: MR Analytics (benefits from DORA project list being fresh)
    console.log("Phase 2: MR Analytics...");
    results.mrAnalytics = await runStep("MR Analytics", () =>
      generateMrAnalyticsSnapshot(snapshotDate)
    );
    console.log(
      `Phase 2 complete: MR=${results.mrAnalytics.success} (${(results.mrAnalytics.durationMs / 1000).toFixed(0)}s)`
    );

    // Phase 3: Correlation (needs DORA + K8s data)
    console.log("Phase 3: Deployment correlation...");
    results.correlation = await runStep("Deployment correlation", () =>
      correlateDeployments(anchorDate)
    );

    // Selective cache invalidation after correlation (affects dora + correlation caches)
    if (results.correlation.success) {
      invalidateCache("dora");
      invalidateCache("correlation");
    }

    console.log(
      `Phase 3 complete: Correlation=${results.correlation.success} (${(results.correlation.durationMs / 1000).toFixed(0)}s)`
    );
  } finally {
    runningSnapshots.delete(snapshotDate);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const allSuccess = Object.values(results).every((r) => r.success);

  console.log(`=== Unified snapshot completed in ${duration}s ===`);
  console.log(
    `Success: DORA=${results.dora.success}, MR=${results.mrAnalytics.success}, ` +
    `Sonar=${results.sonarqube.success}, Compliance=${results.compliance.success}, ` +
    `K8s=${results.k8sMetrics.success}, Correlation=${results.correlation.success}`
  );

  return {
    success: allSuccess,
    snapshotDate,
    duration: `${duration}s`,
    results,
  };
}
