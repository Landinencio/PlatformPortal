/**
 * Pure module. No `fs`, no `net`, no side effects.
 *
 * Feature: infra-self-service-hardening
 * Task: 1.3 — Implementar src/lib/infra/environments-parser.ts
 *
 * Parses and rewrites the canonical multi-environment HCL expression used in
 * `iac/databases/<id>.tf` (RDS), `iac/s3/s3.tf` (S3) and `iac/roles/roles.tf`
 * (IAM) of the Repositorio_Destino:
 *
 *   count = contains(["dev", "uat"], var.environment) ? 1 : 0
 *
 * Documented syntactic equivalents accepted by the parser:
 *   - Any amount of whitespace between tokens (spaces, tabs, newlines).
 *   - Any whitespace inside the array literal.
 *   - Trailing comma inside the array literal (e.g. `["dev", "uat",]`).
 *   - Elements in any order (returned in canonical `dev < uat < prod`).
 *   - Duplicate elements in the array literal (deduplicated silently on parse).
 *
 * NOT accepted (the numeric literals `? 1 : 0` are strict — order matters,
 * otherwise the semantics flip to "count = 0 when in the listed envs"):
 *   - `? 0 : 1`
 *   - Any other conditional expression than `contains(..., var.environment)`.
 *   - Single-quoted strings (HCL only allows double quotes for regular strings).
 *   - Backslash-escaped characters inside the array (not needed for env values).
 *
 * All three exported functions are TOTAL — they never throw for any input,
 * including non-string / non-array values (typed loosely via `unknown` where
 * relevant). See Requirements 4.1, 4.2, 4.3, 4.4, 4.5.
 */

export type Env = "dev" | "uat" | "prod";

export type ParseResult =
  | { ok: true; current: Env[] }
  | { ok: false; error: "not_parseable" };

const CANONICAL_ORDER: readonly Env[] = ["dev", "uat", "prod"] as const;
const ENV_VALUES: ReadonlySet<string> = new Set<string>(CANONICAL_ORDER);

/**
 * Regex matching the canonical HCL expression with all documented syntactic
 * equivalents. `[^\]]*` captures the array contents (HCL string literals for
 * env values never contain `]`, so this is safe).
 */
const CANONICAL_RE =
  /count\s*=\s*contains\s*\(\s*\[([^\]]*)\]\s*,\s*var\.environment\s*\)\s*\?\s*1\s*:\s*0/;

/**
 * Splits the array contents into individual tokens and validates each one is a
 * double-quoted literal whose content is a member of the closed domain
 * `{"dev","uat","prod"}`. Returns `null` if any token is malformed or out of
 * domain, which surfaces up as `not_parseable`.
 */
function parseArrayContents(arrayContents: string): Env[] | null {
  const trimmed = arrayContents.trim();
  if (trimmed === "") return [];
  const tokens = trimmed.split(",");
  const out: Env[] = [];
  for (const raw of tokens) {
    const token = raw.trim();
    if (token === "") continue; // tolerate trailing comma
    const m = /^"([^"\\]*)"$/.exec(token);
    if (!m) return null;
    const value = m[1];
    if (!ENV_VALUES.has(value)) return null;
    out.push(value as Env);
  }
  return out;
}

/**
 * Dedupes and returns the envs in canonical order (dev < uat < prod).
 */
function canonicalize(envs: readonly Env[]): Env[] {
  const seen = new Set<Env>();
  for (const e of envs) seen.add(e);
  return CANONICAL_ORDER.filter((e) => seen.has(e));
}

/**
 * Total. Recognises the canonical expression `count = contains([...],
 * var.environment) ? 1 : 0` and its documented syntactic equivalents.
 *
 * @returns `{ ok: true, current }` with `current` deduped and in canonical
 * order; or `{ ok: false, error: "not_parseable" }` when the expression is
 * absent or contains tokens outside the `{"dev","uat","prod"}` domain.
 *
 * Never throws.
 */
export function parseEnvironmentsExpression(hcl: string): ParseResult {
  if (typeof hcl !== "string") return { ok: false, error: "not_parseable" };
  const match = CANONICAL_RE.exec(hcl);
  if (!match) return { ok: false, error: "not_parseable" };
  const parsed = parseArrayContents(match[1]);
  if (parsed === null) return { ok: false, error: "not_parseable" };
  return { ok: true, current: canonicalize(parsed) };
}

/**
 * Renders the canonical array literal contents (elements only, without the
 * surrounding brackets). Elements are quoted with double quotes and separated
 * by `, ` (comma + space), matching the emission pattern of
 * `src/lib/rds/render-rds.ts`.
 */
function renderArrayLiteral(envs: readonly Env[]): string {
  return envs.map((e) => `"${e}"`).join(", ");
}

/**
 * Structural set equality for two Env arrays. Order-insensitive.
 */
function sameSet(a: readonly Env[], b: readonly Env[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set<string>(a);
  for (const e of b) if (!setA.has(e)) return false;
  return true;
}

/**
 * Total. Substitutes ONLY the array literal inside
 * `contains([...], var.environment)`; every other byte of the HCL (whitespace,
 * comments, attribute order, sibling blocks) is preserved byte-exact.
 *
 * Idempotent in three scenarios (input returned unchanged):
 *   1. The HCL does not contain the canonical expression.
 *   2. `targetEnvironments` fails `normalizeTargetEnvironments` validation.
 *   3. The normalized target is equivalent (as a set) to the parsed current.
 *
 * The replacement uses the canonical rendering `"dev", "uat", "prod"` (double
 * quotes, comma + single space). Since only the byte range inside the `[...]`
 * is rewritten, callers can trust that surrounding structure is intact.
 *
 * Never throws.
 */
export function rewriteEnvironmentsExpression(
  hcl: string,
  targetEnvironments: Env[]
): string {
  if (typeof hcl !== "string") return "";
  const parsed = parseEnvironmentsExpression(hcl);
  if (!parsed.ok) return hcl;
  const normalized = normalizeTargetEnvironments(targetEnvironments);
  if (normalized === null) return hcl;
  if (sameSet(parsed.current, normalized)) return hcl;

  const match = CANONICAL_RE.exec(hcl);
  if (!match) return hcl; // defensive; parseEnvironmentsExpression matched already
  const arrayContents = match[1];
  const arrayStart = match.index + match[0].indexOf("[") + 1;
  const arrayEnd = arrayStart + arrayContents.length;
  return (
    hcl.slice(0, arrayStart) +
    renderArrayLiteral(normalized) +
    hcl.slice(arrayEnd)
  );
}

/**
 * Total. Validates and canonicalises a caller-supplied `targetEnvironments`
 * payload against the Req 4.1 restrictions:
 *   - Must be an array.
 *   - Must have between 1 and 3 elements (inclusive).
 *   - Every element must be a string from `{"dev","uat","prod"}`.
 *   - No duplicates.
 *
 * Returns a canonically-ordered `Env[]` (dev < uat < prod) on success, or
 * `null` when any restriction is violated. Never throws.
 */
export function normalizeTargetEnvironments(input: unknown): Env[] | null {
  if (!Array.isArray(input)) return null;
  if (input.length < 1 || input.length > 3) return null;
  const seen = new Set<Env>();
  for (const item of input) {
    if (typeof item !== "string") return null;
    if (!ENV_VALUES.has(item)) return null;
    if (seen.has(item as Env)) return null; // strict: reject duplicates (Req 4.1)
    seen.add(item as Env);
  }
  return CANONICAL_ORDER.filter((e) => seen.has(e));
}
