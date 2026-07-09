#!/usr/bin/env -S npx tsx
/**
 * Iskay evals — runner.
 *
 * Reuses the production agent loop (`runIskayAgent` from `@/lib/iskay-agent`)
 * with the SAME system prompt, the SAME tool catalog and the SAME Bedrock
 * client wiring as the chat route. For each `EvalCase`:
 *   1. Run the agent loop, capturing the full trace.
 *   2. Apply the deterministic assertion engine in `./assertions`
 *      (`expectTools`, `forbidTools`, `citesToolFigures`, `noOpaqueIds`,
 *      `period`, `outOfScopeRedirect`).
 *   3. Record pass/fail + failures + trace + final text.
 *   4. A case that throws is captured as fail (R8.4) — the runner moves on.
 *
 * At the end, prints a pretty table to stdout (`id | tools used | pass/fail
 * | failures`) and an aggregate score (`passed/total`). When `--judge` is
 * also set, every executed case is graded by Bedrock against a small rubric
 * (clarity / correctness / grounded → 0-10), the table gains a `judge`
 * column and the aggregate prints `Judge avg X.XX/10` on top of the
 * deterministic pass/fail. Without `--judge`, NO Bedrock judge call is
 * made (R11.2).
 *
 * Tasks 13 (the 5 golden cases) and 14 (LLM-judge) extend the case set and
 * the optional qualitative scoring; the deterministic engine here is enough
 * to gate "ready to open Iskay to the company" on its own.
 *
 * Usage:
 *   npx tsx ops/iskay-evals/run.ts            # run all cases (deterministic)
 *   npx tsx ops/iskay-evals/run.ts --filter <id>
 *   npx tsx ops/iskay-evals/run.ts --judge    # also score with Bedrock
 *   npx tsx ops/iskay-evals/run.ts --ids      # list ids and exit
 *
 * SAFETY: read-only. The harness invokes the same Athena/CUR/Bedrock APIs
 * the live route does, using the same role chain. It does NOT touch
 * production data, but it CAN incur Bedrock + Athena costs — hence the
 * banner at startup.
 */

// NOTE: the agent module is imported lazily inside `main()` so `--ids` and
// `--help` work without pulling the AWS SDK chain (which requires Node 18+
// globals like `TransformStream`). Production runs Node 20, but operators
// poking at the harness from an older shell can still list cases.
import type { AgentStep, RunAgentResult } from "@/lib/iskay-agent";

import { runAssertions } from "./assertions";
import { EVAL_CASES, type EvalCase } from "./cases";
import type { JudgeVerdict } from "./judge";
import { JUDGE_MAX_SCORE } from "./judge";

interface EvalResult {
  id: string;
  pass: boolean;
  failures: string[];
  trace: AgentStep[];
  finalText: string;
  /** Distinct tool names seen in the trace, preserving call order. */
  toolsUsed: string[];
  /** Set when the case threw before assertions ran. */
  errorMessage?: string;
  /** Optional LLM-judge verdict. Set when `--judge` is enabled (R11.1);
   *  remains `undefined` otherwise so no Bedrock call is made (R11.2). */
  judge?: JudgeVerdict;
}

interface CliFlags {
  filter?: string;
  listIds: boolean;
  help: boolean;
  /** When true, runs the LLM-as-judge pass on top of the deterministic
   *  assertions for every executed case (R11.1). Default false (R11.2). */
  judge: boolean;
}

function parseCli(argv: string[]): CliFlags {
  const flags: CliFlags = { listIds: false, help: false, judge: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--ids") flags.listIds = true;
    else if (a === "--judge") flags.judge = true;
    else if (a === "--filter") {
      const next = argv[i + 1];
      if (!next) {
        console.error("--filter requires a case id (e.g. --filter smoke-list-accounts)");
        process.exit(2);
      }
      flags.filter = next;
      i++;
    }
  }
  return flags;
}

function printBanner(): void {
  const bar = "─".repeat(64);
  console.log(bar);
  console.log("Iskay evals — read-only, may incur Bedrock cost");
  console.log(bar);
}

function printHelp(): void {
  console.log(`Usage:
  npx tsx ops/iskay-evals/run.ts                run all cases (deterministic)
  npx tsx ops/iskay-evals/run.ts --filter <id>  run only the case with that id
  npx tsx ops/iskay-evals/run.ts --judge        also score every case with Bedrock (LLM-as-judge)
  npx tsx ops/iskay-evals/run.ts --ids          list case ids and exit
  npx tsx ops/iskay-evals/run.ts --help         show this help`);
}

/** Distinct tool names from a trace, in first-seen order. */
function toolsUsedFromTrace(trace: AgentStep[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const step of trace) {
    if (step.type !== "tool_call" || !step.name) continue;
    if (seen.has(step.name)) continue;
    seen.add(step.name);
    order.push(step.name);
  }
  return order;
}

/** Run a single case — never throws; errors are captured into the result. */
async function runOne(
  ec: EvalCase,
  runAgent: (opts: { question: string }) => Promise<RunAgentResult>,
): Promise<EvalResult> {
  try {
    const result = await runAgent({ question: ec.question });
    const toolsUsed = toolsUsedFromTrace(result.trace);

    // The orchestrator below already wraps individual assertions in try/catch,
    // but we keep an outer guard so even a catastrophic bug in the engine
    // itself is captured as a fail for THIS case rather than aborting the
    // whole suite (R8.4).
    let failures: string[];
    try {
      failures = runAssertions(ec, {
        trace: result.trace,
        finalText: result.finalText,
        toolsUsed,
      });
    } catch (assertErr: any) {
      failures = [
        `assertion engine threw: ${assertErr?.message || String(assertErr)}`,
      ];
    }

    return {
      id: ec.id,
      pass: failures.length === 0,
      failures,
      trace: result.trace,
      finalText: result.finalText,
      toolsUsed,
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    return {
      id: ec.id,
      pass: false,
      failures: [`agent loop threw: ${msg}`],
      trace: [],
      finalText: "",
      toolsUsed: [],
      errorMessage: msg,
    };
  }
}

/** Pretty stdout table — id | tools used | pass/fail | judge? | failures. */
function printResultsTable(results: EvalResult[], judgeEnabled: boolean): void {
  const header = judgeEnabled
    ? ["id", "tools used", "pass/fail", "judge", "failures"]
    : ["id", "tools used", "pass/fail", "failures"];

  const rows = results.map((r) => {
    const judgeCell = r.judge
      ? `${r.judge.score}/${JUDGE_MAX_SCORE}`
      : "—";
    if (judgeEnabled) {
      return [
        r.id,
        r.toolsUsed.join(", ") || "—",
        r.pass ? "PASS" : "FAIL",
        judgeCell,
        r.failures.join(" | ") || "—",
      ];
    }
    return [
      r.id,
      r.toolsUsed.join(", ") || "—",
      r.pass ? "PASS" : "FAIL",
      r.failures.join(" | ") || "—",
    ];
  });

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length)),
  );

  const fmtRow = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i], " ")).join("  ");

  const sep = widths.map((w) => "─".repeat(w)).join("  ");

  console.log("");
  console.log(fmtRow(header));
  console.log(sep);
  for (const row of rows) console.log(fmtRow(row));
  console.log(sep);
}

async function main(): Promise<void> {
  const flags = parseCli(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    return;
  }

  if (flags.listIds) {
    for (const c of EVAL_CASES) console.log(c.id);
    return;
  }

  printBanner();

  const cases = flags.filter
    ? EVAL_CASES.filter((c) => c.id === flags.filter)
    : EVAL_CASES;

  if (cases.length === 0) {
    if (flags.filter) {
      console.error(`No case matches --filter ${flags.filter}`);
      console.error(`Known ids: ${EVAL_CASES.map((c) => c.id).join(", ") || "(none)"}`);
      process.exit(2);
    }
    console.log("No eval cases defined yet. Add some to ops/iskay-evals/cases.ts.");
    return;
  }

  console.log(`Running ${cases.length} case(s)...`);
  if (flags.judge) {
    console.log("LLM-as-judge enabled (one Bedrock call per executed case).");
  }

  // Lazy import: pulling `@/lib/iskay-agent` triggers the AWS SDK chain,
  // which requires Node 18+ globals. Defer until we actually need it so
  // `--ids` / `--help` keep working on any Node.
  const { runIskayAgent } = await import("@/lib/iskay-agent");

  // The judge module is also lazy-loaded — it pulls the same SDK chain
  // and we only need it when `--judge` is set. The Bedrock client is
  // built once and reused across cases (each judge call is independent
  // and stateless, so a single client is enough).
  let judgeFn: typeof import("./judge").judge | undefined;
  let bedrockClient: any | undefined;
  if (flags.judge) {
    const judgeMod = await import("./judge");
    judgeFn = judgeMod.judge;
    const { buildBedrockClient } = await import("@/lib/iskay-agent");
    try {
      bedrockClient = await buildBedrockClient();
    } catch (err: any) {
      // We never throw out of the runner because of the judge — fall
      // back to the per-call error path, which records "judge failed:
      // <message>" in the rationale.
      const msg = err?.message || String(err);
      console.error(`Could not build Bedrock client for judge: ${msg}`);
    }
  }

  const results: EvalResult[] = [];
  for (const ec of cases) {
    process.stdout.write(`  • ${ec.id} ... `);
    const r = await runOne(ec, runIskayAgent);
    if (flags.judge && judgeFn) {
      // The judge call NEVER throws — see judge.ts. Worst case it
      // returns a `judge failed: ...` rationale with score 0. We do
      // NOT change `r.pass`: judge feedback is informational on top
      // of the deterministic pass/fail.
      r.judge = await judgeFn(ec, r.finalText, r.trace, bedrockClient);
      process.stdout.write(
        `${r.pass ? "PASS" : "FAIL"} (judge ${r.judge.score}/${JUDGE_MAX_SCORE})\n`,
      );
    } else {
      process.stdout.write(`${r.pass ? "PASS" : "FAIL"}\n`);
    }
    results.push(r);
  }

  printResultsTable(results, flags.judge);

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const score = total > 0 ? ((passed / total) * 100).toFixed(0) : "0";
  console.log("");
  console.log(`Score: ${passed}/${total} (${score}%)`);

  if (flags.judge) {
    const judged = results.filter((r) => r.judge !== undefined);
    if (judged.length > 0) {
      const avg =
        judged.reduce((acc, r) => acc + (r.judge?.score ?? 0), 0) /
        judged.length;
      console.log(`Judge avg: ${avg.toFixed(2)}/${JUDGE_MAX_SCORE}`);
    }
  }

  // Non-zero exit code if anything failed — handy for CI wiring later.
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error("Iskay evals runner crashed:", err?.message || err);
  process.exit(1);
});
