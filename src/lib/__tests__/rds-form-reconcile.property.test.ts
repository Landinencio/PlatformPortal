/**
 * Property-based tests for the RDS form version reconciliation.
 *
 * Feature: portal-rds-creation-improvement — src/lib/rds/version-catalog.ts
 *
 * Property 2: Reset de versión al cambiar de motor.
 *   For every (newEngine, prevVersion) pair, if `prevVersion` does NOT belong
 *   to `newEngine`'s catalog the reconciliation discards it and replaces it
 *   with `defaultVersionForEngine(newEngine)` (or the "no selection" state that
 *   blocks submission); if it DOES belong, `prevVersion` is kept.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  type RdsEngine,
  reconcileVersionOnEngineChange,
  defaultVersionForEngine,
  versionsForEngine,
} from "../rds/version-catalog";

/** Engine generator: PostgreSQL is the only supported Motor (MySQL removed). */
const engineArb: fc.Arbitrary<RdsEngine> = fc.constantFrom("postgres");

/**
 * prevVersion generator: a mix of valid PostgreSQL catalog versions plus free
 * random strings (which almost never belong to the catalog). MySQL versions are
 * no longer part of the catalog, so they fall into the "foreign" bucket like any
 * other random string.
 */
const prevVersionArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...versionsForEngine("postgres").map((v) => v.version)),
  fc.constantFrom("8.4", "8.0", "13", "5.7"),
  fc.string(),
);

// Feature: portal-rds-creation-improvement, Property 2: Reset de versión al cambiar de motor
test("Property 2: reconcileVersionOnEngineChange keeps prevVersion iff it belongs to the new engine, else resets to default", () => {
  fc.assert(
    fc.property(engineArb, prevVersionArb, (newEngine, prevVersion) => {
      const result = reconcileVersionOnEngineChange(newEngine, prevVersion);

      const belongsToNewEngine = versionsForEngine(newEngine).some(
        (v) => v.version === prevVersion,
      );

      if (belongsToNewEngine) {
        // The previous version is valid for the new engine: it must be kept.
        assert.equal(
          result,
          prevVersion,
          `expected prevVersion "${prevVersion}" to be kept for engine "${newEngine}"`,
        );
      } else {
        // The previous version does not belong to the new engine: it is
        // discarded and replaced by the engine's Version_Estandar.
        assert.equal(
          result,
          defaultVersionForEngine(newEngine),
          `expected reset to default for engine "${newEngine}" when prevVersion "${prevVersion}" is foreign`,
        );
      }
    }),
    { numRuns: 100 },
  );
});
