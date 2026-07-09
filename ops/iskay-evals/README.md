# Iskay evals

Offline harness that exercises the Iskay agent loop against a set of golden
cases, reusing the **same** system prompt + tool catalog as the production
chat route (`src/lib/iskay-agent.ts`). Read-only, but it does invoke real
Athena/CUR/Bedrock — expect Bedrock cost per run.

## Run

```bash
npx tsx ops/iskay-evals/run.ts                # all cases (deterministic)
npx tsx ops/iskay-evals/run.ts --filter <id>  # one case
npx tsx ops/iskay-evals/run.ts --judge        # also score with LLM-as-judge
npx tsx ops/iskay-evals/run.ts --ids          # list ids
```

Prints `id | tools used | pass/fail | failures` plus an aggregate
`passed/total` score. A failing case never aborts the suite. Exit code is
non-zero if anything failed.

## `--judge` (optional, off by default)

Without `--judge`, the runner only applies the deterministic assertion
engine (`expectTools`, `forbidTools`, `citesToolFigures`, `noOpaqueIds`,
`period`, `outOfScopeRedirect`). No Bedrock judge call is made.

When `--judge` is set, every executed case is also scored by Bedrock
against a small rubric:

| Axis        | Range | Meaning                                           |
| ----------- | ----- | ------------------------------------------------- |
| clarity     | 0-3   | Clear, well-structured Spanish                    |
| correctness | 0-4   | Actually answers the question with the right tool |
| grounded    | 0-3   | Every figure backed by a `toolResult`             |
| **total**   | 0-10  | Sum of the three sub-scores                       |

Output gains a `judge` column (e.g. `7/10`) and the aggregate prints
`Judge avg X.XX/10` on top of the deterministic pass/fail. A judge call
that fails (network outage, malformed response, missing client) never
sinks the suite — it is recorded as score 0 with rationale
`judge failed: <message>` and the next case runs as usual.

By default the judge model is the same as Iskay (`FINOPS_CHAT_MODEL_ID`,
currently Sonnet 4); set `ISKAY_JUDGE_MODEL_ID` to override it. The
Bedrock client wiring (region + STS chain) is reused from
`buildBedrockClient` in `@/lib/iskay-agent`, so the judge runs against
the same role and account as the production chat route.
