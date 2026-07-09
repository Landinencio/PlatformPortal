/**
 * Property-based tests for metrics-formulas.
 *
 * Feature: dora-metrics-production-readiness
 * Properties 1, 7, 9
 *
 * **Validates: Requirements 1.2, 1.3, 7.4, 11.1**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  selectLeadTimeWithVariant,
  CANONICAL_LEAD_TIME_VARIANT,
  calculateConfidenceScore,
  isAnomalousDeploymentFrequency,
  DF_ANOMALY_THRESHOLD,
  LEAD_TIME_FALLBACK_ORDER,
  type LeadTimeVariant,
} from "../metrics-formulas";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Generate a positive finite number (valid lead time hours) */
const positiveHoursArb = fc.double({ min: 0.001, max: 100_000, noNaN: true });

/** Generate an invalid lead time value: null, zero, negative, NaN, Infinity */
const invalidHoursArb = fc.oneof(
  fc.constant(null as number | null),
  fc.constant(0),
  fc.double({ min: -100_000, max: -0.001, noNaN: true }),
  fc.constant(NaN),
  fc.constant(Infinity),
  fc.constant(-Infinity)
);

/** Generate either a valid or invalid hours value */
const anyHoursArb = fc.oneof(positiveHoursArb, invalidHoursArb);

/** Generate a valid leadTimeCoveragePct [0, 100] */
const coveragePctArb = fc.double({ min: 0, max: 100, noNaN: true });

/** Generate a valid avgCorrelationConfidence [0, 1] */
const correlationConfidenceArb = fc.double({ min: 0, max: 1, noNaN: true });

/** Generate a non-negative anomaly count */
const anomalyCountArb = fc.nat({ max: 100 });

/** Generate a positive deployment frequency value */
const positiveFrequencyArb = fc.double({ min: 0.001, max: 10_000, noNaN: true });

/* ------------------------------------------------------------------ */
/*  Helper                                                             */
/* ------------------------------------------------------------------ */

function isValidPositive(v: number | null): v is number {
  return v != null && Number.isFinite(v) && v > 0;
}

/* ------------------------------------------------------------------ */
/*  Property 1: Lead Time Fallback Selection                           */
/*  **Validates: Requirements 1.2, 1.3**                               */
/* ------------------------------------------------------------------ */

test("Property 1: selectLeadTimeWithVariant returns first valid variant in canonical order", () => {
  fc.assert(
    fc.property(anyHoursArb, anyHoursArb, anyHoursArb, (first, mr, last) => {
      const result = selectLeadTimeWithVariant(first, mr, last);
      const values = [first, mr, last];
      const variants: LeadTimeVariant[] = ["first_commit", "mr_created", "last_commit"];

      // Find the expected first valid index
      let expectedIdx = -1;
      for (let i = 0; i < values.length; i++) {
        if (isValidPositive(values[i])) {
          expectedIdx = i;
          break;
        }
      }

      if (expectedIdx === -1) {
        // No valid value → should return null
        assert.equal(
          result,
          null,
          "Should return null when no valid lead time is available"
        );
      } else {
        // Should return the first valid variant
        assert.notEqual(result, null, "Should return a result when a valid value exists");
        assert.equal(
          result!.variant,
          variants[expectedIdx],
          `Should select variant "${variants[expectedIdx]}" (index ${expectedIdx})`
        );
        assert.equal(
          result!.hours,
          values[expectedIdx],
          "Should return the hours of the selected variant"
        );
      }
    }),
    { numRuns: 200 }
  );
});

test("Property 1: selectLeadTimeWithVariant returns null when all values are invalid", () => {
  fc.assert(
    fc.property(invalidHoursArb, invalidHoursArb, invalidHoursArb, (first, mr, last) => {
      const result = selectLeadTimeWithVariant(first, mr, last);
      assert.equal(result, null, "Should return null when all values are invalid");
    }),
    { numRuns: 100 }
  );
});

test("Property 1: selectLeadTimeWithVariant variant is always in LEAD_TIME_FALLBACK_ORDER", () => {
  fc.assert(
    fc.property(anyHoursArb, anyHoursArb, anyHoursArb, (first, mr, last) => {
      const result = selectLeadTimeWithVariant(first, mr, last);
      if (result !== null) {
        assert.ok(
          LEAD_TIME_FALLBACK_ORDER.includes(result.variant),
          `Variant "${result.variant}" should be in LEAD_TIME_FALLBACK_ORDER`
        );
        assert.ok(
          Number.isFinite(result.hours) && result.hours > 0,
          `Hours ${result.hours} should be finite and positive`
        );
      }
    }),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 9: Confidence Score Range                                 */
/*  **Validates: Requirements 11.1**                                   */
/* ------------------------------------------------------------------ */

test("Property 9: calculateConfidenceScore always returns a value in [0, 100]", () => {
  fc.assert(
    fc.property(
      coveragePctArb,
      correlationConfidenceArb,
      anomalyCountArb,
      (leadTimeCoveragePct, avgCorrelationConfidence, anomalyCount) => {
        const score = calculateConfidenceScore({
          leadTimeCoveragePct,
          avgCorrelationConfidence,
          anomalyCount,
        });
        assert.ok(
          score >= 0 && score <= 100,
          `Score ${score} should be in [0, 100] for inputs: coverage=${leadTimeCoveragePct}, confidence=${avgCorrelationConfidence}, anomalies=${anomalyCount}`
        );
      }
    ),
    { numRuns: 200 }
  );
});

test("Property 9: calculateConfidenceScore returns [0, 100] even with out-of-range inputs", () => {
  fc.assert(
    fc.property(
      fc.double({ min: -1000, max: 1000, noNaN: true }),
      fc.double({ min: -10, max: 10, noNaN: true }),
      fc.integer({ min: -100, max: 1000 }),
      (leadTimeCoveragePct, avgCorrelationConfidence, anomalyCount) => {
        const score = calculateConfidenceScore({
          leadTimeCoveragePct,
          avgCorrelationConfidence,
          anomalyCount,
        });
        assert.ok(
          score >= 0 && score <= 100,
          `Score ${score} should be in [0, 100] even with out-of-range inputs`
        );
      }
    ),
    { numRuns: 200 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 7: Anomaly Reporting                                      */
/*  **Validates: Requirements 7.4**                                    */
/* ------------------------------------------------------------------ */

test("Property 7: isAnomalousDeploymentFrequency returns true iff df > threshold", () => {
  fc.assert(
    fc.property(positiveFrequencyArb, (df) => {
      const isAnomaly = isAnomalousDeploymentFrequency(df);
      if (df > DF_ANOMALY_THRESHOLD) {
        assert.equal(
          isAnomaly,
          true,
          `df=${df} exceeds threshold=${DF_ANOMALY_THRESHOLD}, should be anomalous`
        );
      } else {
        assert.equal(
          isAnomaly,
          false,
          `df=${df} does not exceed threshold=${DF_ANOMALY_THRESHOLD}, should not be anomalous`
        );
      }
    }),
    { numRuns: 200 }
  );
});

test("Property 7: anomaly detection is consistent — threshold boundary", () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0, max: 200, noNaN: true }),
      (df) => {
        const isAnomaly = isAnomalousDeploymentFrequency(df);
        // The function uses strict > comparison
        if (df === DF_ANOMALY_THRESHOLD) {
          assert.equal(isAnomaly, false, "Exactly at threshold should NOT be anomalous");
        } else if (df > DF_ANOMALY_THRESHOLD) {
          assert.equal(isAnomaly, true, "Above threshold should be anomalous");
        } else {
          assert.equal(isAnomaly, false, "Below threshold should NOT be anomalous");
        }
      }
    ),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Feature: dora-author-scoping, Property 12: Selección de Lead Time  */
/*  con fallback canónico (cierre spec previa)                         */
/*  **Validates: Requirements 8.1**                                    */
/* ------------------------------------------------------------------ */

test("Feature: dora-author-scoping, Property 12: selectLeadTimeWithVariant picks the first available variant in canonical fallback order, null when none, never throws", () => {
  // The canonical variant is the first in the fallback order.
  assert.equal(CANONICAL_LEAD_TIME_VARIANT, "first_commit");
  assert.equal(LEAD_TIME_FALLBACK_ORDER[0], CANONICAL_LEAD_TIME_VARIANT);

  const fallbackVariants: LeadTimeVariant[] = [
    "first_commit",
    "mr_created",
    "last_commit",
  ];

  fc.assert(
    fc.property(anyHoursArb, anyHoursArb, anyHoursArb, (first, mr, last) => {
      const values: Array<number | null> = [first, mr, last];

      // The call must never throw for any combination of inputs.
      let result: { hours: number; variant: LeadTimeVariant } | null;
      assert.doesNotThrow(() => {
        result = selectLeadTimeWithVariant(first, mr, last);
      });

      result = selectLeadTimeWithVariant(first, mr, last);

      // Expected: first valid (finite and > 0) value in canonical order.
      const expectedIdx = values.findIndex(isValidPositive);

      if (expectedIdx === -1) {
        // No valid value among the three → documented "not available" indicator: null.
        assert.equal(result, null, "Should be null when no variant is valid");
      } else {
        assert.notEqual(result, null, "Should return a result when ≥1 variant is valid");
        assert.equal(
          result!.variant,
          fallbackVariants[expectedIdx],
          `Should pick the first available variant (${fallbackVariants[expectedIdx]})`
        );
        assert.equal(
          result!.hours,
          values[expectedIdx],
          "Should return the hours of the selected variant"
        );
      }
    }),
    { numRuns: 100, seed: 12, endOnFailure: true }
  );
});

/* ------------------------------------------------------------------ */
/*  Feature: dora-author-scoping, Property 13: Confidence score en     */
/*  rango cerrado [0,100] (cierre spec previa)                         */
/*  **Validates: Requirements 8.2**                                    */
/* ------------------------------------------------------------------ */

test("Feature: dora-author-scoping, Property 13: calculateConfidenceScore always returns a value within the closed range [0, 100] across the documented input domain, including boundaries and empty inputs", () => {
  // Documented input domain (from the JSDoc of calculateConfidenceScore):
  //   leadTimeCoveragePct ∈ [0, 100]
  //   avgCorrelationConfidence ∈ [0, 1]
  //   anomalyCount ≥ 0
  // The generators intentionally cover the boundaries: explicit 0/100, 0/1 and
  // anomalyCount = 0 (empty-activity scenario) are included in the value spaces.

  // Domain-constrained coverage [0, 100] with the boundaries guaranteed reachable.
  const domainCoverageArb = fc.oneof(
    fc.constant(0),
    fc.constant(100),
    fc.double({ min: 0, max: 100, noNaN: true })
  );

  // Domain-constrained correlation confidence [0, 1] with boundaries reachable.
  const domainConfidenceArb = fc.oneof(
    fc.constant(0),
    fc.constant(1),
    fc.double({ min: 0, max: 1, noNaN: true })
  );

  // Non-negative anomaly count, including the empty (0) case.
  const domainAnomalyArb = fc.oneof(fc.constant(0), fc.nat({ max: 1000 }));

  const prop = fc.property(
    domainCoverageArb,
    domainConfidenceArb,
    domainAnomalyArb,
    (leadTimeCoveragePct, avgCorrelationConfidence, anomalyCount) => {
      const score = calculateConfidenceScore({
        leadTimeCoveragePct,
        avgCorrelationConfidence,
        anomalyCount,
      });

      // Result must always be a finite number within the closed interval [0, 100].
      assert.ok(
        Number.isFinite(score),
        `Score ${score} should be a finite number for inputs: ` +
          `coverage=${leadTimeCoveragePct}, confidence=${avgCorrelationConfidence}, anomalies=${anomalyCount}`
      );
      assert.ok(
        score >= 0 && score <= 100,
        `Score ${score} should be within closed [0, 100] for inputs: ` +
          `coverage=${leadTimeCoveragePct}, confidence=${avgCorrelationConfidence}, anomalies=${anomalyCount}`
      );
    }
  );

  fc.assert(prop, { numRuns: 100, seed: 13, endOnFailure: true });
});
