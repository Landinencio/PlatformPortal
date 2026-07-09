// Feature: eks-cost-optimization, Property 11: Recommendation YAML is well-formed and round-trip parseable
/**
 * Property-based test for `buildYamlBlock` in `src/lib/eks-cost/rightsizing.ts`.
 *
 * Feature: eks-cost-optimization
 * Property 11: Recommendation YAML is well-formed and round-trip parseable
 *
 * Contract (see design.md §Backend > rightsizing.ts and Requirements 5.6,
 * 10.3, 10.4):
 *
 *   `buildYamlBlock(workload, namespace, cpuReq, memReq, reason?)` emits a
 *   YAML string with the canonical shape:
 *
 *     # EKS Cost recommendation for <namespace>/<workload>
 *     # reason: <reason>
 *     resources:
 *       requests:
 *         cpu: "<cpuReq>"
 *         memory: "<memReq>"
 *       limits:
 *         memory: "<memReq>"
 *
 * The test parses that block with `js-yaml` (a transitive dependency of the
 * portal, already imported by other tests) and asserts four properties:
 *
 *   (11a) Structural shape — `yaml.load(block)` returns an object matching
 *         `{ resources: { requests: { cpu, memory }, limits: { memory } } }`,
 *         and NO other top-level keys. `limits.cpu` is NEVER present
 *         (aligned with the QoS-Guaranteed practice of not capping CPU on
 *         latency-sensitive workloads — Requirement 10.3).
 *
 *   (11b) `requests.memory === limits.memory` — same string value in both
 *         slots, by design.
 *
 *   (11c) Round-trip on CPU — `parseCpu(parsed.requests.cpu)` sits within
 *         the Property 1 tolerance `[cores, cores + 0.001]` of the value
 *         originally fed through `formatCpu`.
 *
 *   (11d) Round-trip on memory — `parseMemory(parsed.requests.memory)` is
 *         `>= bytes` and `<= bytes + step`, where `step` is the granularity
 *         used by `formatMemory` (16 MiB in the Mi branch, 0.1 GiB in the
 *         Gi branch). This bound is tighter than Property 1's 6% cap and
 *         holds for every non-negative byte magnitude (including tiny ones
 *         where the 6% cap would be looser than a single step).
 *
 * A second property guards against injection: hostile inputs
 * (workload / namespace / reason with newlines and CR/LF sequences) never
 * break YAML parsing, because `buildYamlBlock` collapses `\r?\n` runs to a
 * single space before interpolation. The comment lines that carry those
 * strings therefore stay on their single line and cannot smuggle new YAML
 * keys.
 *
 * Conventions: node:test + node:assert/strict, fast-check ^4,
 * `{ numRuns: 100 }`, a `// Feature: ...` header comment on the file.
 *
 * **Validates: Requirements 5.6, 10.3, 10.4**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import * as yaml from "js-yaml";

import { buildYamlBlock } from "@/lib/eks-cost/rightsizing";
import {
  formatCpu,
  formatMemory,
  parseCpu,
  parseMemory,
} from "@/lib/eks-cost/k8s-units";
import {
  arbByteCount,
  arbCoreCount,
} from "@/lib/eks-cost/__tests__/generators";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** 1 mebibyte in bytes. */
const MIB = 1024 * 1024;
/** 1 gibibyte in bytes. */
const GIB = 1024 * 1024 * 1024;

/**
 * Property 1's CPU upper delta:
 * `parseCpu(formatCpu(cores)) ∈ [cores, cores + 0.001]`.
 */
const CPU_ROUND_TRIP_UPPER_DELTA = 0.001;

/**
 * Small additive slack absorbing IEEE-754 rounding through
 * `Math.ceil(cores * 1000)` in `formatCpu` and the milicore division on
 * parse. Same value used in Property 1's tests.
 */
const FP_EPSILON = 1e-9;

/**
 * `formatMemory` rounds UP in steps of 16 MiB for `bytes < 1 Gi` and steps
 * of 0.1 GiB for `bytes >= 1 Gi`. The corresponding round-trip upper bound
 * is `parseMemory(formatMemory(b)) < b + step` (strictly less; equal when
 * `b` is an exact multiple of the step). We use `<=` in the assertion to
 * absorb the exact-multiple case.
 */
function memoryStepForBytes(bytes: number): number {
  return bytes < GIB ? 16 * MIB : GIB / 10;
}

/* ------------------------------------------------------------------ */
/*  Arbitraries                                                        */
/* ------------------------------------------------------------------ */

/**
 * A safe Kubernetes-style slug for workload/namespace names in the
 * canonical-shape property. We keep the alphabet small so the property
 * exercises the shape and round-trip logic — the hostile-input property
 * covers all the escaping/newline concerns separately.
 */
const arbSafeSlug: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
    fc.array(
      fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-".split("")),
      { minLength: 0, maxLength: 20 },
    ),
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
  )
  .map(([first, mid, last]) => `${first}${mid.join("")}${last}`);

/**
 * A hostile string. Combines a Unicode payload with an explicit
 * newline / CR-LF / CR sequence and a YAML-shaped injection attempt.
 * `buildYamlBlock` MUST sanitise these so the resulting document still
 * parses and still exposes only the canonical keys.
 */
const arbHostileString: fc.Arbitrary<string> = fc
  .tuple(
    fc.string({ minLength: 0, maxLength: 30 }),
    fc.constantFrom(
      "\n",
      "\r\n",
      "\r",
      "\ninjected: true\n",
      "\r\n---\r\nhijacked: yes\r\n",
      "\n  nested:\n    key: value\n",
      "\n# fake comment\nresources:\n  requests:\n    cpu: \"9999m\"",
    ),
    fc.string({ minLength: 0, maxLength: 30 }),
  )
  .map(([a, sep, b]) => a + sep + b);

/* ------------------------------------------------------------------ */
/*  Property 11a-d — canonical shape + round-trip                      */
/* ------------------------------------------------------------------ */

test("Property 11: YAML has canonical shape and CPU/memory round-trip within Property 1 tolerance", () => {
  fc.assert(
    fc.property(
      arbSafeSlug,
      arbSafeSlug,
      arbCoreCount,
      arbByteCount,
      (workload, namespace, cores, bytes) => {
        // Feed the raw values through the canonical formatters — the design
        // contract of `buildYamlBlock` is that it interpolates the strings
        // its caller has already produced with `formatCpu`/`formatMemory`.
        const cpuReq = formatCpu(cores);
        const memReq = formatMemory(bytes);
        const block = buildYamlBlock(workload, namespace, cpuReq, memReq);

        // Parse — must never throw for well-formed inputs.
        const parsed = yaml.load(block) as Record<string, unknown>;

        // (11a) Structural shape: exactly `{ resources: { requests, limits } }`.
        assert.ok(
          parsed !== null && typeof parsed === "object",
          "yaml.load must return a non-null object",
        );
        assert.deepEqual(
          Object.keys(parsed).sort(),
          ["resources"],
          "top-level keys must be exactly ['resources']",
        );
        const resources = parsed.resources as Record<string, unknown>;
        assert.ok(
          resources !== null && typeof resources === "object",
          "resources must be an object",
        );
        assert.deepEqual(
          Object.keys(resources).sort(),
          ["limits", "requests"],
          "resources must contain exactly ['limits', 'requests']",
        );
        const requests = resources.requests as Record<string, unknown>;
        const limits = resources.limits as Record<string, unknown>;
        assert.deepEqual(
          Object.keys(requests).sort(),
          ["cpu", "memory"],
          "requests must contain exactly ['cpu', 'memory']",
        );
        assert.deepEqual(
          Object.keys(limits).sort(),
          ["memory"],
          "limits must contain exactly ['memory'] (never 'cpu')",
        );

        // `limits.cpu` must NEVER be present, in any form.
        assert.equal(
          limits.cpu,
          undefined,
          "limits.cpu must never be present",
        );
        assert.ok(
          !("cpu" in limits),
          "limits must not carry a 'cpu' key at all",
        );

        // Values must be strings (`buildYamlBlock` quotes them so parsers
        // never coerce an integer-looking CPU like `2` into a number).
        assert.equal(typeof requests.cpu, "string", "requests.cpu is a string");
        assert.equal(
          typeof requests.memory,
          "string",
          "requests.memory is a string",
        );
        assert.equal(
          typeof limits.memory,
          "string",
          "limits.memory is a string",
        );

        // (11b) `requests.memory === limits.memory`.
        assert.equal(
          requests.memory,
          limits.memory,
          "requests.memory must equal limits.memory",
        );

        // The values interpolated must be exactly what the caller passed.
        assert.equal(requests.cpu, cpuReq, "requests.cpu preserved verbatim");
        assert.equal(
          requests.memory,
          memReq,
          "requests.memory preserved verbatim",
        );

        // (11c) CPU round-trip within Property 1 tolerance.
        const parsedCores = parseCpu(requests.cpu as string);
        assert.ok(
          parsedCores >= cores - FP_EPSILON,
          `parseCpu(${requests.cpu as string}) = ${parsedCores} < ${cores} (lost precision)`,
        );
        const cpuUpper = cores + CPU_ROUND_TRIP_UPPER_DELTA + FP_EPSILON;
        assert.ok(
          parsedCores <= cpuUpper,
          `parseCpu(${requests.cpu as string}) = ${parsedCores} > ${cpuUpper} (over-rounded past 0.001)`,
        );

        // (11d) Memory round-trip within the step-derived bound.
        const parsedBytes = parseMemory(requests.memory as string);
        assert.ok(
          parsedBytes >= bytes,
          `parseMemory(${requests.memory as string}) = ${parsedBytes} < ${bytes} (would leave workload short)`,
        );
        const step = memoryStepForBytes(bytes);
        const memUpper = bytes + step + FP_EPSILON;
        assert.ok(
          parsedBytes <= memUpper,
          `parseMemory(${requests.memory as string}) = ${parsedBytes} > ${memUpper} (over-rounded past step ${step})`,
        );
      },
    ),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 11 (hostile-input variant) — injection is prevented       */
/* ------------------------------------------------------------------ */

test("Property 11: hostile workload/namespace/reason inputs never break YAML parsing or leak new keys", () => {
  fc.assert(
    fc.property(
      arbHostileString,
      arbHostileString,
      arbHostileString,
      arbCoreCount,
      arbByteCount,
      (workload, namespace, reason, cores, bytes) => {
        const cpuReq = formatCpu(cores);
        const memReq = formatMemory(bytes);
        const block = buildYamlBlock(workload, namespace, cpuReq, memReq, reason);

        // Must parse — a stray newline injected via workload/namespace/reason
        // must not smuggle a new YAML document, key, or scalar.
        const parsed = yaml.load(block) as Record<string, unknown>;
        assert.ok(
          parsed !== null && typeof parsed === "object",
          "hostile input must not break yaml.load",
        );

        // Canonical shape survives hostile inputs.
        assert.deepEqual(
          Object.keys(parsed).sort(),
          ["resources"],
          "hostile input must not add top-level keys",
        );
        const resources = parsed.resources as Record<string, unknown>;
        assert.deepEqual(
          Object.keys(resources).sort(),
          ["limits", "requests"],
          "hostile input must not add keys under resources",
        );
        const requests = resources.requests as Record<string, unknown>;
        const limits = resources.limits as Record<string, unknown>;
        assert.deepEqual(
          Object.keys(requests).sort(),
          ["cpu", "memory"],
          "hostile input must not add keys under requests",
        );
        assert.deepEqual(
          Object.keys(limits).sort(),
          ["memory"],
          "hostile input must not add keys under limits (in particular no 'cpu')",
        );

        // Values are preserved verbatim, and `requests.memory === limits.memory`.
        assert.equal(requests.cpu, cpuReq);
        assert.equal(requests.memory, memReq);
        assert.equal(limits.memory, memReq);
        assert.equal(requests.memory, limits.memory);
        assert.equal(limits.cpu, undefined);
      },
    ),
    { numRuns: 100 },
  );
});
