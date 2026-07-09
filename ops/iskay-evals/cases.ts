/**
 * Iskay evals — golden test cases.
 *
 * Each case feeds one user question into the agent loop and asserts something
 * about the resulting trace + final text. The deterministic assertion engine
 * lives in `./assertions`; this file is purely declarative — adding a case is
 * just appending an entry to `EVAL_CASES`.
 *
 * The five golden cases below codify the FinOps regressions Iskay must NOT
 * regress on (R10.1 → R10.5). They are the bar the chatbot must clear before
 * it is opened beyond admin/directores. The trailing `smoke-list-accounts`
 * case stays as a cheap dry-run option for operators verifying harness wiring
 * without paying for an Athena/CUR roundtrip.
 *
 * Adding a case: append to `EVAL_CASES`. Keep it small and focused — one
 * behavior per case. Use `forbidTools` to encode "must NOT do X" regressions
 * (e.g. don't fall back to `get_total_cost` when the user asked something
 * that needs `get_net_cost_breakdown`).
 */

/** Assertion bundle attached to each case. Each flag is opt-in: `undefined`
 *  means "don't run that check". The full assertion engine lives in
 *  `./assertions` (R9.1 → R9.6). */
export interface EvalAssertions {
  /** Final text must not contain raw opaque CUR ids (cg…/inference-profile). */
  noOpaqueIds?: boolean;
  /** Every monetary amount in the final text must appear in some toolResult. */
  citesToolFigures?: boolean;
  /** The agent must resolve the date range to exactly this start/end. */
  period?: { start: string; end: string };
  /** Out-of-scope question: agent should redirect cleanly without invoking
   *  cost tools and without inventing numbers. */
  outOfScopeRedirect?: boolean;
}

export interface EvalCase {
  /** Stable identifier used for filtering and reporting. */
  id: string;
  /** The user question fed into the agent loop. */
  question: string;
  /** Tools the agent MUST invoke at least once during this case. */
  expectTools: string[];
  /** Tools the agent MUST NOT invoke during this case. */
  forbidTools?: string[];
  /** Bundle of behavioral assertions on the trace + final text. */
  assertions: EvalAssertions;
}

/**
 * Every cost / inventory / report tool exposed to Iskay. Used as the
 * `forbidTools` list for the out-of-scope case (d) so the agent cannot
 * sneak a cost lookup into a question that has nothing to do with FinOps.
 * `list_accounts` is intentionally omitted: it is a benign directory call
 * that is safe to invoke even when redirecting.
 */
const ALL_FINOPS_TOOLS: readonly string[] = [
  "get_total_cost",
  "get_cost_by_service",
  "get_cost_by_account",
  "get_top_resources",
  "get_net_cost_breakdown",
  "get_marketplace_charges",
  "get_hidden_costs",
  "get_cost_by_domain",
  "get_inventory_summary",
  "search_inventory",
  "get_forecast",
  "compare_periods",
  "get_daily_context",
  "build_report",
];

export const EVAL_CASES: EvalCase[] = [
  /**
   * (a) "¿Cuánto cuesta AWS?" — gotcha #3 in the steering doc.
   *
   * The naive answer is `get_total_cost`, which returns the GROSS bill
   * (infra + marketplace contracts + tax, before SP/SPP/credits/refunds).
   * That is the wrong number for "cuánto cuesta AWS de verdad": annual
   * marketplace prepays on day 1 distort the gross figure, and the user
   * cares about NET infra cost. Iskay must use `get_net_cost_breakdown`
   * (the waterfall: gross → marketplace → discounts → net) and must NOT
   * fall back to `get_total_cost`. Citing exact figures from the tool
   * output (no rounding-by-vibes) is non-negotiable, and `prettyService`
   * names mean no `cg…` codes should leak into the answer.
   */
  {
    id: "cuanto-cuesta-aws",
    question: "¿Cuánto cuesta AWS?",
    expectTools: ["get_net_cost_breakdown"],
    forbidTools: ["get_total_cost"],
    assertions: {
      noOpaqueIds: true,
      citesToolFigures: true,
    },
  },

  /**
   * (b) "¿Qué departamento gasta más en IA?" — tag-based attribution.
   *
   * Department / domain / team attribution lives in the `user_domain` CUR
   * tag, exposed via `get_cost_by_domain`. The wrong tool to reach for is
   * `get_cost_by_service` (which would surface "Bedrock" / "Kiro" but
   * cannot answer WHO is spending). `get_cost_by_domain` also returns the
   * tag coverage, which Iskay must surface honestly given the ~3-4%
   * coverage of `user_domain` today (steering §3, "tag coverage real").
   */
  {
    id: "departamento-mas-gasta-ia",
    question: "¿Qué departamento gasta más en IA?",
    expectTools: ["get_cost_by_domain"],
    forbidTools: ["get_cost_by_service"],
    assertions: {
      noOpaqueIds: true,
      citesToolFigures: true,
    },
  },

  /**
   * (c) Day-1 spike → marketplace contracts — gotcha #3 again.
   *
   * Big spend spikes on the 1st of the month are almost always annual
   * prepays for marketplace software contracts (`line_item_product_code
   * LIKE 'cg%'` / `Global-SoftwareUsage-Contracts`), not infrastructure.
   * Iskay must reach for `get_marketplace_charges` to attribute the spike
   * correctly. Citing exact figures and avoiding raw `cg…` codes
   * (translated by `prettyServiceName` to "Marketplace (contrato)") are
   * both required.
   */
  {
    id: "pico-dia-1-marketplace",
    question:
      "El día 1 de mayo hubo un pico de gasto fuerte. ¿De qué viene?",
    expectTools: ["get_marketplace_charges"],
    assertions: {
      noOpaqueIds: true,
      citesToolFigures: true,
    },
  },

  /**
   * (d) Out-of-scope — logs request must NOT trigger a cost lookup.
   *
   * Iskay is FinOps-only (steering §4 — "se retiraron las tools de
   * Kubernetes/OpenCost y de observabilidad"). When the user asks for
   * logs / traces / metrics, the right behavior is a clean redirect to
   * Grafana / the relevant dashboard, NOT inventing numbers and NOT
   * pulling cost data out of habit. The forbid list covers every cost +
   * inventory + report tool; only `list_accounts` is allowed (it is the
   * one benign directory call). The deterministic assertion also
   * verifies the answer mentions one of the canonical redirect hints
   * (`/metrics`, `iskaylog.grafana.net`, …).
   */
  {
    id: "out-of-scope-logs-oms",
    question: "Dame los logs de oms del último día",
    expectTools: [],
    forbidTools: [...ALL_FINOPS_TOOLS],
    assertions: {
      outOfScopeRedirect: true,
    },
  },

  /**
   * (e) Exact citation — the simplest, strictest contract.
   *
   * For "el coste total exacto del mes en curso", the agent must call
   * `get_total_cost` (this IS the gross-total question — the inverse of
   * case (a), where the user said "AWS de verdad"). Whatever number the
   * agent reports MUST appear in the tool output (citesToolFigures, ±0.5%
   * / ±$1 tolerance). And of course no opaque CUR ids in the prose.
   */
  {
    id: "cita-exacta",
    question: "Dame el coste total exacto del mes en curso, en USD",
    expectTools: ["get_total_cost"],
    assertions: {
      citesToolFigures: true,
      noOpaqueIds: true,
    },
  },

  /**
   * Smoke case — cheapest possible dry-run.
   *
   * `list_accounts` hits the AWS account catalog only (no Athena, no
   * CUR, one Bedrock turn). Useful to verify that the harness wiring,
   * the role chain and the SSE loop all work before paying for the
   * five real cases above.
   */
  {
    id: "smoke-list-accounts",
    question: "¿Qué cuentas AWS tenemos?",
    expectTools: ["list_accounts"],
    assertions: {},
  },
];
