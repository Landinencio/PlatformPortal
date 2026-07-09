/**
 * Iskay evals — LLM-as-judge (task 14, optional qualitative scoring).
 *
 * Adds a *qualitative* scoring layer on top of the deterministic
 * assertion engine: when the runner is invoked with `--judge`, every
 * case's final answer is graded by Bedrock against a small rubric
 * (clarity / correctness / grounded). Without `--judge` (the default)
 * NO Bedrock judge call is made — only the deterministic assertions
 * run, satisfying R11.2.
 *
 * Design notes:
 *  - **Pure pieces are exported** (`buildJudgePrompt`,
 *    `parseJudgeResponse`, `EMPTY_RUBRIC`) so unit tests can pin them
 *    without paying for a Bedrock call.
 *  - **`judge()` never throws.** Any error — Bedrock outage, network
 *    timeout, malformed JSON, model returning prose — is caught and
 *    surfaces as `{ score: 0, rubric: zeroes, rationale: "judge failed:
 *    <message>" }`. The eval suite must keep going even if the judge
 *    is down (R11.1: judging is opportunistic, not the source of truth).
 *  - **Rubric**: clarity 0-3, correctness 0-4, grounded 0-3 → total
 *    0-10. Total is *derived* from the three sub-scores so the model
 *    cannot game it independently.
 *  - **Same client wiring as the agent.** `buildBedrockClient()` from
 *    `@/lib/iskay-agent` performs the same STS chain as production, so
 *    the judge runs against the same role and region as Iskay itself.
 *  - **Same model by default** (`FINOPS_CHAT_MODEL_ID`). Override is
 *    available via `ISKAY_JUDGE_MODEL_ID` for operators who want to
 *    grade Sonnet 4 with a different model.
 *  - **Lenient JSON parsing.** The model is asked for "ONLY a JSON
 *    object" but in practice often wraps it in ```json fences```, adds
 *    leading prose, or returns the object inside an array. We strip
 *    fences, trim, scan for the first `{`, and fall back to score 0
 *    with a clear rationale when nothing parseable is found.
 */

import type {
  BedrockRuntimeClient,
} from "@aws-sdk/client-bedrock-runtime";

import type { AgentStep } from "@/lib/iskay-agent";

import type { EvalCase } from "./cases";

/** Rubric sub-scores. Ranges enforced during parsing/clamping. */
export interface JudgeRubric {
  /** 0-3: is the answer easy to read, well structured, in Spanish? */
  clarity: number;
  /** 0-4: does the answer correctly address the question? */
  correctness: number;
  /** 0-3: is every claim grounded in tool output (no hallucinated $)? */
  grounded: number;
}

/** Full judge verdict for a single case. */
export interface JudgeVerdict {
  /** Total score 0-10, derived from rubric sub-scores. */
  score: number;
  rubric: JudgeRubric;
  /** Short free-text explanation from the judge model (or the failure
   *  reason when the call/parse failed). */
  rationale: string;
}

/** Zero-rubric used as the safe fallback. */
export const EMPTY_RUBRIC: JudgeRubric = {
  clarity: 0,
  correctness: 0,
  grounded: 0,
};

/** Rubric upper bounds. */
const MAX_CLARITY = 3;
const MAX_CORRECTNESS = 4;
const MAX_GROUNDED = 3;
/** Total is the sum of the three sub-scores. */
const MAX_TOTAL = MAX_CLARITY + MAX_CORRECTNESS + MAX_GROUNDED; // 10

/**
 * Resolve the judge model id. Defaults to the Iskay model
 * (`FINOPS_CHAT_MODEL_ID`) so the same Bedrock setup applies; operators
 * can override via `ISKAY_JUDGE_MODEL_ID`. The literal default mirrors
 * `BEDROCK_MODEL` in `@/lib/iskay-agent`; we duplicate it here instead
 * of runtime-importing the agent module so the pure pieces of this
 * module stay free of the AWS SDK chain (which requires Node 18+).
 */
export function resolveJudgeModel(): string {
  return (
    process.env.ISKAY_JUDGE_MODEL_ID?.trim() ||
    process.env.FINOPS_CHAT_MODEL_ID?.trim() ||
    process.env.AWS_BEDROCK_MODEL_ID?.trim() ||
    "eu.anthropic.claude-sonnet-4-20250514-v1:0"
  );
}

/* ------------------------------------------------------------------ */
/*  Prompt building (PURE — exported for tests)                        */
/* ------------------------------------------------------------------ */

/**
 * Build the judge prompt for one case.
 *
 * The prompt restates the user question, the assistant's final answer
 * and a compact summary of the trace (which tools were invoked + the
 * shape of the data they returned, truncated). Asks the model to score
 * the answer against the rubric and return ONLY a JSON object with the
 * four fields. Kept deterministic — no dates, no random salt — so two
 * calls with the same inputs yield comparable scores.
 */
export function buildJudgePrompt(
  ec: EvalCase,
  finalText: string,
  trace: AgentStep[],
): string {
  const summary = summarizeTrace(trace);

  const lines: string[] = [
    "Eres un evaluador imparcial de respuestas FinOps. Tu tarea es puntuar la",
    'respuesta del asistente "Iskay" contra una rúbrica precisa.',
    "",
    "RÚBRICA (puntúa cada eje de forma independiente):",
    "- clarity (0-3): claridad y estructura en español. ¿Es fácil de leer?",
    "  ¿Tablas/listas cuando ayuda? ¿Sin jerga innecesaria?",
    "- correctness (0-4): ¿Responde realmente a la pregunta del usuario? ¿Usa",
    "  el enfoque correcto (p. ej. net vs gross, dominio vs servicio)?",
    "- grounded (0-3): ¿Cada cifra y dato proviene de un toolResult? ¿Ningún",
    "  ID opaco crudo (cg…/inference-profile) en la prosa? Si la respuesta",
    "  inventa números, este eje debe ser 0.",
    "",
    "FORMATO DE SALIDA — DEVUELVE EXCLUSIVAMENTE UN OBJETO JSON con esta forma",
    "y NADA MÁS (ni texto antes, ni texto después, ni bloque de código):",
    '{"clarity": <0-3>, "correctness": <0-4>, "grounded": <0-3>, "rationale":',
    ' "<una frase breve en español justificando los tres números>"}',
    "",
    "Si no puedes decidir, sé conservador y puntúa bajo. NO inventes datos",
    "que no estén en la respuesta o en el resumen del trace.",
    "",
    "─── CASO ───",
    `id: ${ec.id}`,
    `pregunta del usuario: ${ec.question}`,
    "",
    "─── HERRAMIENTAS INVOCADAS ───",
    summary,
    "",
    "─── RESPUESTA DEL ASISTENTE ───",
    finalText.trim() || "(respuesta vacía)",
  ];

  return lines.join("\n");
}

/**
 * Compact human-readable summary of the trace: which tools were called
 * (in order) and a tiny sample of each toolResult so the judge can tell
 * if the prose actually reflects the data. Bounded in length so the
 * prompt stays manageable.
 */
function summarizeTrace(trace: AgentStep[]): string {
  if (!Array.isArray(trace) || trace.length === 0) {
    return "(sin tool calls registradas)";
  }
  const lines: string[] = [];
  let i = 0;
  for (const step of trace) {
    if (step.type === "tool_call") {
      const inputJson = safeJson(step.input, 200);
      lines.push(`#${++i} call ${step.name} ← ${inputJson}`);
    } else if (step.type === "tool_result") {
      const tag = step.errorMessage ? "ERROR" : "ok";
      const body = step.errorMessage
        ? step.errorMessage
        : safeJson(step.output, 400);
      lines.push(`   result ${step.name} [${tag}]: ${body}`);
    }
  }
  // Hard cap to keep the prompt small even when many tools fire.
  const joined = lines.join("\n");
  if (joined.length <= 4000) return joined;
  return joined.slice(0, 4000) + "\n... [truncated]";
}

function safeJson(value: unknown, max: number): string {
  try {
    const s = JSON.stringify(value ?? null);
    return s.length <= max ? s : s.slice(0, max) + "…";
  } catch {
    return String(value);
  }
}

/* ------------------------------------------------------------------ */
/*  Response parsing (PURE — exported for tests)                       */
/* ------------------------------------------------------------------ */

/**
 * Lenient JSON parser for the judge response.
 *
 * Accepts:
 *  - Plain JSON object: `{"clarity":2,...}`.
 *  - JSON wrapped in code fences: ```json\n{...}\n``` (or plain ``` ).
 *  - JSON preceded/followed by prose: scans for the first `{` and the
 *    matching `}` block.
 *
 * Returns the parsed verdict on success. On failure, returns a
 * conservative `score: 0` verdict with a rationale that flags the
 * cause — never throws.
 *
 * Sub-scores are clamped to their ranges (`clarity` 0-3, `correctness`
 * 0-4, `grounded` 0-3) and rounded to integers; the total is recomputed
 * from the clamped sub-scores so it always lies in 0-10 and matches the
 * rubric definition.
 */
export function parseJudgeResponse(raw: string): JudgeVerdict {
  if (typeof raw !== "string" || !raw.trim()) {
    return {
      score: 0,
      rubric: { ...EMPTY_RUBRIC },
      rationale: "judge returned non-JSON",
    };
  }

  const stripped = stripCodeFences(raw).trim();
  const candidate = extractFirstJsonObject(stripped);
  if (!candidate) {
    return {
      score: 0,
      rubric: { ...EMPTY_RUBRIC },
      rationale: "judge returned non-JSON",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return {
      score: 0,
      rubric: { ...EMPTY_RUBRIC },
      rationale: "judge returned non-JSON",
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      score: 0,
      rubric: { ...EMPTY_RUBRIC },
      rationale: "judge returned non-JSON",
    };
  }

  const obj = parsed as Record<string, unknown>;
  const clarity = clampInt(obj.clarity, 0, MAX_CLARITY);
  const correctness = clampInt(obj.correctness, 0, MAX_CORRECTNESS);
  const grounded = clampInt(obj.grounded, 0, MAX_GROUNDED);
  const rationale =
    typeof obj.rationale === "string" && obj.rationale.trim()
      ? obj.rationale.trim()
      : "(no rationale)";

  const score = clarity + correctness + grounded;
  return {
    score,
    rubric: { clarity, correctness, grounded },
    rationale,
  };
}

/** Strip ``` / ```json fences from a string (any number of leading/trailing
 *  fences). Tolerant: returns input unchanged if it does not look fenced. */
function stripCodeFences(text: string): string {
  let out = text.trim();
  // Match an opening fence with optional language tag.
  const open = out.match(/^```(?:json|JSON)?\s*\n?/);
  if (open) out = out.slice(open[0].length);
  // Match a trailing fence.
  out = out.replace(/\n?```\s*$/, "");
  return out;
}

/** Find the first balanced `{...}` block in `text`. Returns the substring
 *  (still potentially malformed JSON, JSON.parse handles that) or null. */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  const rounded = Math.round(n);
  if (rounded < lo) return lo;
  if (rounded > hi) return hi;
  return rounded;
}

/* ------------------------------------------------------------------ */
/*  Bedrock call (NEVER throws)                                        */
/* ------------------------------------------------------------------ */

/**
 * Score a single case with Bedrock against the rubric.
 *
 * Contract:
 *  - Builds the prompt via `buildJudgePrompt`.
 *  - Calls `ConverseCommand` (non-streaming) on the configured judge
 *    model with `temperature: 0` to keep the score deterministic.
 *  - Parses the response leniently via `parseJudgeResponse`.
 *  - On ANY error (Bedrock outage, missing client, malformed response)
 *    returns a safe verdict `{score: 0, rubric: zeroes, rationale:
 *    "judge failed: <message>"}` and **never throws**. The eval suite
 *    keeps running and the operator sees the failure in the rationale
 *    column of the printed table.
 */
export async function judge(
  ec: EvalCase,
  finalText: string,
  trace: AgentStep[],
  client: BedrockRuntimeClient,
): Promise<JudgeVerdict> {
  try {
    if (!client) {
      throw new Error("missing Bedrock client");
    }
    const prompt = buildJudgePrompt(ec, finalText, trace);
    // Lazy-import to keep the AWS SDK chain (which needs `TransformStream`
    // / Node 18+) out of the synchronous import graph. Tests for the pure
    // helpers above can therefore import this module on any Node version
    // without paying that cost.
    const { ConverseCommand } = await import(
      "@aws-sdk/client-bedrock-runtime"
    );
    const cmd = new ConverseCommand({
      modelId: resolveJudgeModel(),
      messages: [{ role: "user", content: [{ text: prompt }] }],
      // Keep temperature 0 so the judge is reproducible across runs.
      inferenceConfig: { maxTokens: 512, temperature: 0 },
    });
    const resp = await client.send(cmd);
    const blocks = (resp.output?.message?.content || []) as any[];
    const raw = blocks
      .map((b) => (typeof b?.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
    return parseJudgeResponse(raw);
  } catch (err: any) {
    const msg = err?.message || String(err);
    return {
      score: 0,
      rubric: { ...EMPTY_RUBRIC },
      rationale: `judge failed: ${msg}`,
    };
  }
}

/** Convenience: max possible score (10). Exported so the runner can
 *  print "judge avg X.XX/10" without re-deriving the constant. */
export const JUDGE_MAX_SCORE = MAX_TOTAL;
