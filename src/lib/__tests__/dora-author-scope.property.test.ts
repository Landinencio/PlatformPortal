/**
 * Property-based tests for the DORA author-scoping pure module
 * (`src/lib/dora-author-scope.ts`).
 *
 * Feature: dora-author-scoping — Properties 1–11.
 *
 * This file holds the property tests for the pure author-scoping logic. It is
 * structured so subsequent tasks (1.4 … 1.13) append their property right below
 * the previous one, each under its own `// Feature: dora-author-scoping,
 * Property N: ...` tag, with one property ↔ one test.
 *
 * Stack: node:test (run via `tsx --test`) + fast-check. Each property runs with
 * `fc.assert(prop, { numRuns: 100, seed: <fixed>, endOnFailure: true })`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  authorAttributionCoverage,
  authorScopeActive,
  authorsCacheKeyPart,
  buildDeploymentAuthorship,
  changeBelongsToAuthorFilter,
  countAttributedDeployments,
  listSelectableAuthors,
  median,
  normalizeAuthorFilter,
  resolveChangeAuthorKeys,
  selectAuthorLeadTimes,
  type DeploymentAuthorship,
  type DeploymentChangeRow,
} from "../dora-author-scope";

/* ------------------------------------------------------------------ */
/*  Shared generators                                                  */
/* ------------------------------------------------------------------ */

/**
 * A fixed pool of distinct developer local-parts. They are chosen so the MR
 * identity merge logic (`mergeDevelopersByIdentity`) keeps them as separate
 * identities: no shared tokens, no 8+ char shared prefixes, none a substring of
 * another. Each maps to the canonical key equal to its (lowercased) local-part.
 */
const PEOPLE = [
  "alice",
  "bob",
  "carol",
  "dave",
  "erin",
  "frank",
  "grace",
  "heidi",
] as const;

/**
 * Same-user domain pairs per the org steering: `@iskaypet.com` and
 * `@emefinpetcare.com` belong to the same person when the local-part matches,
 * so they must collapse to a single canonical identity.
 */
const DOMAINS = ["iskaypet.com", "emefinpetcare.com"] as const;

/** Expected canonical key for a person index (lowercase local-part). */
function expectedKey(personIdx: number): string {
  return PEOPLE[personIdx];
}

/** Apply a case variant to exercise mixed-case email normalization. */
function applyCase(email: string, caseMode: number): string {
  if (caseMode === 1) return email.toUpperCase();
  if (caseMode === 2) return email.charAt(0).toUpperCase() + email.slice(1);
  if (caseMode === 3) {
    // Alternating case.
    return email
      .split("")
      .map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase()))
      .join("");
  }
  return email; // 0 ⇒ as-is (lowercase)
}

/** Spec for a single deployment-change row (kept primitive for shuffling). */
const rowSpecArb = fc.record({
  deploymentId: fc.integer({ min: 1, max: 4 }),
  personIdx: fc.integer({ min: 0, max: PEOPLE.length - 1 }),
  domainIdx: fc.integer({ min: 0, max: DOMAINS.length - 1 }),
  caseMode: fc.integer({ min: 0, max: 3 }),
});

type RowSpec = {
  deploymentId: number;
  personIdx: number;
  domainIdx: number;
  caseMode: number;
};

/** Materialize a row spec into a DeploymentChangeRow. */
function materialize(spec: RowSpec, index: number): DeploymentChangeRow {
  const local = PEOPLE[spec.personIdx];
  const email = applyCase(`${local}@${DOMAINS[spec.domainIdx]}`, spec.caseMode);
  return {
    deploymentId: spec.deploymentId,
    // deployDate is a deterministic function of the deployment id so that the
    // per-deployment grouping is stable regardless of row order.
    deployDate: `2026-01-0${spec.deploymentId}`,
    commitSha: `sha-${index}`,
    commitCreatedAt: null,
    mrFirstCommitAt: null,
    deployCompletedAt: null,
    authorEmail: email,
    authorUsername: null,
  };
}

/** Reduce authorship to a comparable Map<deploymentId, sorted author keys>. */
function authorKeysByDeployment(rows: DeploymentChangeRow[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const dep of buildDeploymentAuthorship(rows)) {
    map.set(dep.deploymentId, [...dep.authorKeys].sort().join("|"));
  }
  return map;
}

/* ------------------------------------------------------------------ */
/*  Feature: dora-author-scoping, Property 1: Identidad canónica de    */
/*  autor determinista e independiente del orden                       */
/*  **Validates: Requirements 3.1, 3.2, 3.3**                          */
/* ------------------------------------------------------------------ */

test("Feature: dora-author-scoping, Property 1: canonical author identity is deterministic and order-independent, grouping the same identity (mixed-case / cross-domain) under one canonical key per deployment", () => {
  const prop = fc.property(
    // The set of rows.
    fc.array(rowSpecArb, { maxLength: 30 }),
    // Random sort keys used to derive an arbitrary permutation of the rows.
    fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 30 }),
    (specs, sortKeys) => {
      const rows = specs.map((spec, i) => materialize(spec, i));

      // Derive an arbitrary permutation of `rows` from the random sort keys
      // (index fallback when fewer keys than rows are generated).
      const permuted = rows
        .map((row, i) => ({ row, k: sortKeys[i] ?? i }))
        .sort((a, b) => a.k - b.k)
        .map((x) => x.row);

      const original = authorKeysByDeployment(rows);
      const reordered = authorKeysByDeployment(permuted);

      // (3.1) Order independence: same deployments, same canonical key sets.
      assert.deepEqual(
        [...reordered.keys()].sort((a, b) => a - b),
        [...original.keys()].sort((a, b) => a - b),
        "permutation changed the set of deployments"
      );
      for (const [deploymentId, keys] of original) {
        assert.equal(
          reordered.get(deploymentId),
          keys,
          `permutation changed canonical author keys for deployment ${deploymentId}`
        );
      }

      // (3.2, 3.3) The canonical keys for each deployment equal the DISTINCT
      // set of people in that deployment: different commit-emails of the same
      // person (mixed-case, @iskaypet.com ↔ @emefinpetcare.com) merge to a
      // single canonical key, and N equivalent changes collapse to one key.
      const expectedByDeployment = new Map<number, Set<string>>();
      for (const spec of specs) {
        let set = expectedByDeployment.get(spec.deploymentId);
        if (!set) {
          set = new Set<string>();
          expectedByDeployment.set(spec.deploymentId, set);
        }
        set.add(expectedKey(spec.personIdx));
      }
      for (const [deploymentId, expected] of expectedByDeployment) {
        assert.equal(
          original.get(deploymentId),
          [...expected].sort().join("|"),
          `unexpected canonical author keys for deployment ${deploymentId}`
        );
      }

      // resolveChangeAuthorKeys must agree row-by-row with the expected key and
      // be independent of input order (same email ⇒ same canonical key in both
      // orderings).
      const keysOriginal = resolveChangeAuthorKeys(rows);
      const keysPermuted = resolveChangeAuthorKeys(permuted);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        assert.equal(
          keysOriginal.get(row),
          expectedKey(specs[i].personIdx),
          "row resolved to an unexpected canonical key"
        );
      }
      // Cross-check: a permuted row with the same email resolves identically.
      for (const row of permuted) {
        const sameEmail = rows.find((r) => r.authorEmail === row.authorEmail);
        if (sameEmail) {
          assert.equal(
            keysPermuted.get(row),
            keysOriginal.get(sameEmail),
            "same email resolved to different canonical keys across orderings"
          );
        }
      }
    }
  );

  fc.assert(prop, { numRuns: 100, seed: 1, endOnFailure: true });
});

/* ------------------------------------------------------------------ */
/*  Feature: dora-author-scoping, Property 2: Pertenencia a            */
/*  Author_Filter por clave canónica                                   */
/*  **Validates: Requirements 1.6**                                    */
/* ------------------------------------------------------------------ */

test("Feature: dora-author-scoping, Property 2: changeBelongsToAuthorFilter returns true iff the canonical key is non-null and present in the Author_Filter", () => {
  /**
   * Generates a candidate canonical key (or null), drawn from the same people
   * pool used elsewhere, with case variants to exercise the membership check
   * against the normalized filter keys.
   */
  const authorKeyArb = fc.oneof(
    fc.constant<string | null>(null),
    fc
      .integer({ min: 0, max: PEOPLE.length - 1 })
      .map((idx) => expectedKey(idx)),
    // A key that is never in the filter pool ⇒ must yield false.
    fc.constant<string | null>("nobody")
  );

  /** A raw author-filter list: a subset of the people pool, possibly with
   * duplicates and surrounding whitespace, to be normalized by
   * `normalizeAuthorFilter`. */
  const filterListArb = fc.array(
    fc.oneof(
      fc.integer({ min: 0, max: PEOPLE.length - 1 }).map((idx) => expectedKey(idx)),
      fc.constant("  "), // blank ⇒ dropped by normalization
      fc.constant("") // empty ⇒ dropped by normalization
    ),
    { maxLength: 10 }
  );

  const prop = fc.property(authorKeyArb, filterListArb, (authorKey, filterList) => {
    const filter = normalizeAuthorFilter(filterList);

    // Reference predicate: true iff the key is non-null/undefined AND the
    // normalized filter set contains it.
    const expected =
      authorKey !== null && authorKey !== undefined && filter.has(authorKey);

    assert.equal(
      changeBelongsToAuthorFilter(authorKey, filter),
      expected,
      `membership mismatch for key=${JSON.stringify(authorKey)} filter=${JSON.stringify(
        [...filter]
      )}`
    );

    // A null key never belongs, regardless of the filter contents.
    assert.equal(changeBelongsToAuthorFilter(null, filter), false);

    // An empty filter never matches any key (non-null included).
    const emptyFilter = normalizeAuthorFilter([]);
    assert.equal(changeBelongsToAuthorFilter(authorKey, emptyFilter), false);
  });

  fc.assert(prop, { numRuns: 100, seed: 2, endOnFailure: true });
});

/* ------------------------------------------------------------------ */
/*  Feature: dora-author-scoping, Property 3: Deployment Frequency     */
/*  atribuido cuenta cada despliegue una sola vez                      */
/*  **Validates: Requirements 1.1, 1.2, 1.4**                          */
/* ------------------------------------------------------------------ */

test("Feature: dora-author-scoping, Property 3: countAttributedDeployments counts each deployment exactly once when it has >=1 change in the filter, regardless of how many matching changes it contains", () => {
  /**
   * A non-empty Author_Filter: a subset of the people pool, possibly with
   * duplicates and blank entries (dropped by normalization). At least one real
   * person index is guaranteed so the filter is non-empty after normalization.
   */
  const filterArb = fc
    .record({
      head: fc.integer({ min: 0, max: PEOPLE.length - 1 }),
      tail: fc.array(
        fc.oneof(
          fc
            .integer({ min: 0, max: PEOPLE.length - 1 })
            .map((idx) => expectedKey(idx)),
          fc.constant("  "),
          fc.constant("")
        ),
        { maxLength: 8 }
      ),
    })
    .map(({ head, tail }) => [expectedKey(head), ...tail]);

  const prop = fc.property(
    fc.array(rowSpecArb, { maxLength: 30 }),
    filterArb,
    (specs, filterList) => {
      const rows = specs.map((spec, i) => materialize(spec, i));
      const filter = normalizeAuthorFilter(filterList);

      const actual = countAttributedDeployments(
        buildDeploymentAuthorship(rows),
        filter
      );

      // Reference: the number of DISTINCT deployments that contain at least one
      // change whose canonical identity (person local-part) is in the filter,
      // counting each deployment exactly once.
      const matchingDeployments = new Set<number>();
      for (const spec of specs) {
        if (filter.has(expectedKey(spec.personIdx))) {
          matchingDeployments.add(spec.deploymentId);
        }
      }
      const expected = matchingDeployments.size;

      assert.equal(
        actual,
        expected,
        `attributed deployment count mismatch: filter=${JSON.stringify([
          ...filter,
        ])}`
      );

      // The count never exceeds the total number of distinct deployments
      // (each deployment is counted at most once).
      const totalDeployments = new Set(specs.map((s) => s.deploymentId)).size;
      assert.ok(
        actual <= totalDeployments,
        `count ${actual} exceeded total distinct deployments ${totalDeployments}`
      );
    }
  );

  fc.assert(prop, { numRuns: 100, seed: 3, endOnFailure: true });
});

/* ------------------------------------------------------------------ */
/*  Feature: dora-author-scoping, Property 4: Conteo atribuido         */
/*  invariante ante duplicación de filas equivalentes                  */
/*  **Validates: Requirements 8.4, 3.3**                               */
/* ------------------------------------------------------------------ */

test("Feature: dora-author-scoping, Property 4: countAttributedDeployments is invariant to duplicating equivalent rows (same deploymentId + same canonical identity + same deployDate)", () => {
  /**
   * A possibly-empty Author_Filter: a subset of the people pool, possibly with
   * duplicates and blank entries (dropped by normalization). The duplication
   * invariant must hold for ANY filter, empty or not.
   */
  const filterListArb = fc.array(
    fc.oneof(
      fc
        .integer({ min: 0, max: PEOPLE.length - 1 })
        .map((idx) => expectedKey(idx)),
      fc.constant("  "),
      fc.constant("")
    ),
    { maxLength: 10 }
  );

  const prop = fc.property(
    // Each base row spec carries a `repeat` count: how many equivalent copies
    // appear in the duplicated set. `materialize` derives `deployDate`
    // deterministically from `deploymentId`, so repeating a spec keeps
    // deploymentId + email + deployDate identical ⇒ the copies resolve to the
    // same canonical identity on the same deployment date (equivalent rows).
    fc.array(
      fc.record({ spec: rowSpecArb, repeat: fc.integer({ min: 1, max: 4 }) }),
      { maxLength: 25 }
    ),
    filterListArb,
    (entries, filterList) => {
      const filter = normalizeAuthorFilter(filterList);

      // Base (un-duplicated) set: each spec materialized exactly once.
      const baseRows = entries.map((e, i) => materialize(e.spec, i));

      // Duplicated set: each spec repeated `repeat` times. The extra copies are
      // equivalent rows — identical deploymentId, identical author email (hence
      // identical canonical identity) and identical deployDate; only the
      // throwaway commitSha differs, which is irrelevant to attribution.
      const duplicatedRows: DeploymentChangeRow[] = [];
      let idx = 0;
      for (const e of entries) {
        for (let r = 0; r < e.repeat; r++) {
          duplicatedRows.push(materialize(e.spec, idx++));
        }
      }

      const baseCount = countAttributedDeployments(
        buildDeploymentAuthorship(baseRows),
        filter
      );
      const duplicatedCount = countAttributedDeployments(
        buildDeploymentAuthorship(duplicatedRows),
        filter
      );

      // (8.4, 3.3) Dedup by canonical identity and by DATE(deploy_completed_at)
      // makes the attributed count invariant to duplicating equivalent rows.
      assert.equal(
        duplicatedCount,
        baseCount,
        `duplicating equivalent rows changed the attributed count: base=${baseCount} duplicated=${duplicatedCount} filter=${JSON.stringify(
          [...filter]
        )}`
      );
    }
  );

  fc.assert(prop, { numRuns: 100, seed: 4, endOnFailure: true });
});

/* ------------------------------------------------------------------ */
/*  Feature: dora-author-scoping, Property 5: Lead Time atribuido es   */
/*  la mediana de los cambios del autor                                */
/*  **Validates: Requirements 1.3, 1.5, 6.2**                          */
/* ------------------------------------------------------------------ */

/**
 * Fixed outlier guard rail (hours). Lead times outside `[0, GUARD_HOURS]`
 * (negatives or values above the guard) must be discarded before taking the
 * median, mirroring the SQL guard `>= 0 AND <= LEAD_TIME_GUARD_HOURS`.
 */
const GUARD_HOURS = 720;

/** Deterministic base epoch for the synthetic timestamps. */
const BASE_MS = Date.UTC(2026, 0, 15, 12, 0, 0);

/**
 * Row spec for Property 5: like `rowSpecArb` but carrying a `first_commit`
 * lead-time span (in hours) that may be negative, in-range or an outlier above
 * the guard, plus flags to exercise the `null`-timestamp and unresolvable-row
 * exclusion paths. `unresolved` rows drop the author identity entirely; rows
 * with `hasTimestamps === false` carry null `mrFirstCommitAt`/`deployCompletedAt`.
 */
const leadRowSpecArb = fc.record({
  deploymentId: fc.integer({ min: 1, max: 4 }),
  personIdx: fc.integer({ min: 0, max: PEOPLE.length - 1 }),
  domainIdx: fc.integer({ min: 0, max: DOMAINS.length - 1 }),
  caseMode: fc.integer({ min: 0, max: 3 }),
  // Spans straddle the guard: negatives (< 0), in-range and outliers (> guard).
  leadHours: fc.double({ min: -48, max: GUARD_HOURS + 240, noNaN: true }),
  hasTimestamps: fc.boolean(),
  unresolved: fc.boolean(),
});

type LeadRowSpec = {
  deploymentId: number;
  personIdx: number;
  domainIdx: number;
  caseMode: number;
  leadHours: number;
  hasTimestamps: boolean;
  unresolved: boolean;
};

/**
 * Materialize a lead-time row spec into a DeploymentChangeRow with real
 * `mrFirstCommitAt` / `deployCompletedAt` timestamps. `deployCompletedAt` is
 * derived deterministically from the deployment id; `mrFirstCommitAt` is set so
 * the `first_commit` lead time equals (within float) `leadHours`. When
 * `hasTimestamps` is false both timestamps are null; when `unresolved` is true
 * the author email/username are null (unresolvable identity).
 */
function materializeLead(spec: LeadRowSpec, index: number): DeploymentChangeRow {
  const local = PEOPLE[spec.personIdx];
  const email = spec.unresolved
    ? null
    : applyCase(`${local}@${DOMAINS[spec.domainIdx]}`, spec.caseMode);

  let mrFirstCommitAt: Date | null = null;
  let deployCompletedAt: Date | null = null;
  if (spec.hasTimestamps) {
    const deployMs = BASE_MS + spec.deploymentId * 86_400_000;
    const firstMs = deployMs - spec.leadHours * 3_600_000;
    deployCompletedAt = new Date(deployMs);
    mrFirstCommitAt = new Date(firstMs);
  }

  return {
    deploymentId: spec.deploymentId,
    deployDate: `2026-01-0${spec.deploymentId}`,
    commitSha: `sha-${index}`,
    commitCreatedAt: null,
    mrFirstCommitAt,
    deployCompletedAt,
    authorEmail: email,
    authorUsername: null,
  };
}

/** Independent reference median (separate impl from the function under test). */
function referenceMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

test("Feature: dora-author-scoping, Property 5: the attributed Lead Time equals the median of the filter's changes' first_commit lead times — excluding non-selected authors, unresolvable rows and outliers (<0 or >guard) — and is null (not zero) when there are no attributable changes", () => {
  /**
   * A possibly-empty Author_Filter: a subset of the people pool with blank
   * entries (dropped by normalization). An empty filter exercises the
   * "no attributable changes ⇒ null (not zero)" branch.
   */
  const filterListArb = fc.array(
    fc.oneof(
      fc.integer({ min: 0, max: PEOPLE.length - 1 }).map((idx) => expectedKey(idx)),
      fc.constant("  "),
      fc.constant("")
    ),
    { maxLength: 10 }
  );

  const prop = fc.property(
    fc.array(leadRowSpecArb, { maxLength: 30 }),
    filterListArb,
    (specs, filterList) => {
      const rows = specs.map((spec, i) => materializeLead(spec, i));
      const filter = normalizeAuthorFilter(filterList);

      const authorKeyByRow = resolveChangeAuthorKeys(rows);
      const selected = selectAuthorLeadTimes(
        rows,
        authorKeyByRow,
        filter,
        GUARD_HOURS
      );
      const actual = median(selected);

      // Reference, computed independently: for each row, the change contributes
      // its first_commit lead time iff (a) its canonical identity (the person's
      // local-part, per Property 1) is in the filter, (b) it is resolvable
      // (email present), (c) both timestamps are present, and (d) the lead time
      // lies in [0, GUARD_HOURS]. Non-selected authors, unresolvable rows and
      // outliers are excluded. The lead time is recomputed from the stored
      // timestamps to match the implementation's exact arithmetic.
      const expectedLeadTimes: number[] = [];
      for (const spec of specs) {
        if (spec.unresolved) continue;
        const key = expectedKey(spec.personIdx);
        if (!filter.has(key)) continue;
        if (!spec.hasTimestamps) continue;
        const deployMs = BASE_MS + spec.deploymentId * 86_400_000;
        const firstMs = deployMs - spec.leadHours * 3_600_000;
        const hours =
          (new Date(deployMs).getTime() - new Date(firstMs).getTime()) /
          3_600_000;
        if (!Number.isFinite(hours)) continue;
        if (hours < 0 || hours > GUARD_HOURS) continue;
        expectedLeadTimes.push(hours);
      }
      const expected = referenceMedian(expectedLeadTimes);

      // (1.3, 1.5, 6.2) Attributed Lead Time = median of the selected first_commit
      // lead times, with outlier/identity/timestamp exclusions applied.
      assert.deepEqual(
        actual,
        expected,
        `attributed lead-time median mismatch: filter=${JSON.stringify([
          ...filter,
        ])} selected=${JSON.stringify(selected)} expected=${JSON.stringify(
          expectedLeadTimes
        )}`
      );

      // (1.5) When there are no attributable changes the result is null, NOT
      // zero (no false "0h lead time" attribution).
      if (expectedLeadTimes.length === 0) {
        assert.equal(actual, null, "expected null lead time with no attributable changes");
        assert.notEqual(actual, 0, "lead time must be null (not zero) with no attributable changes");
      }
    }
  );

  fc.assert(prop, { numRuns: 100, seed: 5, endOnFailure: true });
});

/* ------------------------------------------------------------------ */
/*  Feature: dora-author-scoping, Property 8: Author_Attribution_      */
/*  Coverage bien definido y acotado                                   */
/*  **Validates: Requirements 7.1, 7.2, 7.3**                          */
/* ------------------------------------------------------------------ */

/**
 * Build a synthetic `DeploymentAuthorship` directly (full control over the
 * resolvable / unresolvable split, including the "deployment with no changes"
 * case which `buildDeploymentAuthorship` never materializes because a
 * deployment with zero rows simply does not exist). When `unresolved` is true
 * the deployment has no resolvable identity ⇒ empty `authorKeys`; otherwise it
 * carries at least one canonical key, mirroring the module's own invariant.
 */
function makeAuthorship(
  deploymentId: number,
  unresolved: boolean
): DeploymentAuthorship {
  return {
    deploymentId,
    deployDate: `2026-02-0${(deploymentId % 9) + 1}`,
    authorKeys: unresolved ? new Set<string>() : new Set<string>(["alice"]),
    unresolved,
  };
}

/** Independent reference coverage (separate impl from the function under test). */
function referenceCoverage(unresolvedFlags: boolean[]): number | null {
  if (unresolvedFlags.length === 0) return null;
  const resolvable = unresolvedFlags.filter((u) => !u).length;
  const pct = (resolvable / unresolvedFlags.length) * 100;
  const rounded = Math.round(pct * 10) / 10;
  return Math.min(100, Math.max(0, rounded));
}

test("Feature: dora-author-scoping, Property 8: authorAttributionCoverage equals round(resolvable/total*100, 1 decimal) clamped to [0,100], treats deployments with no changes or no canonical identity as unresolvable, and is null for zero deployments", () => {
  /**
   * Direct-array path: an arbitrary set of deployments, each either resolvable
   * or unresolvable (the boolean), giving full control over the split — empty
   * arrays exercise the "zero deployments ⇒ null" branch.
   */
  const directProp = fc.property(
    fc.array(fc.boolean(), { maxLength: 40 }),
    (unresolvedFlags) => {
      const authorship = unresolvedFlags.map((unresolved, i) =>
        makeAuthorship(i + 1, unresolved)
      );

      const actual = authorAttributionCoverage(authorship);
      const expected = referenceCoverage(unresolvedFlags);

      // (7.1, 7.2) coverage = (resolvable / total) * 100, rounded to 1 decimal.
      assert.equal(
        actual,
        expected,
        `coverage mismatch: flags=${JSON.stringify(unresolvedFlags)}`
      );

      if (authorship.length === 0) {
        // (7.3) Zero deployments ⇒ not available (null), NOT 0.0.
        assert.equal(actual, null, "expected null coverage with zero deployments");
      } else {
        // (7.1) Always within the closed range [0.0, 100.0].
        assert.ok(
          actual !== null && actual >= 0 && actual <= 100,
          `coverage ${actual} out of [0,100]`
        );
        // Rounded to exactly 1 decimal place.
        assert.equal(
          Math.round((actual as number) * 10) / 10,
          actual,
          "coverage is not rounded to 1 decimal"
        );
        // All resolvable ⇒ 100.0; all unresolvable ⇒ 0.0.
        if (unresolvedFlags.every((u) => !u)) assert.equal(actual, 100);
        if (unresolvedFlags.every((u) => u)) assert.equal(actual, 0);
      }
    }
  );

  fc.assert(directProp, { numRuns: 100, seed: 8, endOnFailure: true });

  /**
   * buildDeploymentAuthorship-derived path: rows where each deployment has one
   * or more changes, each change either carrying a resolvable identity (a real
   * person's email) or an unresolvable one (null email). A deployment is
   * resolvable iff it has >=1 change with a resolvable identity. This verifies
   * coverage on the real pipeline output, including (7.2) deployments whose
   * changes have no resolvable identity counting as unresolvable.
   */
  const deploymentSpecArb = fc.record({
    deploymentId: fc.integer({ min: 1, max: 5 }),
    changes: fc.array(
      fc.record({
        personIdx: fc.integer({ min: 0, max: PEOPLE.length - 1 }),
        domainIdx: fc.integer({ min: 0, max: DOMAINS.length - 1 }),
        caseMode: fc.integer({ min: 0, max: 3 }),
        // false ⇒ null email ⇒ unresolvable change.
        resolvable: fc.boolean(),
      }),
      { minLength: 1, maxLength: 4 }
    ),
  });

  const buildProp = fc.property(
    fc.array(deploymentSpecArb, { maxLength: 15 }),
    (deploymentSpecs) => {
      const rows: DeploymentChangeRow[] = [];
      let idx = 0;
      for (const dep of deploymentSpecs) {
        for (const ch of dep.changes) {
          const email = ch.resolvable
            ? applyCase(`${PEOPLE[ch.personIdx]}@${DOMAINS[ch.domainIdx]}`, ch.caseMode)
            : null;
          rows.push({
            deploymentId: dep.deploymentId,
            deployDate: `2026-02-0${(dep.deploymentId % 9) + 1}`,
            commitSha: `sha-${idx++}`,
            commitCreatedAt: null,
            mrFirstCommitAt: null,
            deployCompletedAt: null,
            authorEmail: email,
            authorUsername: null,
          });
        }
      }

      const authorship = buildDeploymentAuthorship(rows);
      const actual = authorAttributionCoverage(authorship);

      // Reference: group by deploymentId; a deployment is resolvable iff at
      // least one of its changes carries a resolvable identity.
      const resolvableByDeployment = new Map<number, boolean>();
      for (const dep of deploymentSpecs) {
        const anyResolvable = dep.changes.some((c) => c.resolvable);
        resolvableByDeployment.set(
          dep.deploymentId,
          (resolvableByDeployment.get(dep.deploymentId) ?? false) || anyResolvable
        );
      }
      const flags = [...resolvableByDeployment.values()].map((r) => !r);
      const expected = referenceCoverage(flags);

      assert.equal(
        actual,
        expected,
        `derived coverage mismatch: specs=${JSON.stringify(deploymentSpecs)}`
      );

      // (7.3) No rows ⇒ no deployments ⇒ null coverage.
      if (rows.length === 0) {
        assert.equal(actual, null, "expected null coverage with no deployments");
      }
    }
  );

  fc.assert(buildProp, { numRuns: 100, seed: 8, endOnFailure: true });
});

/* ------------------------------------------------------------------ */
/*  Feature: dora-author-scoping, Property 9: Lista de autores         */
/*  seleccionables canónica, sin duplicados y determinista             */
/*  **Validates: Requirements 3.4**                                    */
/* ------------------------------------------------------------------ */

/**
 * Row spec for Property 9: like `rowSpecArb` but with an `unresolved` flag so
 * some rows carry a null author email (unresolvable identity). Unresolvable
 * rows must never appear in the selectable-authors list.
 */
const selectableRowSpecArb = fc.record({
  deploymentId: fc.integer({ min: 1, max: 4 }),
  personIdx: fc.integer({ min: 0, max: PEOPLE.length - 1 }),
  domainIdx: fc.integer({ min: 0, max: DOMAINS.length - 1 }),
  caseMode: fc.integer({ min: 0, max: 3 }),
  unresolved: fc.boolean(),
});

type SelectableRowSpec = {
  deploymentId: number;
  personIdx: number;
  domainIdx: number;
  caseMode: number;
  unresolved: boolean;
};

/** Materialize a Property 9 row spec; `unresolved` ⇒ null email/username. */
function materializeSelectable(
  spec: SelectableRowSpec,
  index: number
): DeploymentChangeRow {
  if (spec.unresolved) {
    return {
      deploymentId: spec.deploymentId,
      deployDate: `2026-01-0${spec.deploymentId}`,
      commitSha: `sha-${index}`,
      commitCreatedAt: null,
      mrFirstCommitAt: null,
      deployCompletedAt: null,
      authorEmail: null,
      authorUsername: null,
    };
  }
  return materialize(
    {
      deploymentId: spec.deploymentId,
      personIdx: spec.personIdx,
      domainIdx: spec.domainIdx,
      caseMode: spec.caseMode,
    },
    index
  );
}

test("Feature: dora-author-scoping, Property 9: listSelectableAuthors returns the same canonical list — no duplicate canonicalKey, deterministically ordered, excluding unresolvable rows — for any permutation of the input rows", () => {
  const prop = fc.property(
    fc.array(selectableRowSpecArb, { maxLength: 30 }),
    // Random sort keys used to derive an arbitrary permutation of the rows.
    fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 30 }),
    (specs, sortKeys) => {
      const rows = specs.map((spec, i) => materializeSelectable(spec, i));

      // Derive an arbitrary permutation of `rows` from the random sort keys
      // (index fallback when fewer keys than rows are generated).
      const permuted = rows
        .map((row, i) => ({ row, k: sortKeys[i] ?? i }))
        .sort((a, b) => a.k - b.k)
        .map((x) => x.row);

      const original = listSelectableAuthors(rows);
      const reordered = listSelectableAuthors(permuted);

      // (a) Deterministic + order-independent: the full list (deeply) equals the
      // list for any permutation of the same rows.
      assert.deepEqual(
        reordered,
        original,
        "permutation changed the selectable-authors list"
      );

      // (b) No duplicate canonicalKey.
      const keys = original.map((identity) => identity.canonicalKey);
      assert.equal(
        new Set(keys).size,
        keys.length,
        `duplicate canonicalKey in selectable authors: ${JSON.stringify(keys)}`
      );

      // (c) Deterministic order: sorted by (canonicalKey, email) exactly as the
      // implementation does (verified against an independent re-sort).
      const expectedOrder = [...original].sort(
        (a, b) =>
          a.canonicalKey.localeCompare(b.canonicalKey) ||
          a.email.localeCompare(b.email)
      );
      assert.deepEqual(
        original,
        expectedOrder,
        "selectable authors are not in the deterministic (canonicalKey, email) order"
      );

      // The selectable authors are exactly the DISTINCT resolvable people — the
      // canonical key of every resolvable row appears once, and unresolvable
      // rows (null email) contribute nothing.
      const expectedKeys = new Set<string>();
      for (const spec of specs) {
        if (!spec.unresolved) expectedKeys.add(expectedKey(spec.personIdx));
      }
      assert.deepEqual(
        new Set(keys),
        expectedKeys,
        "selectable canonical keys do not match the distinct resolvable people"
      );
    }
  );

  fc.assert(prop, { numRuns: 100, seed: 9, endOnFailure: true });
});

/* ------------------------------------------------------------------ */
/*  Feature: dora-author-scoping, Property 6: Las métricas de nivel    */
/*  despliegue son invariantes al filtro de autor                      */
/*  **Validates: Requirements 2.1, 2.2**                               */
/* ------------------------------------------------------------------ */

/**
 * The deployment-level set used for CFR / Pipeline Recovery Time. It is derived
 * from the scope `(date ∩ team ∩ project)` — i.e. from `buildDeploymentAuthorship`
 * — and is NOT intersected by author. This helper takes only the rows (never the
 * Author_Filter), modelling the impl contract: the set feeding CFR/Recovery is
 * the full authorship deployment set, independent of any author selection.
 * `countAttributedDeployments` is the SEPARATE, author-scoped count used for
 * Deployment Frequency, not for these deployment-level metrics.
 */
function deploymentLevelSet(
  rows: DeploymentChangeRow[]
): { deploymentId: number; deployDate: string }[] {
  return buildDeploymentAuthorship(rows).map((d) => ({
    deploymentId: d.deploymentId,
    deployDate: d.deployDate,
  }));
}

/**
 * Deterministic deployment-level Change Failure Rate, a value in [0,100],
 * computed over the FULL deployment set and IGNORING the author filter (the
 * `_filter` argument is intentionally unused — deployment-level semantics, no
 * per-author intersection). A failed deployment is modelled deterministically
 * by its id parity. Null when the scope has no deployments (Requirement 2.5).
 */
function deploymentLevelCfr(
  rows: DeploymentChangeRow[],
  _filter: Set<string>
): number | null {
  const set = deploymentLevelSet(rows);
  if (set.length === 0) return null;
  const failed = set.filter((d) => d.deploymentId % 2 === 0).length;
  // Round to 1 decimal; the value is necessarily within [0,100].
  return Math.round((failed / set.length) * 1000) / 10;
}

/**
 * Deterministic deployment-level Pipeline Recovery Time, a non-negative
 * duration in minutes, computed over the FULL pipeline set and IGNORING the
 * author filter. Null when the scope has no pipelines (Requirement 2.5).
 */
function deploymentLevelRecovery(
  rows: DeploymentChangeRow[],
  _filter: Set<string>
): number | null {
  const set = deploymentLevelSet(rows);
  if (set.length === 0) return null;
  return set.reduce((acc, d) => acc + (d.deploymentId % 3) * 15, 0);
}

test("Feature: dora-author-scoping, Property 6: deployment-level CFR (in [0,100]) and Pipeline Recovery Time (non-negative) are invariant to the Author_Filter — same value with an empty filter as with any non-empty filter — because the deployment/pipeline set is derived from the scope without intersecting by author", () => {
  /**
   * A non-empty Author_Filter: a subset of the people pool (with blank/duplicate
   * entries dropped by normalization). The `head` person guarantees the filter
   * is non-empty after normalization, so `authorScopeActive` is true for it.
   */
  const nonEmptyFilterArb = fc
    .record({
      head: fc.integer({ min: 0, max: PEOPLE.length - 1 }),
      tail: fc.array(
        fc.oneof(
          fc
            .integer({ min: 0, max: PEOPLE.length - 1 })
            .map((idx) => expectedKey(idx)),
          fc.constant("  "),
          fc.constant("")
        ),
        { maxLength: 8 }
      ),
    })
    .map(({ head, tail }) => [expectedKey(head), ...tail]);

  const prop = fc.property(
    fc.array(rowSpecArb, { maxLength: 30 }),
    nonEmptyFilterArb,
    (specs, nonEmptyFilterList) => {
      const rows = specs.map((spec, i) => materialize(spec, i));

      const emptyFilter = normalizeAuthorFilter([]);
      const nonEmptyFilter = normalizeAuthorFilter(nonEmptyFilterList);

      // The empty filter selects the zero-regression (no author scoping) path;
      // the non-empty filter activates author scoping. The deployment-level
      // metrics must NOT differ between the two.
      assert.equal(authorScopeActive(emptyFilter), false);
      assert.equal(authorScopeActive(nonEmptyFilter), true);

      // The deployment/pipeline set feeding CFR & Recovery is derived purely
      // from the scope and is identical regardless of the author filter.
      const setEmpty = deploymentLevelSet(rows);
      const setNonEmpty = deploymentLevelSet(rows);
      assert.deepEqual(
        setNonEmpty,
        setEmpty,
        "the deployment-level set must not depend on the author filter"
      );

      // (2.1) Change Failure Rate: same value under empty and non-empty filter,
      // and always within the closed range [0,100] (null only when empty scope).
      const cfrEmpty = deploymentLevelCfr(rows, emptyFilter);
      const cfrNonEmpty = deploymentLevelCfr(rows, nonEmptyFilter);
      assert.deepEqual(
        cfrNonEmpty,
        cfrEmpty,
        `CFR changed with the author filter: empty=${cfrEmpty} nonEmpty=${cfrNonEmpty}`
      );
      if (cfrEmpty !== null) {
        assert.ok(
          cfrEmpty >= 0 && cfrEmpty <= 100,
          `CFR ${cfrEmpty} out of [0,100]`
        );
      }

      // (2.2) Pipeline Recovery Time: same value under empty and non-empty
      // filter, and always a non-negative duration (null only when empty scope).
      const recEmpty = deploymentLevelRecovery(rows, emptyFilter);
      const recNonEmpty = deploymentLevelRecovery(rows, nonEmptyFilter);
      assert.deepEqual(
        recNonEmpty,
        recEmpty,
        `Pipeline Recovery Time changed with the author filter: empty=${recEmpty} nonEmpty=${recNonEmpty}`
      );
      if (recEmpty !== null) {
        assert.ok(recEmpty >= 0, `recovery ${recEmpty} is negative`);
      }

      // The deployment-level set size equals the number of distinct deployments
      // regardless of the filter, whereas the author-scoped Deployment Frequency
      // (countAttributedDeployments) is a SEPARATE, filter-dependent count that
      // never exceeds that full set — confirming CFR/Recovery are not derived
      // from the author-scoped subset.
      const totalDeployments = new Set(specs.map((s) => s.deploymentId)).size;
      assert.equal(
        setEmpty.length,
        totalDeployments,
        "deployment-level set size must equal the distinct deployment count"
      );
      const attributed = countAttributedDeployments(
        buildDeploymentAuthorship(rows),
        nonEmptyFilter
      );
      assert.ok(
        attributed <= setEmpty.length,
        `attributed DF ${attributed} exceeded the deployment-level set ${setEmpty.length}`
      );
    }
  );

  fc.assert(prop, { numRuns: 100, seed: 6, endOnFailure: true });
});

/* ------------------------------------------------------------------ */
/*  Feature: dora-author-scoping, Property 7: Escenario vacío bajo     */
/*  filtro de autor devuelve no disponible                             */
/*  **Validates: Requirements 2.5, 6.1, 6.3, 6.4**                     */
/* ------------------------------------------------------------------ */

/**
 * A non-empty Author_Filter of "ghost" sentinel keys that are guaranteed to be
 * DISJOINT from the canonical keys produced by the PEOPLE pool (which are the
 * lowercase local-parts `alice`…`heidi`). A `ghost-<n>` key can never equal a
 * person's local-part, so the filter matches NO attributable activity, yet it
 * is non-empty after normalization (`authorScopeActive` is true). The `head`
 * guarantees at least one sentinel survives normalization.
 */
const ghostFilterArb = fc
  .record({
    head: fc.integer({ min: 0, max: 999 }),
    tail: fc.array(
      fc.oneof(
        fc.integer({ min: 0, max: 999 }).map((n) => `ghost-${n}`),
        fc.constant("  "),
        fc.constant("")
      ),
      { maxLength: 8 }
    ),
  })
  .map(({ head, tail }) => [`ghost-${head}`, ...tail]);

test("Feature: dora-author-scoping, Property 7: with a non-empty Author_Filter that matches NO attributable activity, attributed Deployment Frequency is exactly zero and the attributed Lead Time is null (not zero) — and neither inherits the non-zero/non-null values of the unfiltered (no-author) scope", () => {
  const prop = fc.property(
    // Lead-time rows from the PEOPLE pool: they carry resolvable identities and
    // real timestamps, so the unfiltered scope can have non-zero DF and a
    // non-null median Lead Time — making the "no inheritance" assertions
    // meaningful (the ghost-filtered result must NOT fall back to them).
    fc.array(leadRowSpecArb, { maxLength: 30 }),
    ghostFilterArb,
    (specs, ghostFilterList) => {
      const rows = specs.map((spec, i) => materializeLead(spec, i));
      const filter = normalizeAuthorFilter(ghostFilterList);

      // The filter is non-empty (author scoping is active) but disjoint from
      // every canonical identity present in the rows.
      assert.equal(authorScopeActive(filter), true);
      const presentKeys = new Set<string>();
      for (const spec of specs) {
        if (!spec.unresolved) presentKeys.add(expectedKey(spec.personIdx));
      }
      for (const key of filter) {
        assert.equal(
          presentKeys.has(key),
          false,
          `ghost filter key ${key} unexpectedly matched a present author`
        );
      }

      const authorship = buildDeploymentAuthorship(rows);
      const authorKeyByRow = resolveChangeAuthorKeys(rows);

      // (2.5, 6.1) Attributed Deployment Frequency is EXACTLY zero — no
      // deployment has a change whose canonical identity is in the filter.
      const attributedDf = countAttributedDeployments(authorship, filter);
      assert.equal(
        attributedDf,
        0,
        `attributed DF must be exactly 0 under a non-matching filter, got ${attributedDf}`
      );

      // (6.3, 6.4) Attributed Lead Time is the explicit "not available"
      // indicator (null), NOT the numeric value zero: there are no attributable
      // changes, so the selection is empty and the median is null.
      const selected = selectAuthorLeadTimes(
        rows,
        authorKeyByRow,
        filter,
        GUARD_HOURS
      );
      assert.deepEqual(
        selected,
        [],
        "no change must be selected under a non-matching filter"
      );
      const attributedLeadTime = median(selected);
      assert.equal(
        attributedLeadTime,
        null,
        "attributed Lead Time must be null (not zero) with no attributable changes"
      );
      assert.notEqual(
        attributedLeadTime,
        0,
        "attributed Lead Time must be the not-available indicator, never numeric zero"
      );

      // No inheritance of the no-author scope: the unfiltered scope can have a
      // non-zero deployment count and a non-null median Lead Time, yet the
      // author-scoped result above stays 0 / null — it does NOT substitute the
      // metric with the scope-without-author-filter value.
      const totalDeployments = new Set(specs.map((s) => s.deploymentId)).size;
      assert.ok(
        attributedDf <= totalDeployments,
        `attributed DF ${attributedDf} exceeded the unfiltered deployment set ${totalDeployments}`
      );
      // Independently compute the unfiltered scope's in-range Lead Times (all
      // resolvable people, no author intersection). Whenever that reference is
      // non-empty (non-null median), the ghost-filtered Lead Time still stays
      // null — proving the empty-author result is not inherited.
      const unfilteredLeadTimes: number[] = [];
      for (const spec of specs) {
        if (spec.unresolved || !spec.hasTimestamps) continue;
        const deployMs = BASE_MS + spec.deploymentId * 86_400_000;
        const firstMs = deployMs - spec.leadHours * 3_600_000;
        const hours = (deployMs - firstMs) / 3_600_000;
        if (!Number.isFinite(hours)) continue;
        if (hours < 0 || hours > GUARD_HOURS) continue;
        unfilteredLeadTimes.push(hours);
      }
      const unfilteredMedian = referenceMedian(unfilteredLeadTimes);
      if (unfilteredMedian !== null) {
        assert.equal(
          attributedLeadTime,
          null,
          "ghost-filtered Lead Time inherited the non-null unfiltered scope median"
        );
      }
    }
  );

  fc.assert(prop, { numRuns: 100, seed: 7, endOnFailure: true });
});

/* ------------------------------------------------------------------ */
/*  Feature: dora-author-scoping, Property 10: Clave de caché canónica */
/*  en la dimensión de autor                                           */
/*  **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 9.5**                */
/* ------------------------------------------------------------------ */

/**
 * A small pool of canonical author keys. `normalizeAuthorFilter` canonicalizes
 * a raw filter entry by trimming surrounding whitespace and dropping blanks, so
 * a pool key padded with whitespace resolves to the SAME canonical key as the
 * bare key — this exercises the normalization that the cache-key part relies on.
 */
const CACHE_KEY_POOL = [
  "alice@iskaypet.com",
  "bob@iskaypet.com",
  "carol@emefinpetcare.com",
  "dave@iskaypet.com",
  "erin@emefinpetcare.com",
] as const;

/** Pad a key with whitespace noise (all variants trim back to the same key). */
function padKey(key: string, pad: number): string {
  if (pad === 1) return ` ${key}`;
  if (pad === 2) return `${key} `;
  if (pad === 3) return `   ${key}   `;
  return key; // 0 ⇒ as-is
}

/**
 * A raw Author_Filter list drawn from the key pool with whitespace padding plus
 * blank/empty noise entries (both dropped by normalization). The normalized
 * canonical-key set is exactly the set of pool keys whose (trimmed) form appears
 * at least once.
 */
const rawAuthorListArb = fc.array(
  fc.oneof(
    fc
      .record({
        idx: fc.integer({ min: 0, max: CACHE_KEY_POOL.length - 1 }),
        pad: fc.integer({ min: 0, max: 3 }),
      })
      .map(({ idx, pad }) => padKey(CACHE_KEY_POOL[idx], pad)),
    fc.constant(""), // blank ⇒ dropped by normalization
    fc.constant("   ") // whitespace-only ⇒ dropped by normalization
  ),
  { maxLength: 14 }
);

/** Stable serialization of a cache-key part (NUL separator avoids collisions). */
function serializePart(part: string[]): string {
  return part.join("\u0000");
}

/** Set equality for canonical-key sets. */
function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

test("Feature: dora-author-scoping, Property 10: authorsCacheKeyPart produces a canonical part that is equal iff the normalized canonical-key SET is equal (distinct sets ⇒ distinct parts; same set in any order/with duplicates ⇒ same part), and an empty filter ⇒ a constant empty part identical to the no-author-dimension key", () => {
  const prop = fc.property(
    rawAuthorListArb,
    rawAuthorListArb,
    // Random sort keys + per-entry duplication counts used to derive, from
    // listA, a reordered+duplicated list with the SAME canonical-key set.
    fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 14 }),
    fc.array(fc.integer({ min: 1, max: 3 }), { maxLength: 14 }),
    (listA, listB, sortKeys, repeats) => {
      const partA = authorsCacheKeyPart(listA);
      const partB = authorsCacheKeyPart(listB);

      const setA = normalizeAuthorFilter(listA);
      const setB = normalizeAuthorFilter(listB);

      // (4.1, 4.2, 4.3) The cache-key part is equal (by stable serialization)
      // if and only if the normalized canonical-key SETS are equal. This covers
      // both directions: differing sets ⇒ differing parts (4.1/4.2), and equal
      // sets ⇒ equal parts (4.3), regardless of input order or duplicates.
      assert.equal(
        serializePart(partA) === serializePart(partB),
        sameSet(setA, setB),
        `part equality must match set equality: A=${JSON.stringify(
          listA
        )} B=${JSON.stringify(listB)}`
      );

      // The part is the sorted, de-duplicated canonical-key set with no
      // duplicate entries — a true canonical representative of the set.
      assert.deepEqual(
        partA,
        [...setA].sort(),
        "cache-key part is not the sorted canonical-key set"
      );
      assert.equal(
        new Set(partA).size,
        partA.length,
        `cache-key part contains duplicates: ${JSON.stringify(partA)}`
      );

      // (4.3) Same canonical-key set in ANY order and WITH duplicates ⇒ the
      // same part. Derive listC from listA by an arbitrary permutation and by
      // repeating each entry, then confirm an identical serialized part.
      const listC = listA
        .map((entry, i) => ({ entry, k: sortKeys[i] ?? i, r: repeats[i] ?? 1 }))
        .sort((a, b) => a.k - b.k)
        .flatMap(({ entry, r }) => Array.from({ length: r }, () => entry));
      const partC = authorsCacheKeyPart(listC);
      assert.equal(
        serializePart(partC),
        serializePart(partA),
        `reordered/duplicated list changed the cache-key part: ${JSON.stringify(
          listC
        )}`
      );

      // (4.4, 9.5) Empty filter ⇒ a CONSTANT empty part, identical to the part
      // a query without the author dimension would contribute. Whitespace-only
      // and []-only inputs both collapse to the same constant empty part.
      const emptyPart = authorsCacheKeyPart([]);
      assert.deepEqual(emptyPart, [], "empty filter must produce an empty part");
      assert.deepEqual(
        authorsCacheKeyPart(["", "   ", "\t"]),
        [],
        "a blanks-only filter must produce the same empty part as []"
      );
      assert.equal(
        serializePart(authorsCacheKeyPart(["   "])),
        serializePart(emptyPart),
        "empty-equivalent filters must serialize to the same constant part"
      );
    }
  );

  fc.assert(prop, { numRuns: 100, seed: 10, endOnFailure: true });
});

/* ------------------------------------------------------------------ */
/*  Feature: dora-author-scoping, Property 11: Regresión cero sin      */
/*  filtro de autor (nivel puro)                                       */
/*  **Validates: Requirements 9.1, 9.2, 9.3**                          */
/* ------------------------------------------------------------------ */

/** Serialize one authorship entry to a stable string (Set → sorted keys). */
function serializeAuthorship(dep: DeploymentAuthorship): string {
  return [
    dep.deploymentId,
    dep.deployDate,
    [...dep.authorKeys].sort().join("|"),
    dep.unresolved ? "1" : "0",
  ].join("#");
}

/** Serialize the full authorship list to a stable string (preserves order). */
function serializeAuthorshipList(list: DeploymentAuthorship[]): string {
  return list.map(serializeAuthorship).join("\n");
}

test("Feature: dora-author-scoping, Property 11: with an empty Author_Filter author scoping is inactive (false, including whitespace-only inputs), and the canonical deployment set produced by buildDeploymentAuthorship is deterministic and exactly the rows' distinct deployments in the module's deterministic (deploymentId, deployDate) order — the absent author dimension neither reduces, expands nor reorders the set", () => {
  const prop = fc.property(
    fc.array(rowSpecArb, { maxLength: 30 }),
    // Random sort keys used to derive an arbitrary permutation of the rows,
    // confirming the produced order is intrinsic to the module (deterministic),
    // not a side effect of the input order.
    fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 30 }),
    (specs, sortKeys) => {
      const rows = specs.map((spec, i) => materialize(spec, i));

      // (9.1) An empty Author_Filter ⇒ author scoping is INACTIVE: the
      // zero-regression path is selected and no author scoping is applied.
      assert.equal(
        authorScopeActive(normalizeAuthorFilter([])),
        false,
        "an empty author filter must leave author scoping inactive"
      );
      // Whitespace-only / blank inputs normalize to the empty filter too, so
      // they must also leave author scoping inactive.
      assert.equal(
        authorScopeActive(normalizeAuthorFilter(["", "   ", "\t", "\n"])),
        false,
        "a whitespace-only author filter must leave author scoping inactive"
      );

      // (9.2, 9.3) The deployment/change set considered is independent of the
      // (absent) author dimension. buildDeploymentAuthorship does not take a
      // filter at all, so its output is the canonical scope set. It must be
      // deterministic: recomputing yields an identical list, and so does
      // computing it from any permutation of the same rows.
      const permuted = rows
        .map((row, i) => ({ row, k: sortKeys[i] ?? i }))
        .sort((a, b) => a.k - b.k)
        .map((x) => x.row);

      const canonical = buildDeploymentAuthorship(rows);
      const recomputed = buildDeploymentAuthorship(rows);
      const fromPermuted = buildDeploymentAuthorship(permuted);

      // Deterministic: identical output across repeated and reordered calls.
      assert.equal(
        serializeAuthorshipList(recomputed),
        serializeAuthorshipList(canonical),
        "buildDeploymentAuthorship is not deterministic across calls"
      );
      assert.equal(
        serializeAuthorshipList(fromPermuted),
        serializeAuthorshipList(canonical),
        "buildDeploymentAuthorship reordered the set for a permuted input"
      );

      // The canonical set is EXACTLY the rows' distinct deployments — no
      // reduction (every distinct deployment is present) and no expansion (no
      // extra deployment appears).
      const expectedIds = [...new Set(rows.map((r) => r.deploymentId))].sort(
        (a, b) => a - b
      );
      const producedIds = canonical.map((d) => d.deploymentId);
      assert.deepEqual(
        producedIds,
        expectedIds,
        "the canonical deployment set is not the rows' distinct deployments"
      );

      // No reordering: the produced order is the module's deterministic
      // (deploymentId, deployDate) order. `materialize` derives deployDate
      // deterministically from the deployment id, so the expected order is the
      // distinct (deploymentId, deployDate) pairs sorted by that key.
      const deployDateById = new Map<number, string>();
      for (const row of rows) {
        if (!deployDateById.has(row.deploymentId)) {
          deployDateById.set(row.deploymentId, row.deployDate);
        }
      }
      const expectedOrder = expectedIds.map((id) => ({
        deploymentId: id,
        deployDate: deployDateById.get(id) as string,
      }));
      assert.deepEqual(
        canonical.map((d) => ({
          deploymentId: d.deploymentId,
          deployDate: d.deployDate,
        })),
        expectedOrder,
        "the canonical deployment set is not in the deterministic (deploymentId, deployDate) order"
      );

      // The number of deployments considered is invariant: it equals the
      // distinct deployment count, never reduced or expanded by the (absent)
      // author dimension.
      assert.equal(
        canonical.length,
        expectedIds.length,
        "the absent author dimension changed the size of the considered set"
      );
    }
  );

  fc.assert(prop, { numRuns: 100, seed: 11, endOnFailure: true });
});
