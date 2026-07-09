/**
 * Bugfix pure-logic tests — spec: gestion-mr-history.
 *
 * Properties 5 & 6 validate the pagination/order invariants the backfill relies
 * on. Property 5 exercises the pure `planPagination(total, limit)` helper
 * exported by `ops/mr-metrics-snapshot.js` (task 3.1): walking every page of the
 * plan covers EXACTLY `total` rows, with no gaps and no overlaps, and
 * `totalPages = ceil(total/limit)`. Property 6 fixes the detail listing order —
 * `merged_at DESC NULLS LAST` — mirroring the endpoint's
 * `ORDER BY merged_at DESC NULLS LAST` (src/app/api/metrics/mr-details/route.ts).
 *
 * Property 5: Paginación cubre exactamente `total` — para cualquier `total ≥ 0`
 *   y `limit ∈ [10,200]`, recorrer todas las páginas del plan cubre exactamente
 *   `total` filas sin solapes ni huecos; `totalPages = ceil(total/limit)` y
 *   coincide con `pages.length`.
 * Property 6: Orden monótono — para cualquier conjunto de MRs (con `merged_at`
 *   posiblemente null o repetido), ordenar por `merged_at DESC NULLS LAST`
 *   produce una secuencia no creciente de `merged_at` con los nulls al final.
 *
 * Conventions (repo): node:test + node:assert/strict, fast-check ^4,
 * { numRuns: 100 }, un comentario `// Feature: ...` por propiedad. El módulo
 * bajo prueba es CommonJS bajo `ops/`; tsx lo importa por ruta relativa.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

/*
 * `ops/mr-metrics-snapshot.js` guards its startup with `require.main === module`,
 * so importing it for tests never runs `main()`, opens a DB connection, or hits
 * the network. We still seed dummy env + stub global.fetch (matching the sibling
 * gestion-mr-history tests) as defence in depth so this file stays fully OFFLINE.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";
process.env.GITLAB_TOKEN = process.env.GITLAB_TOKEN || "test-token";
(globalThis as { fetch?: unknown }).fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => [],
  headers: { get: () => null },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const snapshot = require("../../../ops/mr-metrics-snapshot.js");

/* ================================================================== */
/* Property 5 — planPagination tiles [0, total) exactly.              */
/* ================================================================== */

// Feature: gestion-mr-history, Property 5: Paginación cubre exactamente `total`
// — para cualquier `total ≥ 0` y `limit ∈ [10,200]`, el plan de paginación
// recorre exactamente `total` filas (suma de counts = total), las páginas
// teselan `[0, total)` de forma contigua (sin huecos ni solapes), y
// `totalPages = ceil(total/limit) = pages.length`.
test("Property 5 (pagination): planPagination covers exactly total with no gaps/overlaps", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 10000 }), // total >= 0
      fc.integer({ min: 10, max: 200 }), // limit in [10,200]
      (total, limit) => {
        const { totalPages, pages } = snapshot.planPagination(total, limit);

        // totalPages = ceil(total/limit), and matches the number of page descriptors.
        assert.equal(totalPages, Math.ceil(total / limit), "totalPages must be ceil(total/limit)");
        assert.equal(pages.length, totalPages, "pages.length must equal totalPages");

        // total = 0 ⇒ no pages at all.
        if (total === 0) {
          assert.equal(totalPages, 0, "total=0 must yield 0 pages");
          assert.equal(pages.length, 0, "total=0 must yield an empty plan");
          return;
        }

        // Sum of per-page counts equals total (exact coverage).
        const covered = pages.reduce((acc: number, p: { count: number }) => acc + p.count, 0);
        assert.equal(covered, total, "sum of page.count must equal total");

        // Pages tile [0, total) contiguously: 1-based page numbers, first offset 0,
        // each offset = previous offset + previous count, last offset+count = total.
        assert.equal(pages[0].offset, 0, "first page offset must be 0");
        assert.equal(pages[0].page, 1, "page numbering must be 1-based");
        for (let i = 0; i < pages.length; i++) {
          const p = pages[i];
          assert.equal(p.page, i + 1, "page numbers must be sequential 1-based");
          assert.ok(p.count > 0, "every page must hold at least one row");
          assert.ok(p.count <= limit, "no page may hold more than `limit` rows");
          if (i > 0) {
            const prev = pages[i - 1];
            assert.equal(
              p.offset,
              prev.offset + prev.count,
              "each page offset must be previous offset + previous count (no gaps/overlaps)",
            );
          }
        }
        const last = pages[pages.length - 1];
        assert.equal(last.offset + last.count, total, "last page must reach exactly total");

        // Only the last page may be a partial (remainder) page; all earlier pages are full.
        for (let i = 0; i < pages.length - 1; i++) {
          assert.equal(pages[i].count, limit, "non-final pages must be full pages of `limit`");
        }
      },
    ),
    { numRuns: 100 },
  );
});

/* ================================================================== */
/* Property 6 — merged_at DESC NULLS LAST ordering.                   */
/* ================================================================== */

const DAY_MS = 24 * 60 * 60 * 1000;
const EPOCH = new Date("2026-01-01T00:00:00.000Z");

type MR = { iid: number; merged_at: string | null };

/**
 * Comparator mirroring the SQL `ORDER BY merged_at DESC NULLS LAST` used by
 * `src/app/api/metrics/mr-details/route.ts`: non-null `merged_at` sorted
 * descending, with null `merged_at` pushed to the end.
 */
function compareMergedAtDescNullsLast(a: MR, b: MR): number {
  if (a.merged_at === null && b.merged_at === null) return 0;
  if (a.merged_at === null) return 1; // a (null) goes after b
  if (b.merged_at === null) return -1; // b (null) goes after a
  return new Date(b.merged_at).getTime() - new Date(a.merged_at).getTime();
}

// Feature: gestion-mr-history, Property 6: Orden monótono — para cualquier
// conjunto de MRs (con `merged_at` posiblemente null o con valores repetidos),
// ordenar por `merged_at DESC NULLS LAST` produce una secuencia no creciente de
// `merged_at` para las entradas no nulas, con todos los nulls al final.
test("Property 6 (order): merged_at DESC NULLS LAST is non-increasing with nulls last", () => {
  fc.assert(
    fc.property(
      fc.array(
        // Day-index in [0, 240] (some values repeat ⇒ ties) or null (~25% of entries).
        fc.option(fc.integer({ min: 0, max: 240 }), { freq: 3, nil: null }),
        { maxLength: 60 },
      ),
      (dayIdxs) => {
        const mrs: MR[] = dayIdxs.map((idx, k) => ({
          iid: k + 1,
          merged_at: idx === null ? null : new Date(EPOCH.getTime() + idx * DAY_MS).toISOString(),
        }));

        const ordered = [...mrs].sort(compareMergedAtDescNullsLast);

        // Sorting preserves the multiset (no rows dropped/added).
        assert.equal(ordered.length, mrs.length, "ordering must not change the row count");

        // All nulls come after all non-nulls: once a null appears, the rest are null.
        let seenNull = false;
        for (const m of ordered) {
          if (m.merged_at === null) {
            seenNull = true;
          } else {
            assert.equal(seenNull, false, "a non-null merged_at must never appear after a null (NULLS LAST)");
          }
        }

        // Non-null prefix is monotonically non-increasing by merged_at.
        const nonNull = ordered.filter((m) => m.merged_at !== null) as { iid: number; merged_at: string }[];
        for (let i = 1; i < nonNull.length; i++) {
          const prev = new Date(nonNull[i - 1].merged_at).getTime();
          const cur = new Date(nonNull[i].merged_at).getTime();
          assert.ok(prev >= cur, "non-null merged_at sequence must be non-increasing (DESC)");
        }

        // The count of trailing nulls equals the number of null inputs.
        const nullCount = mrs.filter((m) => m.merged_at === null).length;
        const trailingNulls = ordered.slice(ordered.length - nullCount);
        for (const m of trailingNulls) {
          assert.equal(m.merged_at, null, "all trailing entries must be the null-merged_at rows");
        }
      },
    ),
    { numRuns: 100 },
  );
});
