/**
 * Citation_Guard — "log & measure" mode (Iskay FinOps specialist).
 *
 * Pure helpers used by `POST /api/ai/finops-chat` to verify that every
 * monetary amount cited in Iskay's final answer maps to a number that
 * actually came back from a tool call in this conversation.
 *
 * The guard is **non-blocking** and **side-effect-free**. It only
 * computes a discrepancy report; the route logs the result as telemetry
 * and never mutates the response. See spec
 * `.kiro/specs/iskay-finops-specialist/` (R12.1, R12.2).
 *
 * Design notes:
 *  - Pure module: no DB / IO / network. Safe to import anywhere.
 *  - Tolerant matching: a cited amount counts as "matched" when at
 *    least one tool number is within ±0.5% (or ±$1 floor for
 *    very small figures). This absorbs trivial rounding without
 *    flagging the model for correctly-rounded prose.
 *  - Recursive scanning of toolResults: numbers can live arbitrarily
 *    deep inside nested objects/arrays produced by the tools.
 *  - Best effort regex: covers `$1,234.56`, `1234.56 USD`, `1,234 USD`,
 *    `1234.5`, with optional `~`/`≈` prefix and decimal separator.
 *
 * Mode: **loguea y mide** — never throws, never blocks the response.
 */

/** Match relative tolerance (±0.5%). Picked deliberately wide so common
 *  rounding ("$1,234.56" vs internal `1234.5567`) never flags. */
const REL_TOLERANCE = 0.005;
/** Absolute floor in USD; covers cases where 0.5% would be sub-cent. */
const ABS_TOLERANCE = 1;

/**
 * Money patterns Iskay (and Sonnet 4 in Spanish) tends to use:
 *  - `$1,234.56`, `$1234`, `$ 1,234.56`
 *  - `1,234.56 USD`, `1.234,56 USD`, `1234 USD`
 *  - bare floats with two decimals after a label like "Total: 1234.56"
 *    (caught by a looser fallback that requires the trailing currency
 *    or `$` prefix to avoid grabbing every integer in the prose).
 *
 * We deliberately accept both `,` and `.` as thousands separator so that
 * the European `1.234,56` style is also captured. The normaliser below
 * disambiguates to a JS Number.
 *
 * The captured digit group always starts AND ends with a digit so that
 * a trailing sentence period (e.g. `$1,234.56.`) is not absorbed.
 */
const NUMBER_GROUP = `\\d(?:[\\d.,]*\\d)?`;
const MONEY_RE = new RegExp(
  `(?:[~≈]?\\s*)(?:\\$\\s*(${NUMBER_GROUP})|(${NUMBER_GROUP})\\s*(?:USD|usd|US\\$|EUR|€))`,
  "g",
);

/**
 * Normalises a captured numeric string to a JavaScript number.
 *
 * Handles:
 *  - `1,234.56` (US):     thousands `,`, decimal `.`     → 1234.56
 *  - `1.234,56` (EU):     thousands `.`, decimal `,`     → 1234.56
 *  - `1234.5`:            plain decimal                  → 1234.5
 *  - `1234`:              plain integer                  → 1234
 *  - `1,234`:             thousands only                 → 1234
 *  - `1.234`:             ambiguous → US decimal (1.234)
 *
 * Strategy: find the LAST separator. If the digit group AFTER it has
 * exactly 3 digits AND it is the only separator of that kind, treat
 * the separator as a thousands grouping (strip it). Otherwise treat
 * it as the decimal separator (everything before becomes integer
 * part, with the OTHER separator stripped as thousands).
 *
 * Returns `NaN` when the input cannot be reasonably interpreted as a
 * number; callers filter those out.
 */
export function normalizeAmount(raw: string): number {
  const s = String(raw || "").trim();
  if (!s) return NaN;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  if (lastComma === -1 && lastDot === -1) {
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  // Determine which separator (if any) is the decimal one. The decimal
  // separator is the LAST separator of either kind, but ONLY if the digit
  // group after it doesn't look like a thousands grouping (3 digits) when
  // it's the only separator present.
  const lastSepIsComma = lastComma > lastDot;
  const lastSep = lastSepIsComma ? "," : ".";
  const otherSep = lastSepIsComma ? "." : ",";
  const tail = s.slice(s.lastIndexOf(lastSep) + 1);
  const hasOther = s.indexOf(otherSep) !== -1;

  // If only one kind of separator is present and the tail has exactly 3
  // digits, treat it as thousands (e.g. `1,234` and `1.234`). Otherwise
  // treat the last separator as the decimal point.
  let normalised: string;
  if (!hasOther && /^\d{3}$/.test(tail)) {
    normalised = s.split(lastSep).join("");
  } else {
    // Strip every occurrence of the OTHER separator (thousands), then
    // swap the LAST separator to a `.` decimal point.
    const withoutThousands = s.split(otherSep).join("");
    const idx = withoutThousands.lastIndexOf(lastSep);
    normalised =
      withoutThousands.slice(0, idx) + "." + withoutThousands.slice(idx + 1);
  }

  const n = Number(normalised);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Extracts every monetary amount cited in `text` and returns the unique
 * normalised numbers, sorted ascending for deterministic output.
 *
 * Pure function — no side effects, safe to call from anywhere. Returns
 * an empty array when `text` is empty or contains no recognisable
 * money pattern.
 */
export function extractCitedAmounts(text: string): number[] {
  const out = new Set<number>();
  if (!text || typeof text !== "string") return [];

  const re = new RegExp(MONEY_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const captured = m[1] ?? m[2] ?? "";
    const n = normalizeAmount(captured);
    if (!Number.isFinite(n)) continue;
    // Drop trivially small numbers that are almost certainly not money
    // citations (e.g. percentages or counts that happened to match the
    // bare-number alternative). The `$`/`USD` token rule already filters
    // most of these, but this keeps the signal clean.
    if (n <= 0) continue;
    out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Walks an arbitrary value (object / array / primitive) and yields every
 * finite number found inside. Strings that look like numbers are NOT
 * coerced — tools should already return real numbers; coercing strings
 * would add false positives (e.g. account ids). Numbers ≤ 0 are kept
 * because some tool outputs include negative cost figures (credits,
 * SppDiscount) and the model may legitimately cite them.
 */
export function collectNumbers(value: unknown, max = 5000): number[] {
  const seen: number[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0 && seen.length < max) {
    const cur = stack.pop();
    if (cur == null) continue;
    if (typeof cur === "number") {
      if (Number.isFinite(cur)) seen.push(cur);
      continue;
    }
    if (Array.isArray(cur)) {
      for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i]);
      continue;
    }
    if (typeof cur === "object") {
      for (const v of Object.values(cur as Record<string, unknown>)) stack.push(v);
    }
  }
  return seen;
}

/** Returns true when `cited` matches `candidate` within ±0.5% / ±$1. */
export function approxEqual(cited: number, candidate: number): boolean {
  if (!Number.isFinite(cited) || !Number.isFinite(candidate)) return false;
  const a = Math.abs(cited);
  const b = Math.abs(candidate);
  const diff = Math.abs(a - b);
  if (diff <= ABS_TOLERANCE) return true;
  const rel = diff / Math.max(a, 1);
  return rel <= REL_TOLERANCE;
}

/** Result of `verifyCitations`: cited amounts, the subset matched by the
 *  tool numbers, and the subset that has no near-equal counterpart. */
export interface CitationVerificationResult {
  cited: number[];
  matched: number[];
  missing: number[];
}

/**
 * Verifies that every monetary amount cited in `text` is backed by some
 * number returned by a tool in `toolResults`. `toolResults` may be any
 * shape (a single object, an array of `{output: ...}` entries, a deep
 * nested mix) — `collectNumbers` walks it recursively.
 *
 * Returns `{cited, matched, missing}`:
 *  - `cited`:   sorted unique amounts found in `text`
 *  - `matched`: subset of `cited` with at least one near-equal tool number
 *  - `missing`: subset of `cited` with no match (the discrepancy set
 *               that the route logs as telemetry without blocking)
 *
 * Pure function. Never throws.
 */
export function verifyCitations(
  text: string,
  toolResults: unknown,
): CitationVerificationResult {
  const cited = extractCitedAmounts(text);
  if (cited.length === 0) {
    return { cited: [], matched: [], missing: [] };
  }
  const candidates = collectNumbers(toolResults);
  const matched: number[] = [];
  const missing: number[] = [];
  for (const c of cited) {
    if (candidates.some((cand) => approxEqual(c, cand))) {
      matched.push(c);
    } else {
      missing.push(c);
    }
  }
  return { cited, matched, missing };
}
