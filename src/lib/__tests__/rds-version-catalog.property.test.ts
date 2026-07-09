/**
 * Property-based tests for the RDS Catalogo_Versiones.
 *
 * Feature: portal-rds-creation-improvement — src/lib/rds/version-catalog.ts
 *
 * Property 1: Coherencia entre catálogo, motor y familia.
 *   For every supported engine `e` and every version `v` of its catalog,
 *   `familyForVersion(e, v)` starts with the engine name (`postgres*` for
 *   postgres, `mysql*` for mysql) and never another engine's; and
 *   `versionsForEngine(e)` contains only pairs belonging to `e`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  type RdsEngine,
  SUPPORTED_ENGINES,
  versionsForEngine,
  familyForVersion,
} from "../rds/version-catalog";

/** Engine generator: PostgreSQL is the only supported Motor (MySQL removed). */
const engineArb: fc.Arbitrary<RdsEngine> = fc.constantFrom("postgres");

/**
 * Picks a supported engine together with one of its catalog versions.
 * Uses an index into the engine's version list so every (engine, version)
 * pair drawn is guaranteed to belong to the catalog.
 */
const engineVersionArb: fc.Arbitrary<{ engine: RdsEngine; version: string }> = engineArb.chain(
  (engine) => {
    const versions = versionsForEngine(engine);
    return fc
      .integer({ min: 0, max: versions.length - 1 })
      .map((i) => ({ engine, version: versions[i].version }));
  },
);

// Feature: portal-rds-creation-improvement, Property 1: Coherencia entre catálogo, motor y familia
test("Property 1: familyForVersion starts with the engine name and versionsForEngine only holds pairs of that engine", () => {
  fc.assert(
    fc.property(engineVersionArb, ({ engine, version }) => {
      // familyForVersion(e, v) derives a family that starts with the engine name.
      const family = familyForVersion(engine, version);
      assert.notEqual(family, null, `expected a family for ${engine}/${version}`);
      assert.ok(
        family!.startsWith(engine),
        `family "${family}" should start with engine "${engine}"`,
      );

      // ...and never with another engine's name.
      for (const other of SUPPORTED_ENGINES) {
        if (other !== engine) {
          assert.ok(
            !family!.startsWith(other),
            `family "${family}" must not start with foreign engine "${other}"`,
          );
        }
      }

      // versionsForEngine(e) contains only pairs belonging to e: every family
      // listed for the engine starts with the engine name (and no other's).
      for (const ev of versionsForEngine(engine)) {
        assert.ok(
          ev.family.startsWith(engine),
          `version ${ev.version} family "${ev.family}" should start with "${engine}"`,
        );
        for (const other of SUPPORTED_ENGINES) {
          if (other !== engine) {
            assert.ok(
              !ev.family.startsWith(other),
              `family "${ev.family}" must not start with foreign engine "${other}"`,
            );
          }
        }
      }
    }),
    { numRuns: 100 },
  );
});
