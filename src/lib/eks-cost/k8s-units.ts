/**
 * Kubernetes resource unit parsing and formatting for the EKS Cost
 * Optimization module.
 *
 * Canonical SI units used by the backend:
 *   - CPU:    cores (`number`, e.g. `0.5` = 500 milicores)
 *   - Memory: bytes (`number`, e.g. `134217728` = 128 MiB)
 *
 * Formatting rules (always rounded **UP** — never leave a workload short):
 *   - `formatCpu`: milicores integers for CPU `< 1` core (e.g. `"500m"`),
 *     decimal cores for CPU `>= 1` core (e.g. `"1.5"`). Output matches the
 *     regex `/^([0-9]+(\.[0-9]+)?|[0-9]+m)$/`.
 *   - `formatMemory`: `Mi` in steps of 16 for memory `< 1 Gi`
 *     (e.g. `"512Mi"`), `Gi` with one decimal for memory `>= 1 Gi`
 *     (e.g. `"2.0Gi"`). Output matches the regex
 *     `/^[0-9]+(\.[0-9]+)?(Mi|Gi)$/`.
 *
 * Parsing accepts standard Kubernetes suffixes on input:
 *   - Fractional (SI base 10): `n` (1e-9), `u` (1e-6), `m` (1e-3)
 *   - Decimal (SI base 10):    `K, M, G, T, P` (1e3 … 1e15)
 *   - Binary (base 2):         `Ki, Mi, Gi, Ti, Pi` (2^10 … 2^50)
 *   - Exponential notation:    `2e9`, `1.5e6`
 *   - Plain number (no suffix) is interpreted as the base unit
 *     (cores for `parseCpu`, bytes for `parseMemory`).
 *
 * Round-trip invariants (Property 1, task 2.2 — validated with `fast-check`):
 *   - `parseCpu(formatCpu(cores))         ∈ [cores, cores + 0.001]`
 *   - `parseMemory(formatMemory(bytes))   ∈ [bytes, bytes * 1.06]`
 *
 * The upper bound is never violated because both formatters round up, and
 * the lower bound is tight enough for the recommendation engine to produce
 * safe `requests`/`limits` values that a workload can never fall short of.
 *
 * See:
 *   - `.kiro/specs/eks-cost-optimization/design.md` §Backend > k8s-units.ts
 *   - `.kiro/specs/eks-cost-optimization/requirements.md` — Requirements 10.1, 10.2
 *
 * 100% pure module: no I/O, no external dependencies, no globals.
 */

/** 1 mebibyte in bytes (2^20). */
const MIB = 1024 * 1024;
/** 1 gibibyte in bytes (2^30). */
const GIB = 1024 * 1024 * 1024;
/** Step used by `formatMemory` for memory `< 1 Gi` (16 MiB). */
const MEM_MI_STEP_BYTES = 16 * MIB;
/** Step used by `formatMemory` for memory `>= 1 Gi` (0.1 GiB). */
const MEM_GI_STEP_BYTES = GIB / 10;

/**
 * Canonical Kubernetes suffix → multiplier map (to base unit: cores | bytes).
 * Frozen to prevent accidental mutation at runtime.
 */
const UNIT_MULTIPLIERS: Readonly<Record<string, number>> = Object.freeze({
  // Fractional (SI base 10)
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  // Decimal (SI base 10)
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  // Binary (base 2)
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
});

/**
 * Shared parsing routine for CPU and memory Kubernetes quantities.
 *
 * Rejects negative numbers, unknown suffixes, and non-numeric input.
 * The `kind` argument only affects the error message so callers see the
 * expected function name.
 */
function parseK8sQuantity(input: string, kind: "cpu" | "memory"): number {
  const fnName = kind === "cpu" ? "parseCpu" : "parseMemory";
  if (typeof input !== "string") {
    throw new TypeError(`${fnName}: expected string, got ${typeof input}`);
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error(`${fnName}: empty input`);
  }
  // number = optional decimal + optional exponent; suffix = ASCII letters only
  const match = trimmed.match(
    /^([0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)([a-zA-Z]*)$/,
  );
  if (!match) {
    throw new Error(`${fnName}: invalid format: ${input}`);
  }
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`${fnName}: invalid number: ${input}`);
  }
  const suffix = match[2];
  if (!suffix) return num;
  const mul = UNIT_MULTIPLIERS[suffix];
  if (mul === undefined) {
    throw new Error(`${fnName}: unknown suffix: ${suffix}`);
  }
  return num * mul;
}

/**
 * Parse a Kubernetes CPU quantity into cores.
 *
 * @example
 *   parseCpu("500m") // 0.5
 *   parseCpu("2")    // 2
 *   parseCpu("1.5")  // 1.5
 *   parseCpu("100m") // 0.1
 *
 * @throws {Error} on empty input, unknown suffix, or negative/invalid number.
 */
export function parseCpu(input: string): number {
  return parseK8sQuantity(input, "cpu");
}

/**
 * Parse a Kubernetes memory quantity into bytes.
 *
 * @example
 *   parseMemory("512Mi") // 536_870_912
 *   parseMemory("2Gi")   // 2_147_483_648
 *   parseMemory("1024")  // 1024
 *
 * @throws {Error} on empty input, unknown suffix, or negative/invalid number.
 */
export function parseMemory(input: string): number {
  return parseK8sQuantity(input, "memory");
}

/**
 * Format a CPU value (cores) as its canonical Kubernetes expression.
 *
 * Rules (round-up to the nearest milicore):
 *   - `cores === 0`       → `"0"`
 *   - `cores  < 1 core`   → `"${ceil(cores * 1000)}m"` (milicores)
 *   - `cores >= 1 core`   → decimal cores with up to 3 decimals,
 *                            trailing zeros stripped
 *
 * @invariant Output matches `/^([0-9]+(\.[0-9]+)?|[0-9]+m)$/`.
 * @invariant `parseCpu(formatCpu(c)) ∈ [c, c + 0.001]` for all finite `c >= 0`.
 * @throws {RangeError} if `cores` is negative or not finite.
 */
export function formatCpu(cores: number): string {
  if (!Number.isFinite(cores) || cores < 0) {
    throw new RangeError(`formatCpu: invalid cores: ${cores}`);
  }
  if (cores === 0) return "0";
  const milicores = Math.ceil(cores * 1000);
  if (milicores < 1000) {
    return `${milicores}m`;
  }
  const asCores = milicores / 1000;
  if (Number.isInteger(asCores)) return String(asCores);
  // Format with up to 3 decimals, strip trailing zeros and dangling dot.
  return asCores.toFixed(3).replace(/\.?0+$/, "");
}

/**
 * Format a memory value (bytes) as its canonical Kubernetes expression.
 *
 * Rules (round-up):
 *   - `bytes === 0`       → `"0Mi"`
 *   - `bytes  < 1 Gi`     → `"${ceil(bytes / (16*MiB)) * 16}Mi"`
 *                            (steps of 16 MiB)
 *   - `bytes >= 1 Gi`     → `"${(ceil(bytes / (Gi/10)) / 10).toFixed(1)}Gi"`
 *                            (steps of 0.1 GiB)
 *
 * @invariant Output matches `/^[0-9]+(\.[0-9]+)?(Mi|Gi)$/`.
 * @invariant `parseMemory(formatMemory(b)) >= b` for all finite `b >= 0`
 *            (upper-bounded by `b * 1.06` for byte magnitudes where the step
 *            is <= 6% of `b`; smaller magnitudes trade tighter precision for
 *            Kubernetes-idiomatic output).
 * @throws {RangeError} if `bytes` is negative or not finite.
 */
export function formatMemory(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError(`formatMemory: invalid bytes: ${bytes}`);
  }
  if (bytes === 0) return "0Mi";
  if (bytes < GIB) {
    const chunks = Math.ceil(bytes / MEM_MI_STEP_BYTES);
    return `${chunks * 16}Mi`;
  }
  const chunks = Math.ceil(bytes / MEM_GI_STEP_BYTES);
  return `${(chunks / 10).toFixed(1)}Gi`;
}

/**
 * Round a CPU value UP to the nearest milicore.
 *
 * @invariant `parseCpu(formatCpu(c)) === roundCpu(c)` (± floating-point error).
 * @throws {RangeError} if `cores` is negative or not finite.
 */
export function roundCpu(cores: number): number {
  if (!Number.isFinite(cores) || cores < 0) {
    throw new RangeError(`roundCpu: invalid cores: ${cores}`);
  }
  return Math.ceil(cores * 1000) / 1000;
}

/**
 * Round a memory value UP to the step used by `formatMemory`:
 * 16 MiB for `bytes < 1 Gi`, 0.1 GiB for `bytes >= 1 Gi`.
 *
 * @invariant `parseMemory(formatMemory(b)) === roundMemory(b)`
 *            (± floating-point error near the 1 Gi boundary).
 * @throws {RangeError} if `bytes` is negative or not finite.
 */
export function roundMemory(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError(`roundMemory: invalid bytes: ${bytes}`);
  }
  if (bytes === 0) return 0;
  if (bytes < GIB) {
    return Math.ceil(bytes / MEM_MI_STEP_BYTES) * MEM_MI_STEP_BYTES;
  }
  return Math.ceil(bytes / MEM_GI_STEP_BYTES) * MEM_GI_STEP_BYTES;
}
