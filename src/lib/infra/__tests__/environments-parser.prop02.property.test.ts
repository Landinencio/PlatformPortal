// Feature: infra-self-service-hardening, Property 2: rewriteEnvironmentsExpression preserves the rest of HCL byte-exact
/**
 * Property-based test for `rewriteEnvironmentsExpression`'s byte-exact
 * preservation of everything outside the `contains([...], var.environment)`
 * array literal.
 *
 * Feature: infra-self-service-hardening
 * Property 2: rewriteEnvironmentsExpression preserves the rest of HCL byte-exact
 *
 * Contract (see design.md §Components and Interfaces and Req 4.3, 4.5):
 *
 *   For any HCL string `hcl` that contains the canonical expression
 *
 *       count = contains([...], var.environment) ? 1 : 0
 *
 *   embedded between arbitrary prefix and suffix (whitespace, `#` line
 *   comments, `/* ... *\/` block comments, sibling attributes, other
 *   `resource` blocks), and any valid `targetEnvironments`, the call
 *   `rewriteEnvironmentsExpression(hcl, target)` mutates ONLY the bytes
 *   strictly between the `[` opener and the `]` closer of the
 *   `contains(...)` first argument. Every byte in
 *   `hcl.slice(0, <opener_idx> + 1)` and in `hcl.slice(<closer_idx>)`
 *   is preserved byte-for-byte in the output.
 *
 * Conventions: node:test + node:assert/strict, fast-check ^4,
 * `{ numRuns: 100 }`, a `// Feature: ...` header comment on the file.
 *
 * **Validates: Requirements 4.3, 4.5**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  rewriteEnvironmentsExpression,
  type Env,
} from "@/lib/infra/environments-parser";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

const ENV_VALUES: readonly Env[] = ["dev", "uat", "prod"] as const;

/**
 * Non-empty subset of {dev,uat,prod} with unique elements. Order is
 * random on purpose: the parser accepts any order and canonicalises
 * internally, so this generator explores that space too.
 */
const arbEnvSubset: fc.Arbitrary<Env[]> = fc.uniqueArray(
  fc.constantFrom<Env>(...ENV_VALUES),
  { minLength: 1, maxLength: 3 },
);

/**
 * Safe alphabet for filler content — deliberately excludes the letter
 * `c`, which makes it structurally impossible to produce the substring
 * `contains(` inside any filler chunk. `CANONICAL_RE` anchors on
 * `contains\s*\(`, so removing the leading `c` from the filler
 * alphabet guarantees that the first (and only) match in the
 * generated HCL is the one we planted between prefix and suffix.
 *
 * The alphabet also excludes `*`, `/`, `[`, `]`, `#`, `"` and newline
 * characters so filler bodies cannot accidentally close a block
 * comment, open a spurious array, inject a comment marker, unbalance
 * a quoted string, or break out of the intended chunk shape.
 */
const SAFE_CHARS = "abdefghijklmnopqrstuvwxyz0123456789_-".split("");

const arbSafeIdent = fc.string({
  unit: fc.constantFrom(...SAFE_CHARS),
  minLength: 1,
  maxLength: 12,
});
const arbSafeText = fc.string({
  unit: fc.constantFrom(...SAFE_CHARS, " "),
  minLength: 0,
  maxLength: 30,
});

/** Whitespace-only chunk (spaces, tabs, newlines). */
const arbWhitespace = fc.string({
  unit: fc.constantFrom(" ", "\t", "\n"),
  minLength: 0,
  maxLength: 6,
});

/** `# ...` line comment terminated by `\n`. */
const arbLineComment = arbSafeText.map((body) => `# ${body}\n`);

/** `/* ... *\/` block comment. Body cannot contain `*` or `/`. */
const arbBlockComment = arbSafeText.map((body) => `/* ${body} */`);

/** Neighbour attribute assignment (indented, double-quoted value). */
const arbAttribute = fc
  .tuple(arbSafeIdent, arbSafeIdent)
  .map(([key, value]) => `  ${key} = "${value}"\n`);

/**
 * Sibling resource block, e.g.:
 *
 *     resource "aws_role" "foo" {
 *       name = "bar"
 *     }
 *
 * Guaranteed not to contain `contains(` because the alphabet excludes `c`.
 */
const arbOtherResourceBlock = fc
  .tuple(arbSafeIdent, arbSafeIdent, arbSafeIdent, arbSafeIdent)
  .map(
    ([type, name, k, v]) =>
      `resource "aws_${type}" "${name}" {\n  ${k} = "${v}"\n}\n`,
  );

/** A single filler chunk. */
const arbFillerChunk = fc.oneof(
  arbWhitespace,
  arbLineComment,
  arbBlockComment,
  arbAttribute,
  arbOtherResourceBlock,
);

/** A prefix or suffix is an arbitrary sequence of filler chunks. */
const arbFiller: fc.Arbitrary<string> = fc
  .array(arbFillerChunk, { minLength: 0, maxLength: 5 })
  .map((chunks) => chunks.join(""));

/**
 * Renders the canonical expression with the given env list inside the
 * array literal. Uses the exact style the parser recognises (`", "`
 * separator, double quotes) so the regex matches deterministically.
 */
function buildCanonical(envs: readonly Env[]): string {
  return `count = contains([${envs
    .map((e) => `"${e}"`)
    .join(", ")}], var.environment) ? 1 : 0`;
}

/* ------------------------------------------------------------------ */
/*  Property 2                                                         */
/* ------------------------------------------------------------------ */

test("Property 2: rewriteEnvironmentsExpression preserves the rest of HCL byte-exact", () => {
  fc.assert(
    fc.property(
      arbFiller,
      arbFiller,
      arbEnvSubset,
      arbEnvSubset,
      (prefix, suffix, initial, target) => {
        const canonical = buildCanonical(initial);
        const hcl = prefix + canonical + suffix;

        // Locate the array-literal bounds in the input. Because the
        // filler alphabet excludes `c`, the first `contains(` in `hcl`
        // is the one we planted, and CANONICAL_RE's `[^\]]*` guarantees
        // the first `]` after the opener is the closer.
        const containsIdx = hcl.indexOf("contains(");
        assert.notEqual(
          containsIdx,
          -1,
          "sanity: canonical expression must be present in the generated HCL",
        );
        const openerIdx = hcl.indexOf("[", containsIdx);
        assert.notEqual(openerIdx, -1, "sanity: opener `[` must exist");
        const closerIdx = hcl.indexOf("]", openerIdx);
        assert.notEqual(closerIdx, -1, "sanity: closer `]` must exist");

        const output = rewriteEnvironmentsExpression(hcl, target);

        // The output must still contain a `contains(` (the function
        // never removes it) — locate the same bounds there too.
        const outContainsIdx = output.indexOf("contains(");
        assert.notEqual(
          outContainsIdx,
          -1,
          "the output must still contain `contains(`",
        );
        const outOpenerIdx = output.indexOf("[", outContainsIdx);
        assert.notEqual(outOpenerIdx, -1);
        const outCloserIdx = output.indexOf("]", outOpenerIdx);
        assert.notEqual(outCloserIdx, -1);

        // Prefix — every byte up to and including the `[` opener — must
        // match byte-for-byte between input and output. Since the
        // rewrite only alters bytes strictly inside the array, the
        // opener's position must be identical.
        assert.equal(
          outOpenerIdx,
          openerIdx,
          "opener `[` must land at the same offset in the output",
        );
        assert.equal(
          output.slice(0, outOpenerIdx + 1),
          hcl.slice(0, openerIdx + 1),
          "prefix (up to and including `[`) must be preserved byte-exact",
        );

        // Suffix — every byte from the `]` closer onwards — must match
        // byte-for-byte. The closer's absolute offset may shift by the
        // delta between the old and new array-content lengths, which
        // is expected and does not violate the property; we compare
        // from the closer's position onwards in each string.
        assert.equal(
          output.slice(outCloserIdx),
          hcl.slice(closerIdx),
          "suffix (from `]` onwards) must be preserved byte-exact",
        );

        // Cross-check the total length: any change in output length
        // must be entirely accounted for by the array-content delta.
        const inputInnerLen = closerIdx - (openerIdx + 1);
        const outputInnerLen = outCloserIdx - (outOpenerIdx + 1);
        assert.equal(
          output.length - hcl.length,
          outputInnerLen - inputInnerLen,
          "the only length delta between input and output must come from " +
            "the array-content substitution",
        );

        // No-op safety check: if the inner array content is unchanged,
        // the whole HCL must be byte-identical (idempotence branch).
        const inputInner = hcl.slice(openerIdx + 1, closerIdx);
        const outputInner = output.slice(outOpenerIdx + 1, outCloserIdx);
        if (inputInner === outputInner) {
          assert.equal(
            output,
            hcl,
            "no-op paths (same-set target, invalid target, or unchanged inner) must return the input byte-exact",
          );
        }
      },
    ),
    { numRuns: 100 },
  );
});
