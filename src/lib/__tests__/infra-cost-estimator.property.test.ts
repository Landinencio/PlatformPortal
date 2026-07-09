/**
 * Property-based tests for Infrastructure Cost Estimator.
 *
 * Feature: infra-robustness
 * Properties 6, 7, and 8
 *
 * **Validates: Requirements 5.1, 5.3, 5.4**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { estimateRdsCostV2, estimateS3Cost } from "../infra-cost-estimator";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Generate a valid RDS instance class */
const instanceClassArb = fc.constantFrom(
  "db.t4g.micro",
  "db.t4g.small",
  "db.t4g.medium",
  "db.t4g.large"
);

/** Generate an unknown instance class (falls back to db.t4g.micro pricing) */
const unknownInstanceClassArb = fc
  .stringMatching(/^db\.[a-z][a-z0-9]{1,10}\.[a-z]+$/)
  .filter(
    (s) =>
      s !== "db.t4g.micro" &&
      s !== "db.t4g.small" &&
      s !== "db.t4g.medium" &&
      s !== "db.t4g.large"
  );

/** Generate storage size in GB (realistic range) */
const storageGbArb = fc.integer({ min: 20, max: 1000 });

/** Generate multiAz boolean */
const multiAzArb = fc.boolean();

/** Generate target environments array */
const targetEnvironmentsArb = fc.subarray(["dev", "staging", "prod", "qa"], {
  minLength: 1,
  maxLength: 4,
});

/** Generate full RDS cost params */
const rdsCostParamsArb = fc.record({
  instanceClass: instanceClassArb,
  storageGb: storageGbArb,
  multiAz: multiAzArb,
  targetEnvironments: targetEnvironmentsArb,
});

/** Generate RDS cost params with unknown instance class (fallback case) */
const rdsCostParamsWithUnknownClassArb = fc.record({
  instanceClass: unknownInstanceClassArb,
  storageGb: storageGbArb,
  multiAz: multiAzArb,
  targetEnvironments: targetEnvironmentsArb,
});

/* ------------------------------------------------------------------ */
/*  Instance pricing lookup (mirrors source for verification)          */
/* ------------------------------------------------------------------ */

const KNOWN_PRICING: Record<string, number> = {
  "db.t4g.micro": 12,
  "db.t4g.small": 25,
  "db.t4g.medium": 47,
  "db.t4g.large": 95,
};

function getBaseInstanceCost(instanceClass: string): number {
  return KNOWN_PRICING[instanceClass] ?? KNOWN_PRICING["db.t4g.micro"];
}

/* ------------------------------------------------------------------ */
/*  Property 6: RDS backup cost is 30% of instance cost                */
/*  **Validates: Requirements 5.1**                                    */
/* ------------------------------------------------------------------ */

test("Property 6: RDS backup cost equals 30% of base instance monthly cost (known classes)", () => {
  fc.assert(
    fc.property(rdsCostParamsArb, (params) => {
      const result = estimateRdsCostV2(params);
      const baseCost = getBaseInstanceCost(params.instanceClass);
      const expectedBackup = +(baseCost * 0.3).toFixed(2);

      // The breakdown should contain the backup storage cost value
      assert.ok(
        result.breakdown.includes(`backup storage: $${expectedBackup}/env`),
        `Breakdown should contain backup storage cost of $${expectedBackup}/env for ${params.instanceClass}. Got: ${result.breakdown}`
      );

      // Verify the total includes backup cost
      const envCount = params.targetEnvironments.length || 1;
      const computePerEnv = params.multiAz ? baseCost * 2 : baseCost;
      const storagePerEnv = +(params.storageGb * 0.115).toFixed(2);
      const perEnv = computePerEnv + storagePerEnv + expectedBackup;
      const expectedTotal = +(perEnv * envCount).toFixed(2);

      assert.equal(
        result.monthlyCost,
        expectedTotal,
        `Total cost should include backup. Expected ${expectedTotal}, got ${result.monthlyCost}`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 6: RDS backup cost equals 30% of base instance cost (unknown class falls back to db.t4g.micro)", () => {
  fc.assert(
    fc.property(rdsCostParamsWithUnknownClassArb, (params) => {
      const result = estimateRdsCostV2(params);
      // Unknown classes fall back to db.t4g.micro pricing ($12)
      const baseCost = 12;
      const expectedBackup = +(baseCost * 0.3).toFixed(2);

      assert.ok(
        result.breakdown.includes(`backup storage: $${expectedBackup}/env`),
        `Breakdown should contain backup storage cost of $${expectedBackup}/env for unknown class. Got: ${result.breakdown}`
      );
    }),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 7: Data transfer warning for applicable resources         */
/*  **Validates: Requirements 5.3**                                    */
/* ------------------------------------------------------------------ */

test("Property 7: RDS estimates include data transfer warning with $0.09/GB", () => {
  fc.assert(
    fc.property(rdsCostParamsArb, (params) => {
      const result = estimateRdsCostV2(params);

      assert.ok(
        result.warning !== undefined && result.warning.includes("$0.09/GB"),
        `RDS warning should contain "$0.09/GB". Got warning: ${result.warning}`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 7: S3 estimates include data transfer warning with $0.09/GB", () => {
  // S3 has no parameters, but we run multiple times to confirm consistency
  fc.assert(
    fc.property(fc.constant(null), () => {
      const result = estimateS3Cost();

      assert.ok(
        result.warning !== undefined && result.warning.includes("$0.09/GB"),
        `S3 warning should contain "$0.09/GB". Got warning: ${result.warning}`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 7: Data transfer warning present regardless of Multi-AZ setting", () => {
  fc.assert(
    fc.property(
      instanceClassArb,
      storageGbArb,
      multiAzArb,
      targetEnvironmentsArb,
      (instanceClass, storageGb, multiAz, targetEnvironments) => {
        const result = estimateRdsCostV2({
          instanceClass,
          storageGb,
          multiAz,
          targetEnvironments,
        });

        assert.ok(
          result.warning !== undefined && result.warning.includes("$0.09/GB"),
          `Warning must always contain "$0.09/GB" regardless of multiAz=${multiAz}. Got: ${result.warning}`
        );
      }
    ),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 8: Backup cost as separate line item                      */
/*  **Validates: Requirements 5.4**                                    */
/* ------------------------------------------------------------------ */

test("Property 8: RDS breakdown contains backup storage as distinct line item separate from compute and storage", () => {
  fc.assert(
    fc.property(rdsCostParamsArb, (params) => {
      const result = estimateRdsCostV2(params);

      // The breakdown must contain "backup storage" as a distinct substring
      assert.ok(
        result.breakdown.includes("backup storage"),
        `Breakdown should contain "backup storage" as a separate item. Got: ${result.breakdown}`
      );

      // Verify it's separate from compute (instanceClass) and storage GB
      const hasCompute = result.breakdown.includes(params.instanceClass);
      const hasStorage = result.breakdown.includes(`storage ${params.storageGb} GB`);
      const hasBackup = result.breakdown.includes("backup storage");

      assert.ok(
        hasCompute && hasStorage && hasBackup,
        `Breakdown must have all three distinct items: compute (${hasCompute}), storage (${hasStorage}), backup (${hasBackup}). Got: ${result.breakdown}`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 8: Backup storage cost value in breakdown matches 30% of base instance cost", () => {
  fc.assert(
    fc.property(rdsCostParamsArb, (params) => {
      const result = estimateRdsCostV2(params);
      const baseCost = getBaseInstanceCost(params.instanceClass);
      const expectedBackup = +(baseCost * 0.3).toFixed(2);

      // The backup cost value should appear in the breakdown
      const backupPattern = `backup storage: $${expectedBackup}/env`;
      assert.ok(
        result.breakdown.includes(backupPattern),
        `Breakdown should contain "${backupPattern}". Got: ${result.breakdown}`
      );
    }),
    { numRuns: 100 }
  );
});
