import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateChangeFailureRatePct,
  calculateDeploymentFrequencyPerProjectDay,
  calculateOpenAgingBuckets,
  calculateSonarRiskScore,
  isValidLeadTimeHours,
  LEAD_TIME_GUARD_HOURS,
  pickPreferredLeadTimeHours,
} from "../src/lib/metrics-formulas";

test("pickPreferredLeadTimeHours prioriza primer commit, luego MR y luego ultimo commit", () => {
  // first_commit is preferred when available
  assert.equal(pickPreferredLeadTimeHours(2, 10, 20), 20);
  // fallback to mr_created when first_commit is 0
  assert.equal(pickPreferredLeadTimeHours(5, 10, 0), 10);
  // fallback to last_commit when first_commit and mr are 0
  assert.equal(pickPreferredLeadTimeHours(5, 0, 0), 5);
  // returns null when no variant has valid data
  assert.equal(pickPreferredLeadTimeHours(0, 0, 0), null);
  // negative values are discarded
  assert.equal(pickPreferredLeadTimeHours(-1, -2, -3), null);
  assert.equal(pickPreferredLeadTimeHours(-1, 10, -3), 10);
});

test("isValidLeadTimeHours respeta el guard rail de 90 dias", () => {
  assert.equal(isValidLeadTimeHours(0), true);
  assert.equal(isValidLeadTimeHours(12), true);
  assert.equal(isValidLeadTimeHours(LEAD_TIME_GUARD_HOURS), true);
  assert.equal(isValidLeadTimeHours(LEAD_TIME_GUARD_HOURS + 0.01), false);
  assert.equal(isValidLeadTimeHours(-1), false);
});

test("calculateDeploymentFrequencyPerProjectDay normaliza por proyecto y dia", () => {
  assert.equal(calculateDeploymentFrequencyPerProjectDay(12, 6), 2);
  assert.equal(calculateDeploymentFrequencyPerProjectDay(0, 6), 0);
  assert.equal(calculateDeploymentFrequencyPerProjectDay(12, 0), 0);
});

test("calculateChangeFailureRatePct usa fallos sobre deployments totales (DORA standard)", () => {
  // The formula treats the two args as DISJOINT counts (successful deployments
  // and failures), matching the snapshot columns deployment_count /
  // deployment_failures. CFR = failures / (deployments + failures) * 100.
  // 2 failures, 6 successful deployments → 2/8 = 25%
  assert.equal(calculateChangeFailureRatePct(6, 2), 25);
  assert.equal(calculateChangeFailureRatePct(10, 0), 0);
  assert.equal(calculateChangeFailureRatePct(0, 0), 0);
  // 5 failures, 5 successful deployments → 5/10 = 50%
  assert.equal(calculateChangeFailureRatePct(5, 5), 50);
  // only failures, no successful deployments → 5/5 = 100%
  assert.equal(calculateChangeFailureRatePct(0, 5), 100);
});

test("calculateOpenAgingBuckets separa abiertas envejecidas por tramos", () => {
  const buckets = calculateOpenAgingBuckets([12, 24 * 3, 24 * 8, 24 * 20]);

  assert.deepEqual(buckets, {
    over3d: 3,
    over7d: 2,
    over14d: 1,
  });
});

test("calculateSonarRiskScore pondera riesgo de forma determinista", () => {
  const baseline = calculateSonarRiskScore({
    vulnerabilities: 1,
    bugs: 2,
    securityHotspots: 3,
    qualityGate: "OK",
    coverage: 85,
  });
  const worse = calculateSonarRiskScore({
    vulnerabilities: 2,
    bugs: 2,
    securityHotspots: 3,
    qualityGate: "ERROR",
    coverage: 40,
  });

  assert.equal(baseline, 12.5);
  assert.equal(worse, 76.5);
  assert.ok(worse > baseline);
});
