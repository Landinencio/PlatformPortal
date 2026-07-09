/**
 * POST /api/explorer/run — On-demand trigger for an AI Portal Explorer run.
 *
 * Feature: ai-portal-explorer (task 16.1)
 *
 * Auth: internal only (`x-internal-secret`), validated by `requireInternalAuth`.
 * Without a valid secret the request is rejected with 401 (Req 9.2). With a valid
 * secret it starts an Exploration_Run (Req 9.1) with `triggerSource: "on-demand"`.
 *
 * Pattern: like the existing snapshot endpoints, this triggers a long-running job.
 * The Explorer crawl (Playwright over every Route × Role) can take many minutes, so
 * we DO NOT await it. We kick off `runExploration` fire-and-forget and return
 * 202 Accepted immediately.
 *
 * Single-run lock (Req 9.5): the orchestrator's `runExploration` calls
 * `claimRunLock` internally (atomic UPDATE over `explorer_run_lock`). If a run is
 * already in progress the claim fails and the orchestrator records an aborted run
 * for the duplicate start instead of running a second concurrent crawl. We rely on
 * that internal lock here rather than acquiring it ourselves (acquiring it in the
 * route would steal the lock from the background run).
 *
 * Security: this endpoint triggers a browser crawl of the portal, so it is internal
 * only (`x-internal-secret`) and MUST NOT be exposed unauthenticated.
 *
 * _Requirements: 9.1, 9.2, 9.5_
 */

import { NextResponse } from "next/server";

import { requireInternalAuth } from "@/lib/api-auth";
import type { AppRole } from "@/lib/rbac";
import { DEFAULT_SCENARIO_MATRIX } from "@/lib/explorer/scenario-generator";
import { runExploration } from "@/lib/explorer/orchestrator";
import type { RunConfig } from "@/lib/explorer/orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The crawl runs in the background (fire-and-forget); the handler itself returns
// immediately, so a short maxDuration is enough to start the job.
export const maxDuration = 60;

/** AppRoles supported by the portal (see `src/lib/rbac.ts`). */
const ALL_ROLES: AppRole[] = ["admin", "directores", "managers", "staff", "desarrolladores", "externos"];

const DEFAULT_BASE_URL = "https://portal.today.dev.tooling.dp.iskaypet.com";
const DEFAULT_LATENCY_THRESHOLD_MS = 3_000;
const DEFAULT_SERIES_END_TOLERANCE_DAYS = 2;
const DEFAULT_BEDROCK_BUDGET = 50;
const DEFAULT_VISIT_TIMEOUT_MS = 30_000;

/** Reads a non-negative integer from env with a fallback for missing/invalid values. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Resolves the roles to sweep from `EXPLORER_ROLES` (CSV), validated. */
function resolveRoles(): AppRole[] {
  const raw = process.env.EXPLORER_ROLES;
  if (!raw || raw.trim() === "") return ALL_ROLES;
  const requested = raw
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  const valid = requested.filter((r): r is AppRole => (ALL_ROLES as string[]).includes(r));
  return valid.length > 0 ? valid : ALL_ROLES;
}

/**
 * Builds the `RunConfig` from environment, mirroring the job runner
 * (`ops/portal-explorer/run.ts`) so on-demand and CronJob runs are consistent.
 */
function buildRunConfig(): RunConfig {
  return {
    baseUrl: process.env.EXPLORER_BASE_URL?.trim() || DEFAULT_BASE_URL,
    roles: resolveRoles(),
    scenarioMatrix: DEFAULT_SCENARIO_MATRIX,
    detector: {
      latencyThresholdMs: envInt("EXPLORER_LATENCY_THRESHOLD_MS", DEFAULT_LATENCY_THRESHOLD_MS),
      seriesEndToleranceDays: envInt(
        "EXPLORER_SERIES_END_TOLERANCE_DAYS",
        DEFAULT_SERIES_END_TOLERANCE_DAYS,
      ),
    },
    bedrockBudget: envInt("EXPLORER_BEDROCK_BUDGET", DEFAULT_BEDROCK_BUDGET),
    visitTimeoutMs: envInt("EXPLORER_VISIT_TIMEOUT_MS", DEFAULT_VISIT_TIMEOUT_MS),
  };
}

export async function POST(request: Request) {
  // Req 9.2: reject without a valid x-internal-secret.
  const auth = requireInternalAuth(request);
  if (auth.error) return auth.error;

  // Req 9.1: start an Exploration_Run on-demand. The crawl is long-running, so we
  // fire-and-forget (NOT awaiting) and return 202 immediately. The orchestrator's
  // internal claimRunLock enforces single-run concurrency (Req 9.5): a duplicate
  // start while a run is in progress is recorded as an aborted run.
  const config = buildRunConfig();

  void runExploration(config, { triggerSource: "on-demand" }).catch((err) => {
    console.error("[explorer/run] Exploration_Run failed:", err);
  });

  console.log("[explorer/run] On-demand Exploration_Run started in background");

  return NextResponse.json(
    {
      success: true,
      status: "accepted",
      message:
        "Exploration_Run started in background. If a run is already in progress, " +
        "this duplicate start is rejected by the single-run lock.",
      baseUrl: config.baseUrl,
      roles: config.roles,
    },
    { status: 202 },
  );
}
