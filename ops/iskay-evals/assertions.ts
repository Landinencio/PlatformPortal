/**
 * Iskay evals — deterministic assertion engine (task 12).
 *
 * Pure helpers that grade an `EvalCase` against the trace + final text
 * captured by the runner. The runner imports `runAssertions` from this
 * module; tests in `src/lib/__tests__/iskay-evals-assertions.test.ts`
 * exercise each helper in isolation (no Bedrock, no AWS, no Athena).
 *
 * Design notes:
 *  - Each assertion is wrapped in `try/catch` inside `runAssertions` so a
 *    bug in one helper can never sink the others.
 *  - `citesToolFigures` reuses `verifyCitations` from
 *    `@/lib/finops-citation-guard` (the same guard the live route logs).
 *  - `noOpaqueIds` reuses `containsOpaqueId` from `@/lib/finops-tools`
 *    (inverse of `prettyServiceName`'s rules).
 *  - `period` scans every tool_call input for a matching range; a single
 *    matching tool call is enough (the agent might call several tools).
 *  - `outOfScopeRedirect` is a permissive check: NO cost/inventory tool
 *    was called AND the final text contains at least one canonical
 *    dashboard URL substring. The goal is to flag obvious failures, not
 *    nitpick wording.
 *
 * Refer to spec `.kiro/specs/iskay-finops-specialist/` (R9.1 → R9.6).
 */

import type { AgentStep } from "@/lib/iskay-agent";
import { containsOpaqueId } from "@/lib/finops-tools";
import { verifyCitations } from "@/lib/finops-citation-guard";

import type { EvalCase } from "./cases";

/**
 * Names of every FinOps cost / inventory tool exposed to Iskay. An out-of-scope
 * question must NOT invoke any of these. `list_accounts` is intentionally OUT
 * of this set: it is a benign directory lookup that is safe even when the
 * conversation has nothing to do with cost.
 *
 * Kept as a plain literal (not `import { FINOPS_TOOLS }`) so this module stays
 * cheap to import in tests — pulling `FINOPS_TOOLS` would load XLSX, the AWS
 * SDK chain, the Postgres pool and the AWS account catalog, all of which are
 * irrelevant to assertion logic.
 */
export const COST_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_total_cost",
  "get_cost_by_account",
  "get_cost_by_service",
  "compare_periods",
  "get_forecast",
  "get_top_resources",
  "get_daily_context",
  "get_net_cost_breakdown",
  "get_marketplace_charges",
  "get_hidden_costs",
  "get_cost_by_domain",
  "get_inventory_summary",
  "search_inventory",
  "build_report",
]);

/**
 * Canonical dashboard substrings the system prompt asks Iskay to redirect
 * out-of-scope questions to. Permissive: any single match is enough.
 */
export const REDIRECT_HINTS: readonly string[] = [
  "/metrics",
  "/infra-requests",
  "/access-management",
  "/tickets",
  "/synthetics",
  "iskaylog.grafana.net",
];

/** Minimal shape consumed by the assertion engine. */
export interface AssertionInput {
  /** Full trace as captured by the runner (tool_call / tool_result / text). */
  trace: AgentStep[];
  /** The assistant's final answer text. */
  finalText: string;
  /** Distinct tool names invoked, in first-seen order. */
  toolsUsed: string[];
}

/* ------------------------------------------------------------------ */
/*  Individual assertions (R9.1 – R9.6)                                */
/* ------------------------------------------------------------------ */

/** R9.1 — every name in `expected` MUST appear in `toolsUsed`. */
export function assertExpectTools(
  toolsUsed: string[],
  expected: string[],
): string[] {
  const failures: string[] = [];
  for (const name of expected) {
    if (!toolsUsed.includes(name)) {
      const seen = toolsUsed.length > 0 ? toolsUsed.join(", ") : "—";
      failures.push(`expectTools: missing '${name}' (tools used: ${seen})`);
    }
  }
  return failures;
}

/** R9.2 — no name in `forbidden` may appear in `toolsUsed`. */
export function assertForbidTools(
  toolsUsed: string[],
  forbidden: string[],
): string[] {
  const failures: string[] = [];
  for (const name of forbidden) {
    if (toolsUsed.includes(name)) {
      failures.push(
        `forbidTools: invoked '${name}' but it should NOT have been called`,
      );
    }
  }
  return failures;
}

/**
 * R9.3 — every monetary amount in `finalText` must appear in some
 * `tool_result.output` from the trace. Reuses the production
 * `verifyCitations` guard (±0.5% / ±$1 tolerance).
 */
export function assertCitesToolFigures(
  finalText: string,
  trace: AgentStep[],
): string[] {
  const toolResults: unknown[] = [];
  for (const step of trace) {
    if (step.type !== "tool_result") continue;
    if (step.output === undefined) continue;
    toolResults.push(step.output);
  }
  const result = verifyCitations(finalText, toolResults);
  if (result.missing.length === 0) return [];
  const list = result.missing.join(", ");
  return [
    `citesToolFigures: ${result.missing.length} amount(s) not backed by tool results: ${list}`,
  ];
}

/** R9.4 — final text must not contain any raw Opaque_Id. */
export function assertNoOpaqueIds(finalText: string): string[] {
  if (!containsOpaqueId(finalText)) return [];
  return [
    "noOpaqueIds: response contains a raw opaque CUR id (cg… or inference-profile-style)",
  ];
}

/**
 * R9.5 — at least one tool_call in the trace must have used the expected
 * date window. Accepts the standard `startDate`/`endDate` pair AND the
 * `compare_periods` shape (`currentStart`/`currentEnd` plus
 * `previousStart`/`previousEnd`).
 */
export function assertPeriod(
  trace: AgentStep[],
  expected: { start: string; end: string },
): string[] {
  const seen: Array<{ start: string; end: string }> = [];
  for (const step of trace) {
    if (step.type !== "tool_call") continue;
    const input = step.input;
    if (!input || typeof input !== "object") continue;
    const obj = input as Record<string, unknown>;

    if (typeof obj.startDate === "string" && typeof obj.endDate === "string") {
      seen.push({ start: obj.startDate, end: obj.endDate });
    }
    if (typeof obj.currentStart === "string" && typeof obj.currentEnd === "string") {
      seen.push({ start: obj.currentStart, end: obj.currentEnd });
    }
    if (typeof obj.previousStart === "string" && typeof obj.previousEnd === "string") {
      seen.push({ start: obj.previousStart, end: obj.previousEnd });
    }
  }

  const matched = seen.some(
    (s) => s.start === expected.start && s.end === expected.end,
  );
  if (matched) return [];

  const detail = seen.length === 0
    ? "no tool was called with a date range"
    : `seen ranges: ${seen.map((s) => `${s.start}..${s.end}`).join(", ")}`;
  return [`period: expected ${expected.start}..${expected.end}; ${detail}`];
}

/**
 * R9.6 — out-of-scope question handling: NO cost/inventory tool may have been
 * invoked, AND the final text must include at least one canonical dashboard
 * URL substring (`/metrics`, `/infra-requests`, …, `iskaylog.grafana.net`).
 *
 * Both halves matter: a model that just refuses to answer without redirecting
 * is not the desired UX, and a model that "redirects" while still pulling
 * cost data is leaking work it shouldn't have done.
 */
export function assertOutOfScopeRedirect(
  toolsUsed: string[],
  finalText: string,
): string[] {
  const failures: string[] = [];

  const offending = toolsUsed.filter((t) => COST_TOOL_NAMES.has(t));
  if (offending.length > 0) {
    failures.push(
      `outOfScopeRedirect: invoked cost/inventory tool(s) ${offending.join(", ")}`,
    );
  }

  const lower = finalText.toLowerCase();
  const hinted = REDIRECT_HINTS.some((h) => lower.includes(h.toLowerCase()));
  if (!hinted) {
    failures.push(
      `outOfScopeRedirect: response missing a redirection hint (one of ${REDIRECT_HINTS.join(", ")})`,
    );
  }

  return failures;
}

/* ------------------------------------------------------------------ */
/*  Top-level orchestrator                                             */
/* ------------------------------------------------------------------ */

/**
 * Runs every assertion declared on `ec` against `input` and returns the
 * accumulated failure messages (empty array == case passes).
 *
 * Each individual helper is wrapped in `try/catch`. A bug in one helper
 * (e.g. an unexpected trace shape that throws inside `verifyCitations`)
 * surfaces as a failure for THAT helper while the rest still run — so a
 * single broken assertion can never blow up the whole eval suite.
 */
export function runAssertions(
  ec: EvalCase,
  input: AssertionInput,
): string[] {
  const failures: string[] = [];

  const safe = (label: string, fn: () => string[]): void => {
    try {
      const local = fn();
      for (const f of local) failures.push(f);
    } catch (err: any) {
      const msg = err?.message || String(err);
      failures.push(`${label}: assertion threw: ${msg}`);
    }
  };

  safe("expectTools", () => assertExpectTools(input.toolsUsed, ec.expectTools));

  if (ec.forbidTools && ec.forbidTools.length > 0) {
    safe("forbidTools", () => assertForbidTools(input.toolsUsed, ec.forbidTools!));
  }

  const a = ec.assertions;

  if (a.citesToolFigures) {
    safe("citesToolFigures", () =>
      assertCitesToolFigures(input.finalText, input.trace),
    );
  }
  if (a.noOpaqueIds) {
    safe("noOpaqueIds", () => assertNoOpaqueIds(input.finalText));
  }
  if (a.period) {
    safe("period", () => assertPeriod(input.trace, a.period!));
  }
  if (a.outOfScopeRedirect) {
    safe("outOfScopeRedirect", () =>
      assertOutOfScopeRedirect(input.toolsUsed, input.finalText),
    );
  }

  // Sanity: every case must produce a final answer.
  if (!input.finalText.trim()) {
    failures.push("final text is empty");
  }

  return failures;
}
