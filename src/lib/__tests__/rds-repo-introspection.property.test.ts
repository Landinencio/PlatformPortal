/**
 * Property-based tests for the Repositorio_Destino RDS introspection helpers.
 *
 * Feature: portal-rds-creation-improvement
 *
 * **Validates: Requirements 4.2**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  extractModuleVersions,
  selectModuleVersion,
} from "../rds/repo-introspection";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

const RDS_SOURCE = "terraform-aws-modules/rds/aws";

/** Other (non-RDS) module sources whose versions must NOT be extracted. */
const OTHER_SOURCES = [
  "terraform-aws-modules/s3-bucket/aws",
  "terraform-aws-modules/vpc/aws",
  "terraform-aws-modules/iam/aws",
  "terraform-aws-modules/eks/aws",
  "terraform-aws-modules/rds-aurora/aws",
  "./modules/local-rds",
];

const lowerAlpha = "abcdefghijklmnopqrstuvwxyz".split("");

/** A short, valid Terraform identifier for the module label. */
const nameArb = fc
  .array(fc.constantFrom(...lowerAlpha), { minLength: 1, maxLength: 12 })
  .map((arr) => arr.join(""));

/** A pinned MAJOR.MINOR.PATCH version string. */
const versionArb = fc
  .tuple(
    fc.integer({ min: 0, max: 20 }),
    fc.integer({ min: 0, max: 30 }),
    fc.integer({ min: 0, max: 50 })
  )
  .map(([maj, min, patch]) => `${maj}.${min}.${patch}`);

interface ModuleSpec {
  name: string;
  isRds: boolean;
  source: string;
  version: string;
}

/** A single module block spec: either the RDS source or some other source. */
const moduleSpecArb: fc.Arbitrary<ModuleSpec> = fc
  .record({
    name: nameArb,
    isRds: fc.boolean(),
    otherSource: fc.constantFrom(...OTHER_SOURCES),
    version: versionArb,
  })
  .map(({ name, isRds, otherSource, version }) => ({
    name,
    isRds,
    source: isRds ? RDS_SOURCE : otherSource,
    version,
  }));

/**
 * Renders a module block. `source` is always emitted before `version`, and a
 * nested `tags { ... }` block is included to exercise the brace-matching parser.
 */
function renderModule(spec: ModuleSpec): string {
  return [
    `module "${spec.name}" {`,
    `  source  = "${spec.source}"`,
    `  version = "${spec.version}"`,
    ``,
    `  identifier = "${spec.name}-db"`,
    `  tags = {`,
    `    Name = "${spec.name}"`,
    `  }`,
    `}`,
  ].join("\n");
}

/**
 * A set of `.tf` file contents: an array (files) of arrays (module blocks).
 * Mixes RDS and non-RDS module blocks across multiple files.
 */
const tfFilesArb: fc.Arbitrary<{ contents: string[]; specs: ModuleSpec[] }> = fc
  .array(fc.array(moduleSpecArb, { minLength: 0, maxLength: 4 }), {
    minLength: 1,
    maxLength: 4,
  })
  .map((files) => {
    const contents = files.map((blocks) =>
      blocks.map(renderModule).join("\n\n")
    );
    // Flatten preserving file order then block order — the same order in which
    // extractModuleVersions scans them.
    const specs = files.flat();
    return { contents, specs };
  });

/* ------------------------------------------------------------------ */
/*  Property 11: Extracción de versiones del módulo RDS                */
/*  **Validates: Requirements 4.2**                                    */
/* ------------------------------------------------------------------ */

// Feature: portal-rds-creation-improvement, Property 11: Extracción de versiones del módulo RDS
test("Property 11: extractModuleVersions returns exactly the versions of rds/aws module blocks, ignoring other sources", () => {
  fc.assert(
    fc.property(tfFilesArb, ({ contents, specs }) => {
      const expected = specs
        .filter((s) => s.isRds)
        .map((s) => s.version);

      const actual = extractModuleVersions(contents);

      assert.deepEqual(
        actual,
        expected,
        `Expected only versions of "${RDS_SOURCE}" blocks (in order), got ${JSON.stringify(
          actual
        )} vs ${JSON.stringify(expected)}`
      );
    }),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Generators — Version_Modulo selection                             */
/* ------------------------------------------------------------------ */

/** A multiset of pinned MAJOR.MINOR.PATCH versions (possibly empty). */
const moduleVersionsArb = fc.array(fc.stringMatching(/^\d+\.\d+\.\d+$/));

/* ------------------------------------------------------------------ */
/*  Reference implementation (independent of the production code)      */
/* ------------------------------------------------------------------ */

/** Compares two MAJOR.MINOR.PATCH strings numerically, segment by segment. */
function refCompareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Versions sharing the maximum frequency in the multiset. */
function refMostFrequent(versions: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of versions) counts.set(v, (counts.get(v) ?? 0) + 1);
  const maxCount = Math.max(...counts.values());
  return [...counts.entries()]
    .filter(([, c]) => c === maxCount)
    .map(([v]) => v);
}

/* ------------------------------------------------------------------ */
/*  Property 12: Selección de Version_Modulo (moda; empate→mayor semver) */
/*  **Validates: Requirements 4.3**                                    */
/* ------------------------------------------------------------------ */

// Feature: portal-rds-creation-improvement, Property 12: Selección de Version_Modulo (moda; empate→mayor semver)
test("Property 12: selectModuleVersion returns the most frequent version; on a frequency tie, the highest semver", () => {
  fc.assert(
    fc.property(
      moduleVersionsArb.filter((vs) => vs.length > 0),
      (versions) => {
        const result = selectModuleVersion(versions);
        assert.notEqual(result, null);

        const mostFrequent = refMostFrequent(versions);

        // The result must be one of the most-frequent versions (the "moda").
        assert.ok(
          mostFrequent.includes(result as string),
          `Result ${JSON.stringify(result)} is not among the most-frequent versions ${JSON.stringify(
            mostFrequent
          )}`
        );

        // Among the most-frequent versions, the result must be the semver-highest.
        const highest = mostFrequent.reduce((best, v) =>
          refCompareSemver(v, best) > 0 ? v : best
        );
        assert.equal(
          refCompareSemver(result as string, highest),
          0,
          `Result ${JSON.stringify(result)} is not semver-equal to the highest most-frequent version ${JSON.stringify(
            highest
          )}`
        );
      }
    ),
    { numRuns: 100 }
  );
});

// Feature: portal-rds-creation-improvement, Property 12: Selección de Version_Modulo (empty input)
test("Property 12: selectModuleVersion([]) returns null", () => {
  assert.equal(selectModuleVersion([]), null);
});
