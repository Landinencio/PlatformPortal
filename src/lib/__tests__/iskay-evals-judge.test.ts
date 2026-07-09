/**
 * Unit tests for the LLM-as-judge pure pieces (task 14).
 *
 * Covers (R11.1, R11.2):
 *  - `buildJudgePrompt`: deterministic, contains the case question, the
 *    final assistant text, the rubric description and the strict
 *    "ONLY a JSON object" instruction.
 *  - `parseJudgeResponse`: valid JSON; JSON wrapped in ``` / ```json
 *    fences; JSON preceded by prose; sub-scores clamped to range; total
 *    derived from sub-scores; malformed text falls back to score 0
 *    with rationale "judge returned non-JSON".
 *
 * The actual `judge()` orchestrator that calls Bedrock is NOT tested
 * here — that is the only impure piece of the module and exercising
 * it would require real Bedrock credentials. Per the task brief, the
 * judge call must NEVER throw; we instead test that contract by feeding
 * its parser arm (the place where any real-world failure would surface)
 * with a hostile set of inputs.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { AgentStep } from "../iskay-agent";
import {
  buildJudgePrompt,
  parseJudgeResponse,
  EMPTY_RUBRIC,
  JUDGE_MAX_SCORE,
} from "../../../ops/iskay-evals/judge";
import type { EvalCase } from "../../../ops/iskay-evals/cases";

/* ------------------------------------------------------------------ */
/*  buildJudgePrompt                                                    */
/* ------------------------------------------------------------------ */

const SAMPLE_CASE: EvalCase = {
  id: "sample-case",
  question: "¿Cuánto cuesta AWS este mes?",
  expectTools: ["get_net_cost_breakdown"],
  assertions: { citesToolFigures: true, noOpaqueIds: true },
};

const SAMPLE_TRACE: AgentStep[] = [
  { type: "tool_call", name: "get_net_cost_breakdown", input: { startDate: "2026-06-01", endDate: "2026-06-12" } },
  { type: "tool_result", name: "get_net_cost_breakdown", output: { gross: 100, net: 80 } },
  { type: "text", text: "Net infra: $80." },
];

test("buildJudgePrompt: includes the case id and question", () => {
  const prompt = buildJudgePrompt(SAMPLE_CASE, "Net infra: $80.", SAMPLE_TRACE);
  assert.match(prompt, /id: sample-case/);
  assert.match(prompt, /pregunta del usuario: ¿Cuánto cuesta AWS este mes\?/);
});

test("buildJudgePrompt: includes the assistant final text verbatim", () => {
  const prompt = buildJudgePrompt(SAMPLE_CASE, "Net infra: $80.", SAMPLE_TRACE);
  assert.match(prompt, /Net infra: \$80\./);
});

test("buildJudgePrompt: describes the rubric (clarity, correctness, grounded)", () => {
  const prompt = buildJudgePrompt(SAMPLE_CASE, "x", SAMPLE_TRACE);
  assert.match(prompt, /clarity \(0-3\)/);
  assert.match(prompt, /correctness \(0-4\)/);
  assert.match(prompt, /grounded \(0-3\)/);
});

test("buildJudgePrompt: demands JSON-only output with the four expected fields", () => {
  const prompt = buildJudgePrompt(SAMPLE_CASE, "x", SAMPLE_TRACE);
  // Must instruct "ONLY a JSON object", and must show the keys we'll parse.
  assert.match(prompt, /EXCLUSIVAMENTE UN OBJETO JSON/);
  assert.match(prompt, /"clarity"/);
  assert.match(prompt, /"correctness"/);
  assert.match(prompt, /"grounded"/);
  assert.match(prompt, /"rationale"/);
});

test("buildJudgePrompt: summarises trace with tool name + input + output", () => {
  const prompt = buildJudgePrompt(SAMPLE_CASE, "x", SAMPLE_TRACE);
  assert.match(prompt, /call get_net_cost_breakdown/);
  assert.match(prompt, /result get_net_cost_breakdown \[ok\]/);
  // Output JSON should appear in the trace summary.
  assert.match(prompt, /"gross":100/);
});

test("buildJudgePrompt: handles an empty trace gracefully", () => {
  const prompt = buildJudgePrompt(SAMPLE_CASE, "x", []);
  assert.match(prompt, /\(sin tool calls registradas\)/);
});

test("buildJudgePrompt: falls back to '(respuesta vacía)' for blank final text", () => {
  const prompt = buildJudgePrompt(SAMPLE_CASE, "   ", SAMPLE_TRACE);
  assert.match(prompt, /\(respuesta vacía\)/);
});

test("buildJudgePrompt: is deterministic for identical inputs", () => {
  const a = buildJudgePrompt(SAMPLE_CASE, "answer", SAMPLE_TRACE);
  const b = buildJudgePrompt(SAMPLE_CASE, "answer", SAMPLE_TRACE);
  assert.equal(a, b);
});

test("buildJudgePrompt: includes a tool_result error message when the tool failed", () => {
  const trace: AgentStep[] = [
    { type: "tool_call", name: "get_total_cost", input: {} },
    { type: "tool_result", name: "get_total_cost", errorMessage: "Athena timeout" },
  ];
  const prompt = buildJudgePrompt(SAMPLE_CASE, "x", trace);
  assert.match(prompt, /result get_total_cost \[ERROR\]: Athena timeout/);
});

/* ------------------------------------------------------------------ */
/*  parseJudgeResponse — valid JSON                                    */
/* ------------------------------------------------------------------ */

test("parseJudgeResponse: parses a clean JSON object", () => {
  const raw =
    '{"clarity": 3, "correctness": 4, "grounded": 3, "rationale": "perfecto"}';
  const verdict = parseJudgeResponse(raw);
  assert.equal(verdict.score, 10);
  assert.deepEqual(verdict.rubric, { clarity: 3, correctness: 4, grounded: 3 });
  assert.equal(verdict.rationale, "perfecto");
});

test("parseJudgeResponse: total equals the sum of sub-scores (derived, not trusted)", () => {
  // Even if the model returned a "score" field, we derive total locally.
  const raw =
    '{"clarity": 1, "correctness": 2, "grounded": 1, "score": 99, "rationale": "ok"}';
  const verdict = parseJudgeResponse(raw);
  assert.equal(verdict.score, 4); // 1 + 2 + 1, NOT 99
});

test("parseJudgeResponse: clamps sub-scores to their max ranges", () => {
  const raw =
    '{"clarity": 9, "correctness": 12, "grounded": 7, "rationale": "demasiado alto"}';
  const verdict = parseJudgeResponse(raw);
  assert.deepEqual(verdict.rubric, { clarity: 3, correctness: 4, grounded: 3 });
  assert.equal(verdict.score, JUDGE_MAX_SCORE);
});

test("parseJudgeResponse: clamps negative sub-scores to 0", () => {
  const raw =
    '{"clarity": -1, "correctness": -5, "grounded": -3, "rationale": "negativos"}';
  const verdict = parseJudgeResponse(raw);
  assert.deepEqual(verdict.rubric, { ...EMPTY_RUBRIC });
  assert.equal(verdict.score, 0);
});

test("parseJudgeResponse: rounds non-integer sub-scores", () => {
  const raw =
    '{"clarity": 2.7, "correctness": 1.4, "grounded": 0.5, "rationale": "decimales"}';
  const verdict = parseJudgeResponse(raw);
  // 2.7 → 3, 1.4 → 1, 0.5 → 1 (Math.round half-up away from zero)
  assert.equal(verdict.rubric.clarity, 3);
  assert.equal(verdict.rubric.correctness, 1);
  assert.equal(verdict.rubric.grounded, 1);
  assert.equal(verdict.score, 5);
});

test("parseJudgeResponse: missing rubric fields default to 0", () => {
  const raw = '{"clarity": 2, "rationale": "sólo clarity"}';
  const verdict = parseJudgeResponse(raw);
  assert.deepEqual(verdict.rubric, { clarity: 2, correctness: 0, grounded: 0 });
  assert.equal(verdict.score, 2);
  assert.equal(verdict.rationale, "sólo clarity");
});

test("parseJudgeResponse: missing rationale falls back to placeholder", () => {
  const raw = '{"clarity": 1, "correctness": 1, "grounded": 1}';
  const verdict = parseJudgeResponse(raw);
  assert.equal(verdict.rationale, "(no rationale)");
});

/* ------------------------------------------------------------------ */
/*  parseJudgeResponse — code fences                                   */
/* ------------------------------------------------------------------ */

test("parseJudgeResponse: strips ```json fenced blocks", () => {
  const raw =
    '```json\n{"clarity": 2, "correctness": 3, "grounded": 2, "rationale": "ok"}\n```';
  const verdict = parseJudgeResponse(raw);
  assert.equal(verdict.score, 7);
  assert.deepEqual(verdict.rubric, { clarity: 2, correctness: 3, grounded: 2 });
});

test("parseJudgeResponse: strips bare ``` fenced blocks", () => {
  const raw =
    '```\n{"clarity": 1, "correctness": 2, "grounded": 1, "rationale": "fence"}\n```';
  const verdict = parseJudgeResponse(raw);
  assert.equal(verdict.score, 4);
});

test("parseJudgeResponse: tolerates fenced blocks without trailing newline", () => {
  const raw =
    '```json{"clarity": 0, "correctness": 0, "grounded": 0, "rationale": "tight"}```';
  const verdict = parseJudgeResponse(raw);
  assert.equal(verdict.score, 0);
  assert.equal(verdict.rationale, "tight");
});

/* ------------------------------------------------------------------ */
/*  parseJudgeResponse — JSON inside prose                             */
/* ------------------------------------------------------------------ */

test("parseJudgeResponse: extracts JSON when preceded by prose", () => {
  const raw =
    "Aquí está la evaluación:\n" +
    '{"clarity": 3, "correctness": 4, "grounded": 3, "rationale": "todo bien"}\n' +
    "Espero que sea útil.";
  const verdict = parseJudgeResponse(raw);
  assert.equal(verdict.score, 10);
  assert.equal(verdict.rationale, "todo bien");
});

test("parseJudgeResponse: handles nested objects in rationale-like strings", () => {
  const raw =
    'Resultado: {"clarity": 2, "correctness": 3, "grounded": 2, "rationale": "incluye {detalle: x}"}';
  const verdict = parseJudgeResponse(raw);
  assert.equal(verdict.score, 7);
  assert.equal(verdict.rationale, "incluye {detalle: x}");
});

/* ------------------------------------------------------------------ */
/*  parseJudgeResponse — malformed inputs (R: never throws)            */
/* ------------------------------------------------------------------ */

test("parseJudgeResponse: malformed text → score 0 with 'judge returned non-JSON'", () => {
  const verdict = parseJudgeResponse("esto no es JSON, sólo prosa libre");
  assert.equal(verdict.score, 0);
  assert.deepEqual(verdict.rubric, { ...EMPTY_RUBRIC });
  assert.equal(verdict.rationale, "judge returned non-JSON");
});

test("parseJudgeResponse: empty string → score 0 with the same rationale", () => {
  const verdict = parseJudgeResponse("");
  assert.equal(verdict.score, 0);
  assert.deepEqual(verdict.rubric, { ...EMPTY_RUBRIC });
  assert.equal(verdict.rationale, "judge returned non-JSON");
});

test("parseJudgeResponse: whitespace-only → score 0 with the same rationale", () => {
  const verdict = parseJudgeResponse("   \n\t  ");
  assert.equal(verdict.score, 0);
  assert.equal(verdict.rationale, "judge returned non-JSON");
});

test("parseJudgeResponse: JSON array (not object) → score 0", () => {
  // We strictly expect an OBJECT, not an array.
  const verdict = parseJudgeResponse('[1, 2, 3]');
  assert.equal(verdict.score, 0);
  assert.equal(verdict.rationale, "judge returned non-JSON");
});

test("parseJudgeResponse: unbalanced braces → score 0 with the same rationale", () => {
  const verdict = parseJudgeResponse('{"clarity": 1, "correctness": 2');
  assert.equal(verdict.score, 0);
  assert.equal(verdict.rationale, "judge returned non-JSON");
});

test("parseJudgeResponse: non-string input is treated as malformed", () => {
  // The runtime contract says `string` but we never want to throw on bad input.
  const verdict = parseJudgeResponse(undefined as unknown as string);
  assert.equal(verdict.score, 0);
  assert.equal(verdict.rationale, "judge returned non-JSON");
});
