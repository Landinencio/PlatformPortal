// Feature: infra-self-service-hardening, Property 1: parseEnvironmentsExpression is total and rewrite round-trip is identity
/**
 * Property-based tests for `parseEnvironmentsExpression` and
 * `rewriteEnvironmentsExpression` in `src/lib/infra/environments-parser.ts`.
 *
 * Feature: infra-self-service-hardening
 * Property 1: parseEnvironmentsExpression is total and rewrite round-trip is
 * identity when `targetEnvironments === current`.
 *
 * Contract (see design.md §Fase 1 and Requirements 4.3, 4.4, 4.7):
 *
 *   (1a) Totality — for any string `hcl` and any array `targetEnvironments`,
 *        `parseEnvironmentsExpression(hcl)` never throws, and
 *        `rewriteEnvironmentsExpression(hcl, targetEnvironments)` never
 *        throws either. Both functions are documented as total in the
 *        module header.
 *
 *   (1b) Round-trip identity — for every `hcl` whose parse succeeds with
 *        `{ ok: true, current }`, `rewriteEnvironmentsExpression(hcl,
 *        current)` returns `hcl` byte-exact (identity). This encodes the
 *        no-op guard from Req 4.7: rewriting with the same set as the
 *        current one is a no-op that must not alter a single byte of the
 *        input.
 *
 * Stack: node:test (run via `tsx --test`) + node:assert/strict + fast-check
 * with `{ numRuns: 100 }`. Two arbitraries are combined for the round-trip
 * property:
 *
 *   - `arbGarbageString` — plain `fc.string()`, exercises the "no parseable
 *     expression" corner of totality; usually `fc.pre` skips these runs on
 *     the round-trip property.
 *   - `arbSyntheticCanonicalHcl` — synthesises the canonical expression
 *     `count = contains([...], var.environment) ? 1 : 0` with random
 *     whitespace at every `\s*` slot, random env selection from
 *     `{"dev","uat","prod"}` (with duplicates and orderings), optional
 *     trailing comma inside the array, and arbitrary garbage prefix/suffix.
 *     This guarantees a healthy fraction of `numRuns` reach the round-trip
 *     assertion.
 *
 * **Validates: Requirements 4.3, 4.4, 4.7**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  parseEnvironmentsExpression,
  rewriteEnvironmentsExpression,
  type Env,
} from "../environments-parser";

/* ------------------------------------------------------------------ */
/*  Arbitraries                                                        */
/* ------------------------------------------------------------------ */

/** Whitespace sequences accepted by the canonical `\s*` slots. */
const arbWs = fc.string({
  unit: fc.constantFrom(" ", "\t", "\n", "\r"),
  minLength: 0,
  maxLength: 4,
});

/** Whitespace sequences at least one char wide (for slots that need it). */
const arbWs1 = fc.string({
  unit: fc.constantFrom(" ", "\t", "\n", "\r"),
  minLength: 1,
  maxLength: 4,
});

/** A single env token drawn from the closed domain `{"dev","uat","prod"}`. */
const arbEnvValue: fc.Arbitrary<Env> = fc.constantFrom<Env>(
  "dev",
  "uat",
  "prod",
);

/** Any array of env values (with duplicates, any order, length 1..6). */
const arbEnvList: fc.Arbitrary<Env[]> = fc.array(arbEnvValue, {
  minLength: 1,
  maxLength: 6,
});

/**
 * Arbitrary garbage string used as prefix/suffix around the synthetic
 * canonical expression. `fc.string()` may occasionally contain characters
 * that look like HCL but never (with reasonable probability) reconstructs
 * the full canonical regex pattern by chance.
 */
const arbGarbage = fc.string({ maxLength: 40 });

/**
 * Synthesises the canonical HCL expression with random whitespace at every
 * `\s*` slot of `CANONICAL_RE`:
 *
 *   count = contains([...], var.environment) ? 1 : 0
 *
 * Elements inside the array are joined by `,` with random whitespace on
 * both sides of each comma, an optional trailing comma, and outer padding
 * inside the brackets. The generator does NOT try to canonicalise; it
 * builds any string that the parser accepts.
 */
const arbSyntheticCanonicalHcl: fc.Arbitrary<string> = fc
  .tuple(
    arbEnvList,
    // 13 whitespace slots — one for every `\s*` in `CANONICAL_RE`, plus
    // outer padding inside the brackets and between array elements.
    arbWs, // 1: between `count` and `=`
    arbWs, // 2: between `=` and `contains`
    arbWs, // 3: between `contains` and `(`
    arbWs, // 4: between `(` and `[`
    arbWs, // 5: leading padding inside `[`
    arbWs, // 6: trailing padding inside `[` (before `]`)
    arbWs, // 7: between `]` and `,`
    arbWs, // 8: between `,` and `var.environment`
    arbWs, // 9: between `)` and `?`
    arbWs, // 10: between `?` and `1`
    arbWs1, // 11: between `1` and `:` (at least one, otherwise "1:" reads oddly but the regex allows zero — we use 1 to keep it human-readable)
    arbWs1, // 12: between `:` and `0`
    fc.boolean(), // 13: whether to add a trailing comma inside the array
    // Per-element whitespace: for each of the max 6 elements, whitespace
    // on both sides of the separating comma. Represented as a list of
    // (leftWs, rightWs) pairs — one per separator, we only use N-1 of them
    // when there are N elements.
    fc.array(fc.tuple(arbWs, arbWs), { minLength: 0, maxLength: 6 }),
    arbGarbage, // prefix
    arbGarbage, // suffix
  )
  .map(
    ([
      envs,
      w1,
      w2,
      w3,
      w4,
      wInLeft,
      wInRight,
      w7,
      w8,
      w9,
      w10,
      w11,
      w12,
      trailingComma,
      sepWhitespaces,
      prefix,
      suffix,
    ]) => {
      // Build the array literal contents joining elements with `,` and
      // random surrounding whitespace on each separator.
      let arrayInside = `"${envs[0]}"`;
      for (let i = 1; i < envs.length; i++) {
        const [wL, wR] = sepWhitespaces[i - 1] ?? ["", ""];
        arrayInside += `${wL},${wR}"${envs[i]}"`;
      }
      if (trailingComma) {
        arrayInside += ",";
      }
      const expr =
        `count${w1}=${w2}contains${w3}(${w4}[${wInLeft}${arrayInside}${wInRight}]${w7},${w8}var.environment` +
        `)${w9}?${w10}1${w11}:${w12}0`;
      return `${prefix}${expr}${suffix}`;
    },
  );

/**
 * Composite arbitrary for the round-trip property: mostly synthetic
 * canonical HCL (so `fc.pre` accepts them) mixed with pure garbage (to
 * exercise the `not_parseable` branch alongside the parseable one).
 */
const arbAnyHcl: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: arbSyntheticCanonicalHcl, weight: 4 },
  { arbitrary: fc.string({ maxLength: 200 }), weight: 1 },
);

/**
 * Arbitrary `targetEnvironments` array for the totality property. Mixes
 * valid Env values with garbage strings to exercise both the accepted and
 * rejected paths of `normalizeTargetEnvironments`; also allows non-arrays
 * cast to `unknown` at the call site.
 */
const arbAnyTargetEnvironments: fc.Arbitrary<unknown> = fc.oneof(
  fc.array(arbEnvValue, { minLength: 0, maxLength: 8 }),
  fc.array(fc.string(), { minLength: 0, maxLength: 8 }),
  fc.array(
    fc.oneof(arbEnvValue, fc.string(), fc.integer(), fc.constant(null)),
    { minLength: 0, maxLength: 8 },
  ),
  fc.constant([] as unknown),
  fc.constant(undefined as unknown),
  fc.constant(null as unknown),
);

/* ------------------------------------------------------------------ */
/*  Property 1a: totality                                              */
/* ------------------------------------------------------------------ */

test("Property 1a: parseEnvironmentsExpression is total for any string input", () => {
  fc.assert(
    fc.property(fc.string(), (hcl) => {
      assert.doesNotThrow(
        () => parseEnvironmentsExpression(hcl),
        `parseEnvironmentsExpression threw on hcl=${JSON.stringify(hcl)}`,
      );
    }),
    { numRuns: 100 },
  );
});

test("Property 1a: parseEnvironmentsExpression stays total on synthetic canonical inputs", () => {
  fc.assert(
    fc.property(arbSyntheticCanonicalHcl, (hcl) => {
      // Same totality invariant, but exercised specifically on the
      // parseable side of the input space so we don't only ever test the
      // `not_parseable` branch.
      assert.doesNotThrow(
        () => parseEnvironmentsExpression(hcl),
        `parseEnvironmentsExpression threw on synthetic hcl=${JSON.stringify(hcl)}`,
      );
    }),
    { numRuns: 100 },
  );
});

test("Property 1a: rewriteEnvironmentsExpression is total for arbitrary (hcl, targetEnvironments)", () => {
  fc.assert(
    fc.property(fc.string(), arbAnyTargetEnvironments, (hcl, envs) => {
      assert.doesNotThrow(
        () =>
          // Cast through `unknown` because the runtime contract is total
          // even for malformed inputs (see module header).
          rewriteEnvironmentsExpression(hcl, envs as Env[]),
        `rewriteEnvironmentsExpression threw on hcl=${JSON.stringify(
          hcl,
        )} envs=${JSON.stringify(envs)}`,
      );
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 1b: round-trip identity                                   */
/* ------------------------------------------------------------------ */

test("Property 1b: rewriteEnvironmentsExpression is identity when target === current", () => {
  fc.assert(
    fc.property(arbAnyHcl, (hcl) => {
      const parsed = parseEnvironmentsExpression(hcl);
      // Skip runs where the HCL is not parseable — the round-trip
      // identity is only defined for `ok=true` parses. Since `arbAnyHcl`
      // is weighted 4:1 toward synthetic canonical HCL, most of the 100
      // runs still reach the assertion.
      fc.pre(parsed.ok);
      if (!parsed.ok) return; // narrows the type; unreachable after fc.pre
      const rewritten = rewriteEnvironmentsExpression(hcl, parsed.current);
      assert.equal(
        rewritten,
        hcl,
        `rewrite with current mutated the HCL byte-for-byte:\n` +
          `  input : ${JSON.stringify(hcl)}\n` +
          `  output: ${JSON.stringify(rewritten)}\n` +
          `  current: ${JSON.stringify(parsed.current)}`,
      );
    }),
    { numRuns: 100 },
  );
});
