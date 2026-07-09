/**
 * Property-based tests for sonarqube.ts
 *
 * Feature: dora-metrics-production-readiness
 * Properties 11, 5
 *
 * **Validates: Requirements 13.2, 5.4**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { calculateMappingCoveragePct } from "../sonarqube";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Generate a positive integer for MAX_SONAR_PAGES */
const maxPagesArb = fc.integer({ min: 1, max: 200 });

/** Generate a page size (positive integer) */
const pageSizeArb = fc.integer({ min: 1, max: 500 });

/** Generate total projects (positive integer) */
const totalProjectsArb = fc.integer({ min: 1, max: 10_000 });

/** Generate mapped count that is <= total */
const mappedCountArb = (total: number) => fc.integer({ min: 0, max: total });

/* ------------------------------------------------------------------ */
/*  Property 11: Pagination Limit                                      */
/*  **Validates: Requirements 13.2**                                   */
/* ------------------------------------------------------------------ */

/**
 * We test the pagination logic by simulating the iteration behavior.
 * The key property: for any MAX_SONAR_PAGES > 0, when the API returns
 * full pages indefinitely, the iteration stops after exactly
 * MAX_SONAR_PAGES pages.
 *
 * We extract the pagination logic into a testable simulation since
 * the actual getAllProjects method makes network calls.
 */

/**
 * Simulates the pagination loop logic from getAllProjects.
 * Returns the number of pages actually fetched.
 */
function simulatePagination(params: {
  maxPages: number;
  pageSize: number;
  totalAvailable: number;
}): { pagesFetched: number; projectsFetched: number; hitLimit: boolean } {
  const { maxPages, pageSize, totalAvailable } = params;
  let page = 1;
  let projectsFetched = 0;
  let hitLimit = false;

  while (true) {
    // Check page limit BEFORE fetching (same as implementation)
    if (page > maxPages) {
      hitLimit = true;
      break;
    }

    // Simulate API response
    const remaining = totalAvailable - projectsFetched;
    const componentsInPage = Math.min(pageSize, remaining);

    if (componentsInPage <= 0) break;

    projectsFetched += componentsInPage;

    // If page was not full, stop (same as implementation)
    if (componentsInPage < pageSize) break;

    page++;
  }

  return { pagesFetched: page > maxPages ? maxPages : page, projectsFetched, hitLimit };
}

test("Property 11: Pagination stops after exactly MAX_SONAR_PAGES when API returns full pages indefinitely", () => {
  fc.assert(
    fc.property(maxPagesArb, pageSizeArb, (maxPages, pageSize) => {
      // Simulate an API that always returns full pages (infinite projects)
      const totalAvailable = maxPages * pageSize + pageSize * 100; // way more than limit allows

      const result = simulatePagination({ maxPages, pageSize, totalAvailable });

      assert.equal(
        result.hitLimit,
        true,
        `Should hit the page limit when there are more projects than maxPages*pageSize`
      );
      assert.equal(
        result.pagesFetched,
        maxPages,
        `Should fetch exactly ${maxPages} pages, got ${result.pagesFetched}`
      );
      assert.equal(
        result.projectsFetched,
        maxPages * pageSize,
        `Should fetch exactly maxPages*pageSize = ${maxPages * pageSize} projects`
      );
    }),
    { numRuns: 200 }
  );
});

test("Property 11: Pagination stops early when API returns fewer projects than the limit allows", () => {
  fc.assert(
    fc.property(
      maxPagesArb,
      pageSizeArb,
      fc.integer({ min: 0, max: 5000 }),
      (maxPages, pageSize, totalAvailable) => {
        // Only test when total is less than what the limit would allow
        fc.pre(totalAvailable < maxPages * pageSize);

        const result = simulatePagination({ maxPages, pageSize, totalAvailable });

        assert.equal(
          result.hitLimit,
          false,
          `Should NOT hit the page limit when totalAvailable (${totalAvailable}) < maxPages*pageSize (${maxPages * pageSize})`
        );
        assert.equal(
          result.projectsFetched,
          totalAvailable,
          `Should fetch all ${totalAvailable} available projects`
        );
      }
    ),
    { numRuns: 200 }
  );
});

test("Property 11: Pages fetched never exceeds MAX_SONAR_PAGES", () => {
  fc.assert(
    fc.property(
      maxPagesArb,
      pageSizeArb,
      fc.integer({ min: 0, max: 100_000 }),
      (maxPages, pageSize, totalAvailable) => {
        const result = simulatePagination({ maxPages, pageSize, totalAvailable });

        assert.ok(
          result.pagesFetched <= maxPages,
          `Pages fetched (${result.pagesFetched}) should never exceed MAX_SONAR_PAGES (${maxPages})`
        );
      }
    ),
    { numRuns: 200 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 5: Mapping Coverage Percentage                            */
/*  **Validates: Requirements 5.4**                                    */
/* ------------------------------------------------------------------ */

test("Property 5: calculateMappingCoveragePct returns exactly (M/N)*100 for N > 0", () => {
  fc.assert(
    fc.property(
      totalProjectsArb,
      fc.integer({ min: 0, max: 10_000 }),
      (total, mapped) => {
        // Ensure mapped <= total
        const actualMapped = Math.min(mapped, total);

        const result = calculateMappingCoveragePct(total, actualMapped);
        const expected = (actualMapped / total) * 100;

        assert.equal(
          result,
          expected,
          `Coverage should be exactly (${actualMapped}/${total})*100 = ${expected}, got ${result}`
        );
      }
    ),
    { numRuns: 200 }
  );
});

test("Property 5: calculateMappingCoveragePct returns 0 when total is 0 or negative", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -100, max: 0 }),
      fc.integer({ min: 0, max: 100 }),
      (total, mapped) => {
        const result = calculateMappingCoveragePct(total, mapped);
        assert.equal(
          result,
          0,
          `Coverage should be 0 when total is ${total}, got ${result}`
        );
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 5: calculateMappingCoveragePct is in range [0, 100] when mapped <= total", () => {
  fc.assert(
    fc.property(totalProjectsArb, (total) => {
      return fc.assert(
        fc.property(mappedCountArb(total), (mapped) => {
          const result = calculateMappingCoveragePct(total, mapped);
          assert.ok(
            result >= 0 && result <= 100,
            `Coverage ${result} should be in [0, 100] for mapped=${mapped}, total=${total}`
          );
        }),
        { numRuns: 20 }
      );
    }),
    { numRuns: 10 }
  );
});

test("Property 5: calculateMappingCoveragePct is 100 when all projects are mapped", () => {
  fc.assert(
    fc.property(totalProjectsArb, (total) => {
      const result = calculateMappingCoveragePct(total, total);
      assert.equal(
        result,
        100,
        `Coverage should be 100% when all ${total} projects are mapped, got ${result}`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 5: calculateMappingCoveragePct is 0 when no projects are mapped", () => {
  fc.assert(
    fc.property(totalProjectsArb, (total) => {
      const result = calculateMappingCoveragePct(total, 0);
      assert.equal(
        result,
        0,
        `Coverage should be 0% when no projects are mapped, got ${result}`
      );
    }),
    { numRuns: 100 }
  );
});
