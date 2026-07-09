/**
 * Property + example tests for canonical MR-metrics aggregation.
 *
 * Core invariant (the recurring "108 vs 9" bug):
 *   gitlab_mr_analytics holds one row per MR per daily snapshot, so an MR that
 *   exists across N snapshots must still be counted exactly once. Aggregation
 *   must deduplicate by (project_id, mr_iid) and window by reference_at, never
 *   by snapshot_date.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  aggregateTeamActivity,
  dedupeLatestByMr,
  referenceAt,
  type CanonicalMrRow,
} from "../mr-metrics-canonical";

const WINDOW_START = new Date("2026-06-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-06-08T00:00:00.000Z");

/** Build one MR snapshotted across `snapshots` consecutive days. */
function mrAcrossSnapshots(
  opts: {
    projectId: number;
    mrIid: number;
    author: string;
    mergedAt: string | null;
    state?: string;
    createdAt?: string;
    reviewers?: Array<{ username: string }>;
    snapshots: string[];
  }
): CanonicalMrRow[] {
  return opts.snapshots.map((snapshotDate) => ({
    projectId: opts.projectId,
    mrIid: opts.mrIid,
    team: "oms",
    title: `MR ${opts.mrIid}`,
    state: opts.state ?? "merged",
    authorUsername: opts.author,
    authorName: opts.author,
    authorAvatarUrl: null,
    projectName: "oms-api",
    webUrl: `https://gitlab/${opts.mrIid}`,
    createdAt: opts.createdAt ?? "2026-06-02T09:00:00.000Z",
    mergedAt: opts.mergedAt,
    snapshotDate,
    lifetimeHours: 10,
    reviewTimeHours: 4,
    reviewers: opts.reviewers ?? [],
  }));
}

const SEVEN_SNAPSHOTS = [
  "2026-06-02",
  "2026-06-03",
  "2026-06-04",
  "2026-06-05",
  "2026-06-06",
  "2026-06-07",
  "2026-06-08",
];

test("example: 9 merged MRs each present in 7 snapshots aggregate to 9, not 63", () => {
  const rows: CanonicalMrRow[] = [];
  for (let iid = 1; iid <= 9; iid++) {
    rows.push(
      ...mrAcrossSnapshots({
        projectId: 100,
        mrIid: iid,
        author: "dev",
        mergedAt: "2026-06-04T12:00:00.000Z",
        snapshots: SEVEN_SNAPSHOTS,
      })
    );
  }

  // Sanity: the raw row count IS inflated (the bug source).
  assert.equal(rows.length, 63);

  const result = aggregateTeamActivity(rows, WINDOW_START, WINDOW_END);
  assert.equal(result.summary.totalMRsMerged, 9);
  assert.equal(result.contributors.length, 1);
  assert.equal(result.contributors[0].mrsMerged, 9);
});

test("example: MRs merged outside the window are excluded even if snapshotted inside it", () => {
  // Merged before the window, but re-snapshotted every day inside the window
  // (exactly what makes snapshot_date windowing wrong).
  const rows = mrAcrossSnapshots({
    projectId: 100,
    mrIid: 1,
    author: "dev",
    mergedAt: "2026-05-01T12:00:00.000Z",
    snapshots: SEVEN_SNAPSHOTS,
  });

  const result = aggregateTeamActivity(rows, WINDOW_START, WINDOW_END);
  assert.equal(result.summary.totalMRsMerged, 0);
});

test("example: open MRs counted once and are window-independent", () => {
  const rows = mrAcrossSnapshots({
    projectId: 100,
    mrIid: 7,
    author: "dev",
    state: "opened",
    mergedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    snapshots: SEVEN_SNAPSHOTS,
  });

  const result = aggregateTeamActivity(rows, WINDOW_START, WINDOW_END);
  assert.equal(result.summary.totalMRsOpen, 1);
  assert.equal(result.summary.totalMRsMerged, 0);
});

test("example: reviews counted once per MR per reviewer, excluding self", () => {
  const rows = mrAcrossSnapshots({
    projectId: 100,
    mrIid: 1,
    author: "alice",
    mergedAt: "2026-06-04T12:00:00.000Z",
    reviewers: [{ username: "bob" }, { username: "alice" }],
    snapshots: SEVEN_SNAPSHOTS,
  });

  const result = aggregateTeamActivity(rows, WINDOW_START, WINDOW_END);
  const bob = result.contributors.find((c) => c.username === "bob");
  assert.ok(bob);
  assert.equal(bob.reviewsGiven, 1); // not 7
  const alice = result.contributors.find((c) => c.username === "alice");
  assert.equal(alice?.reviewsGiven ?? 0, 0); // self-review excluded
});

test("referenceAt uses merged_at for merged MRs and created_at otherwise", () => {
  const merged = referenceAt({
    state: "merged",
    mergedAt: "2026-06-04T00:00:00.000Z",
    createdAt: "2026-06-01T00:00:00.000Z",
  } as CanonicalMrRow);
  assert.equal(merged?.toISOString(), "2026-06-04T00:00:00.000Z");

  const open = referenceAt({
    state: "opened",
    mergedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
  } as CanonicalMrRow);
  assert.equal(open?.toISOString(), "2026-06-01T00:00:00.000Z");
});

test("property: merged count is independent of how many snapshots each MR has", () => {
  fc.assert(
    fc.property(
      // A set of distinct MRs, each merged inside the window.
      fc.array(
        fc.record({
          mrIid: fc.integer({ min: 1, max: 500 }),
          author: fc.constantFrom("a", "b", "c", "d"),
          snapshotCount: fc.integer({ min: 1, max: 30 }),
        }),
        { minLength: 0, maxLength: 40 }
      ),
      (specs) => {
        // Deduplicate specs by mrIid to get the true distinct MR set.
        const distinct = new Map<number, { author: string; snapshotCount: number }>();
        for (const s of specs) {
          if (!distinct.has(s.mrIid)) distinct.set(s.mrIid, { author: s.author, snapshotCount: s.snapshotCount });
        }

        const rows: CanonicalMrRow[] = [];
        for (const [mrIid, spec] of distinct) {
          const snapshots = Array.from({ length: spec.snapshotCount }, (_, i) => {
            const day = String(2 + (i % 6)).padStart(2, "0");
            return `2026-06-${day}`;
          });
          rows.push(
            ...mrAcrossSnapshots({
              projectId: 1,
              mrIid,
              author: spec.author,
              mergedAt: "2026-06-04T12:00:00.000Z",
              snapshots,
            })
          );
        }

        const result = aggregateTeamActivity(rows, WINDOW_START, WINDOW_END);
        // Total merged equals the number of DISTINCT MRs, regardless of snapshot multiplicity.
        assert.equal(result.summary.totalMRsMerged, distinct.size);
        // dedupeLatestByMr collapses to exactly the distinct MR set.
        assert.equal(dedupeLatestByMr(rows).length, distinct.size);
      }
    )
  );
});

test("property: dedupeLatestByMr keeps the most recent snapshot's state", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("opened", "merged"), { minLength: 1, maxLength: 10 }),
      (states) => {
        const rows: CanonicalMrRow[] = states.map((state, i) => ({
          projectId: 1,
          mrIid: 1,
          team: "oms",
          title: "MR 1",
          state,
          authorUsername: "dev",
          authorName: "dev",
          authorAvatarUrl: null,
          projectName: "oms-api",
          webUrl: null,
          createdAt: "2026-06-02T00:00:00.000Z",
          mergedAt: state === "merged" ? "2026-06-03T00:00:00.000Z" : null,
          snapshotDate: `2026-06-${String(2 + i).padStart(2, "0")}`,
          lifetimeHours: 1,
          reviewTimeHours: 1,
          reviewers: [],
        }));

        const deduped = dedupeLatestByMr(rows);
        assert.equal(deduped.length, 1);
        assert.equal(deduped[0].state, states[states.length - 1]);
      }
    )
  );
});
