/**
 * Property-based tests for deployment-correlation.
 *
 * Feature: dora-metrics-production-readiness
 * Properties 2, 3, 12
 *
 * **Validates: Requirements 3.2, 3.4, 14.4**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  filterByConfidence,
  shouldShowLowConfidenceWarning,
  selectBestCorrelationPerPipeline,
  MIN_CORRELATION_CONFIDENCE,
  type Correlation,
  type GitLabDeploy,
  type ArgocdSync,
} from "../deployment-correlation";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Generate a valid confidence score in [0, 1] */
const confidenceArb = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

/** Generate a valid minConfidence threshold in (0, 1] */
const thresholdArb = fc.double({ min: 0.01, max: 1, noNaN: true, noDefaultInfinity: true });

/** Generate a pipeline ID string */
const pipelineIdArb = fc.constantFrom("pipeline-1", "pipeline-2", "pipeline-3", "pipeline-4", "pipeline-5");

/** Generate an app key string */
const appKeyArb = fc.constantFrom("app-x", "app-y", "app-z", "app-w");

/** Generate a minimal GitLabDeploy */
function gitlabDeployArb(pipelineId: string): fc.Arbitrary<GitLabDeploy> {
  return fc.record({
    projectId: fc.nat({ max: 10000 }),
    projectName: fc.constant("test-project"),
    pipelineId: fc.constant(pipelineId),
    jobId: fc.constant(null),
    commitSha: fc.constant("abc123"),
    commitTimestamp: fc.constant(null),
    pipelineStatus: fc.constant("success"),
    pipelineTimestamp: fc.constant(new Date("2025-01-01T00:00:00Z")),
  });
}

/** Generate a minimal ArgocdSync */
function argocdSyncArb(appKey: string): fc.Arbitrary<ArgocdSync> {
  return fc.record({
    appName: fc.constant("app"),
    appKey: fc.constant(appKey),
    project: fc.constant("default"),
    namespace: fc.constant("prod"),
    cluster: fc.constant(null),
    repo: fc.constant(null),
    syncTimestamp: fc.constant(new Date("2025-01-01T00:05:00Z")),
    syncStatus: fc.constant("Succeeded"),
    healthStatus: fc.constant("Healthy"),
    operation: fc.constant(null),
  });
}

/** Generate a Correlation with a specific confidence, pipelineId, and appKey */
function correlationArb(
  confidence: fc.Arbitrary<number>,
  pipelineId?: fc.Arbitrary<string>,
  appKey?: fc.Arbitrary<string>
): fc.Arbitrary<Correlation> {
  const pid = pipelineId ?? pipelineIdArb;
  const ak = appKey ?? appKeyArb;

  return fc.tuple(pid, ak, confidence).chain(([p, a, c]) =>
    fc.tuple(gitlabDeployArb(p), argocdSyncArb(a)).map(([gitlab, argocd]) => ({
      gitlab,
      argocd,
      method: "name-match" as const,
      confidence: c,
      timeDiffMinutes: 5,
    }))
  );
}

/** Generate an array of correlations with random confidences */
const correlationsArb = fc.array(correlationArb(confidenceArb), { minLength: 0, maxLength: 50 });

/** Generate a non-empty array of correlations */
const nonEmptyCorrelationsArb = fc.array(correlationArb(confidenceArb), { minLength: 1, maxLength: 50 });

/* ------------------------------------------------------------------ */
/*  Property 2: Confidence Filtering                                   */
/*  **Validates: Requirements 3.2**                                    */
/* ------------------------------------------------------------------ */

test("Property 2: filterByConfidence result is a subset of the original array", () => {
  fc.assert(
    fc.property(correlationsArb, thresholdArb, (correlations, threshold) => {
      const filtered = filterByConfidence(correlations, threshold);

      // Result must be a subset: every element in filtered must exist in original
      for (const item of filtered) {
        assert.ok(
          correlations.includes(item),
          "Every filtered correlation must be present in the original array"
        );
      }

      // Result length must be <= original length
      assert.ok(
        filtered.length <= correlations.length,
        `Filtered length (${filtered.length}) must be <= original length (${correlations.length})`
      );
    }),
    { numRuns: 200 }
  );
});

test("Property 2: all entries in filterByConfidence result have confidence >= threshold", () => {
  fc.assert(
    fc.property(correlationsArb, thresholdArb, (correlations, threshold) => {
      const filtered = filterByConfidence(correlations, threshold);

      for (const item of filtered) {
        assert.ok(
          item.confidence >= threshold,
          `Confidence ${item.confidence} should be >= threshold ${threshold}`
        );
      }
    }),
    { numRuns: 200 }
  );
});

test("Property 2: filterByConfidence does not discard entries that meet the threshold", () => {
  fc.assert(
    fc.property(correlationsArb, thresholdArb, (correlations, threshold) => {
      const filtered = filterByConfidence(correlations, threshold);
      const expectedCount = correlations.filter((c) => c.confidence >= threshold).length;

      assert.equal(
        filtered.length,
        expectedCount,
        `Filtered count (${filtered.length}) should equal count of items >= threshold (${expectedCount})`
      );
    }),
    { numRuns: 200 }
  );
});

test("Property 2: filterByConfidence uses MIN_CORRELATION_CONFIDENCE as default", () => {
  fc.assert(
    fc.property(correlationsArb, (correlations) => {
      const filtered = filterByConfidence(correlations);

      for (const item of filtered) {
        assert.ok(
          item.confidence >= MIN_CORRELATION_CONFIDENCE,
          `Confidence ${item.confidence} should be >= default threshold ${MIN_CORRELATION_CONFIDENCE}`
        );
      }

      const expectedCount = correlations.filter(
        (c) => c.confidence >= MIN_CORRELATION_CONFIDENCE
      ).length;
      assert.equal(filtered.length, expectedCount);
    }),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 3: Low Confidence Warning                                 */
/*  **Validates: Requirements 3.4**                                    */
/* ------------------------------------------------------------------ */

test("Property 3: shouldShowLowConfidenceWarning is true iff >30% are below threshold", () => {
  fc.assert(
    fc.property(nonEmptyCorrelationsArb, thresholdArb, (correlations, threshold) => {
      const warning = shouldShowLowConfidenceWarning(correlations, threshold);
      const belowCount = correlations.filter((c) => c.confidence < threshold).length;
      const ratio = belowCount / correlations.length;

      if (ratio > 0.3) {
        assert.equal(
          warning,
          true,
          `Warning should be true when ${(ratio * 100).toFixed(1)}% (${belowCount}/${correlations.length}) are below threshold ${threshold}`
        );
      } else {
        assert.equal(
          warning,
          false,
          `Warning should be false when ${(ratio * 100).toFixed(1)}% (${belowCount}/${correlations.length}) are below threshold ${threshold}`
        );
      }
    }),
    { numRuns: 200 }
  );
});

test("Property 3: shouldShowLowConfidenceWarning returns false for empty array", () => {
  const result = shouldShowLowConfidenceWarning([], 0.7);
  assert.equal(result, false, "Empty correlations should not trigger warning");
});

test("Property 3: shouldShowLowConfidenceWarning uses MIN_CORRELATION_CONFIDENCE as default", () => {
  fc.assert(
    fc.property(nonEmptyCorrelationsArb, (correlations) => {
      const warning = shouldShowLowConfidenceWarning(correlations);
      const belowCount = correlations.filter(
        (c) => c.confidence < MIN_CORRELATION_CONFIDENCE
      ).length;
      const ratio = belowCount / correlations.length;

      assert.equal(warning, ratio > 0.3);
    }),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 12: Best Correlation Per Pipeline                         */
/*  **Validates: Requirements 14.4**                                   */
/* ------------------------------------------------------------------ */

test("Property 12: selectBestCorrelationPerPipeline picks highest confidence per group", () => {
  // Generate correlations with controlled pipeline/app groups
  const groupedCorrelationsArb = fc
    .tuple(
      fc.array(fc.constantFrom("p1", "p2", "p3"), { minLength: 1, maxLength: 3 }),
      fc.array(fc.constantFrom("app1", "app2"), { minLength: 1, maxLength: 2 })
    )
    .chain(([pipelineIds, appKeys]) => {
      // For each combination, generate 1-5 correlations with different confidences
      const corrArbs: fc.Arbitrary<Correlation>[] = [];
      for (const pid of pipelineIds) {
        for (const ak of appKeys) {
          corrArbs.push(
            correlationArb(
              confidenceArb,
              fc.constant(pid),
              fc.constant(ak)
            )
          );
        }
      }
      return fc.tuple(...corrArbs);
    })
    .map((corrs) => corrs);

  fc.assert(
    fc.property(groupedCorrelationsArb, (correlations) => {
      const result = selectBestCorrelationPerPipeline(correlations);

      // For each group in the result, verify it has the highest confidence
      for (const [key, bestCorr] of result) {
        // Find all correlations in the same group
        const groupMembers = correlations.filter(
          (c) => `${c.gitlab.pipelineId}::${c.argocd.appKey}` === key
        );

        assert.ok(
          groupMembers.length > 0,
          `Group "${key}" should have at least one member`
        );

        // The selected correlation must have the highest confidence in the group
        const maxConfidence = Math.max(...groupMembers.map((c) => c.confidence));
        assert.equal(
          bestCorr.confidence,
          maxConfidence,
          `Best correlation for group "${key}" should have confidence ${maxConfidence}, got ${bestCorr.confidence}`
        );
      }
    }),
    { numRuns: 200 }
  );
});

test("Property 12: selectBestCorrelationPerPipeline returns one entry per unique (pipelineId, appKey)", () => {
  fc.assert(
    fc.property(correlationsArb, (correlations) => {
      const result = selectBestCorrelationPerPipeline(correlations);

      // Count unique groups in input
      const uniqueKeys = new Set(
        correlations.map((c) => `${c.gitlab.pipelineId}::${c.argocd.appKey}`)
      );

      assert.equal(
        result.size,
        uniqueKeys.size,
        `Result size (${result.size}) should equal unique groups (${uniqueKeys.size})`
      );
    }),
    { numRuns: 200 }
  );
});

test("Property 12: selectBestCorrelationPerPipeline result values are from the original array", () => {
  fc.assert(
    fc.property(correlationsArb, (correlations) => {
      const result = selectBestCorrelationPerPipeline(correlations);

      for (const [, bestCorr] of result) {
        assert.ok(
          correlations.includes(bestCorr),
          "Selected correlation must be from the original array"
        );
      }
    }),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Feature: dora-author-scoping, Property 14: Filtrado por confianza   */
/*  de correlaciones (cierre spec previa)                              */
/*  **Validates: Requirements 8.3**                                    */
/* ------------------------------------------------------------------ */

test("Feature: dora-author-scoping, Property 14: filterByConfidence keeps exactly the correlations with score >= MIN_CORRELATION_CONFIDENCE as a faithful subset", () => {
  fc.assert(
    fc.property(correlationsArb, (correlations) => {
      const filtered = filterByConfidence(correlations, MIN_CORRELATION_CONFIDENCE);

      // (a) Subset without adding or modifying elements: every element of the
      //     result is the very same object reference present in the original.
      for (const item of filtered) {
        assert.ok(
          correlations.includes(item),
          "Every filtered correlation must be the same element present in the original array"
        );
      }
      assert.ok(
        filtered.length <= correlations.length,
        `Filtered length (${filtered.length}) must be <= original length (${correlations.length})`
      );

      // (b) Keeps all and only correlations with score >= MIN_CORRELATION_CONFIDENCE.
      //     - "only": every kept element meets the threshold.
      for (const item of filtered) {
        assert.ok(
          item.confidence >= MIN_CORRELATION_CONFIDENCE,
          `Kept confidence ${item.confidence} must be >= threshold ${MIN_CORRELATION_CONFIDENCE}`
        );
      }
      //     - "all": every element meeting the threshold is kept (count match).
      const expected = correlations.filter((c) => c.confidence >= MIN_CORRELATION_CONFIDENCE);
      assert.equal(
        filtered.length,
        expected.length,
        `Filtered count (${filtered.length}) must equal count of items >= threshold (${expected.length})`
      );
      //     - Relative order is preserved (no reordering / mutation of the list).
      assert.deepEqual(
        filtered,
        expected,
        "Filtered result must equal the in-order subset of qualifying correlations"
      );
    }),
    { numRuns: 100, seed: 14, endOnFailure: true }
  );
});
