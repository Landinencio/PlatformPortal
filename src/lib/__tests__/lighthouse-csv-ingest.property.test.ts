/**
 * Property-based tests for the pure Lighthouse CSV ingest module
 * (`ops/lib/csv-ingest.js`).
 *
 * Feature: lighthouse-url-expansion
 *
 * This file is SHARED by several property test tasks (1.2, 1.4, 1.7, 1.10,
 * 1.11). Each task appends its own clearly-tagged property block; do not remove
 * blocks added by other tasks.
 *
 * The module under test is plain CommonJS under `ops/`; tsx imports it by
 * relative path without a build step.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

// CommonJS module imported by relative path (see design.md).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  parseCsv,
  serializeCsv,
  FIELD_SEPARATOR,
  CSV_HEADER,
  MAX_N,
} = require("../../../ops/lib/csv-ingest.js");

interface CsvRecord {
  url: string;
  type: string;
  n: number;
}

/* ------------------------------------------------------------------ */
/*  Feature: lighthouse-url-expansion, Property 1: Round-trip de       */
/*  parseo CSV                                                          */
/* ------------------------------------------------------------------ */

/**
 * Characters safe to appear inside a CSV field without breaking the
 * round-trip: no field separator `;`, no newlines, and no whitespace (so the
 * trim applied by `parseCsv` cannot alter the value). Matches the design's
 * note: serialize→parse applies trim, so we generate already-trimmed fields
 * that contain neither `;` nor newlines.
 */
const SAFE_HOST_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-".split("");
const SAFE_PATH_CHARS =
  "abcdefghijklmnopqrstuvwxyz0123456789-_/.~!*'()&=%+".split("");
const SAFE_TYPE_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.".split("");

function strFromChars(chars: string[], min: number, max: number) {
  return fc
    .array(fc.constantFrom(...chars), { minLength: min, maxLength: max })
    .map((arr) => arr.join(""));
}

/** Valid http(s) URL with no `;`, whitespace or newlines. */
const urlArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom("http://", "https://"),
    strFromChars(SAFE_HOST_CHARS, 1, 20),
    fc.constantFrom(".com", ".es", ".pt", ".org", ".net"),
    fc.boolean(),
    strFromChars(SAFE_PATH_CHARS, 0, 30),
    fc.boolean(),
    strFromChars(SAFE_PATH_CHARS, 0, 20)
  )
  .map(([scheme, host, tld, hasPath, path, hasQuery, query]) => {
    let url = `${scheme}${host}${tld}`;
    if (hasPath && path.length > 0) url += `/${path}`;
    if (hasQuery && query.length > 0) url += `?${query}`;
    return url;
  });

/** Page type: arbitrary trimmed, non-empty string without `;` or newlines. */
const typeArb: fc.Arbitrary<string> = strFromChars(SAFE_TYPE_CHARS, 1, 15);

/** Integer weight in the valid range 0..MAX_N. */
const weightArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: MAX_N });

// Build records as plain object literals (not fc.record, which yields
// null-prototype objects that fail deepStrictEqual against parseCsv's plain
// object output).
const recordArb: fc.Arbitrary<CsvRecord> = fc
  .tuple(urlArb, typeArb, weightArb)
  .map(([url, type, n]) => ({ url, type, n }));

/**
 * Invalid CSV line that `parseCsv` must discard as `invalid_format`: a single
 * non-empty token with no field separator (so it splits into 1 field, not 3)
 * and no whitespace (so it is not omitted as a blank line). Cannot equal the
 * header because it contains no `;`.
 */
const invalidLineArb: fc.Arbitrary<string> = strFromChars(
  SAFE_TYPE_CHARS,
  1,
  20
);

test("Feature: lighthouse-url-expansion, Property 1: parseCsv(serializeCsv(records)) ≡ records (mixing valid and invalid lines). Validates: Requirements 1.9", () => {
  fc.assert(
    fc.property(
      fc.array(recordArb, { maxLength: 40 }),
      fc.array(invalidLineArb, { maxLength: 10 }),
      (records, invalidLines) => {
        // 1) Pure round-trip: serialize then parse recovers the exact records.
        const roundTrip = parseCsv(serializeCsv(records));
        assert.deepEqual(roundTrip.records, records);
        assert.equal(roundTrip.errors.length, 0);

        // 2) Mixing valid and invalid lines: interleave invalid lines among the
        //    serialized valid records. Valid records are preserved in order and
        //    every invalid line is reported as a discard, never aborting the rest.
        const parts: string[] = [CSV_HEADER];
        const maxLen = Math.max(records.length, invalidLines.length);
        for (let i = 0; i < maxLen; i++) {
          if (i < records.length) {
            const r = records[i];
            parts.push(
              `${r.url}${FIELD_SEPARATOR}${r.type}${FIELD_SEPARATOR}${r.n}`
            );
          }
          if (i < invalidLines.length) {
            parts.push(invalidLines[i]);
          }
        }
        const mixed = parseCsv(parts.join("\n"));
        assert.deepEqual(mixed.records, records);
        assert.equal(mixed.errors.length, invalidLines.length);
        assert.ok(
          mixed.errors.every((e: { reason: string }) => e.reason === "invalid_format")
        );
      }
    ),
    { numRuns: 200 }
  );
});

/* ------------------------------------------------------------------ */
/*  Feature: lighthouse-url-expansion, Property 2: Round-trip de       */
/*  derivación de ruta                                                 */
/* ------------------------------------------------------------------ */

// Pure functions exercised by Property 2. Imported here (separate destructure
// from the Property 1 require above) so this block stays self-contained.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { deriveRoute, mapHostToMonitor } = require("../../../ops/lib/csv-ingest.js");

/**
 * The five Monitor_Base_Hosts (see design.md "Mapa de hosts de monitores").
 * Hosts are already lowercase, exactly as normalized from `synthetic_monitors`.
 */
const MONITORS: { id: number; host: string }[] = [
  { id: 1, host: "www.animalis.com" },
  { id: 2, host: "www.kiwoko.com" },
  { id: 3, host: "www.kiwoko.pt" },
  { id: 4, host: "www.tiendanimal.es" },
  { id: 5, host: "www.tiendanimal.pt" },
];

/**
 * Characters that survive `new URL` parsing in a path segment / query without
 * being percent-encoded or triggering `.`/`..` segment resolution surprises,
 * so the serialize→parse round-trip is exact. We deliberately exclude `?`, `#`
 * (structural), whitespace, and `%` (ambiguous escapes).
 */
const PATH_SEG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-_~".split("");
const QUERY_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-_".split("");

const monitorArb = fc.constantFrom(...MONITORS);
const schemeArb = fc.constantFrom("http:", "https:");

/** Pathname: 0..4 segments, optional trailing slash; empty path → "/". */
const pathArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.array(strFromChars(PATH_SEG_CHARS, 1, 8), { minLength: 0, maxLength: 4 }),
    fc.boolean()
  )
  .map(([segs, trailingSlash]) => {
    if (segs.length === 0) return "/";
    let p = "/" + segs.join("/");
    if (trailingSlash) p += "/";
    return p;
  });

/** Query string body (without the leading `?`): 0..4 `k=v` pairs joined by `&`. */
const queryArb: fc.Arbitrary<string> = fc
  .array(
    fc.tuple(strFromChars(QUERY_CHARS, 1, 6), strFromChars(QUERY_CHARS, 0, 6)),
    { minLength: 0, maxLength: 4 }
  )
  .map((pairs) => pairs.map(([k, v]) => `${k}=${v}`).join("&"));

/** Optional fragment body (without the leading `#`). */
const fragArb: fc.Arbitrary<string> = fc.option(
  strFromChars(QUERY_CHARS, 1, 8),
  { nil: "" }
);

test("Feature: lighthouse-url-expansion, Property 2: Monitor_Base_Host + deriveRoute(url).route reconstructs the source URL minus fragment (preserving pathname incl. trailing slash and query). Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6", () => {
  fc.assert(
    fc.property(
      monitorArb,
      schemeArb,
      pathArb,
      queryArb,
      fragArb,
      (monitor, scheme, path, query, frag) => {
        // Build an http(s) URL whose host equals a Monitor_Base_Host.
        let url = `${scheme}//${monitor.host}${path}`;
        if (query) url += `?${query}`;
        if (frag) url += `#${frag}`;

        // The host must map to its monitor (Req 3 precondition: same monitor).
        assert.deepEqual(mapHostToMonitor(url, MONITORS), {
          monitorId: monitor.id,
        });

        const derived = deriveRoute(url);
        assert.ok("route" in derived, `expected a route for "${url}"`);
        const route = (derived as { route: string }).route;

        // Req 3.1: route starts with "/". Req 3.4: fragment excluded.
        assert.ok(route.startsWith("/"));
        assert.ok(!route.includes("#"));

        // Req 3.1, 3.2, 3.3, 3.5: concatenating the Monitor_Base_Host (no
        // trailing slash) with the route reconstructs the source URL once the
        // fragment is excluded, preserving pathname (incl. trailing slash) and
        // query string (order + content). Both sides are normalized through
        // `new URL`, so equality of `.href` is an exact round-trip check.
        const parsed = new URL(url);
        const sourceNoFragment = new URL(url);
        sourceNoFragment.hash = "";
        const reconstructed = new URL(
          `${parsed.protocol}//${monitor.host}${route}`
        );
        assert.equal(reconstructed.href, sourceNoFragment.href);

        // Req 3.6: two URLs of the same monitor differing only in their query
        // string produce two distinct routes.
        const queryB = query ? `${query}&zzz=1` : "zzz=1";
        const urlA = `${scheme}//${monitor.host}${path}${query ? `?${query}` : ""}`;
        const urlB = `${scheme}//${monitor.host}${path}?${queryB}`;
        const routeA = deriveRoute(urlA);
        const routeB = deriveRoute(urlB);
        assert.ok("route" in routeA && "route" in routeB);
        assert.notEqual(
          (routeA as { route: string }).route,
          (routeB as { route: string }).route
        );
      }
    ),
    { numRuns: 200 }
  );
});

/* ------------------------------------------------------------------ */
/*  Feature: lighthouse-url-expansion, Property 3: Invariantes de      */
/*  derivación de prioridad                                            */
/* ------------------------------------------------------------------ */

// Pure function exercised by Property 3. Separate destructure (self-contained
// block) so this property can be read/maintained independently of the others.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { derivePriorityFromWeight } = require("../../../ops/lib/csv-ingest.js");

/**
 * Broad generator for the range + determinism sub-properties: covers ANY kind
 * of input `n` the ingester might receive —
 *   - valid integers in 0..MAX_N,
 *   - negative integers,
 *   - integers above MAX_N (out of the INT32 range, e.g. > 2147483647),
 *   - non-integer floats (incl. negatives and huge values),
 *   - the special doubles NaN / ±Infinity.
 * For all of these, `priority` must still be an integer in 1..5
 * (Req 5.1 range invariant; Req 5.5 unclassified → priority 5 stays within range).
 */
const anyWeightArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 0, max: MAX_N }), // valid classified domain
  fc.integer({ min: -1_000_000, max: -1 }), // negatives
  fc.integer({ min: MAX_N + 1, max: Number.MAX_SAFE_INTEGER }), // out of range
  fc.double({ min: -1e6, max: 1e6, noNaN: true }).filter((x) => !Number.isInteger(x)), // floats
  fc.constantFrom(NaN, Infinity, -Infinity) // non-finite doubles
);

/**
 * Constrained generator for the monotonicity sub-property: the design defines
 * `derivePriorityFromWeight` as monotone non-increasing over the weight `n`,
 * which is only meaningful over its classified domain (valid non-negative
 * integers 0..MAX_N). Invalid/out-of-range inputs collapse to priority 5
 * (unclassified) and would muddy the comparison, so we restrict to the valid
 * integer domain here.
 */
const validWeightArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: MAX_N });

test("Feature: lighthouse-url-expansion, Property 3: derivePriorityFromWeight(n) is range-bounded 1..5, monotone non-increasing in n, and deterministic. Validates: Requirements 5.1, 5.2, 5.3", () => {
  // (a) Range invariant + (c) determinism over the BROAD input space.
  fc.assert(
    fc.property(anyWeightArb, (n) => {
      const r1 = derivePriorityFromWeight(n);

      // Req 5.1: priority is always an integer in 1..5 for ANY input — including
      // negatives, out-of-range, non-integers and non-finite doubles (which map
      // to the unclassified priority 5, still within range — Req 5.5).
      assert.ok(
        Number.isInteger(r1.priority),
        `priority must be an integer, got ${r1.priority} for n=${n}`
      );
      assert.ok(
        r1.priority >= 1 && r1.priority <= 5,
        `priority out of range 1..5: ${r1.priority} for n=${n}`
      );
      assert.equal(typeof r1.classified, "boolean");

      // Req 5.3: determinism — two calls with the same n give the same result.
      const r2 = derivePriorityFromWeight(n);
      assert.deepEqual(r1, r2);
    }),
    { numRuns: 200 }
  );

  // (b) Monotone non-increasing over the classified domain (valid integers).
  fc.assert(
    fc.property(validWeightArb, validWeightArb, (a, b) => {
      const n1 = Math.max(a, b);
      const n2 = Math.min(a, b);
      const p1 = derivePriorityFromWeight(n1).priority;
      const p2 = derivePriorityFromWeight(n2).priority;

      // Req 5.2: n1 > n2 ⇒ priority(n1) <= priority(n2) (greater weight ⇒ equal
      // or smaller priority number). When n1 === n2, priorities are equal
      // (determinism / Req 5.3), which also satisfies <=.
      assert.ok(
        p1 <= p2,
        `monotonicity violated: priority(${n1})=${p1} > priority(${n2})=${p2}`
      );
    }),
    { numRuns: 200 }
  );
});

/* ------------------------------------------------------------------ */
/*  Feature: lighthouse-url-expansion, Property 4: Deduplicación       */
/*  conserva unicidad y prioridad mínima                               */
/* ------------------------------------------------------------------ */

// Pure function exercised by Property 4. Separate destructure (self-contained
// block) so this property can be read/maintained independently of the others.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { dedupeTargets } = require("../../../ops/lib/csv-ingest.js");

interface Target {
  monitorId: number;
  route: string;
  pageType: string;
  priority: number;
  source: string;
}

/**
 * Small domains for monitorId and route so collisions on the (monitorId, route)
 * pair are frequent: 3 monitor ids × 3 fixed routes = 9 distinct pairs. With
 * arrays of up to ~30 targets, most pairs are hit by several inputs of varying
 * priority — exactly the duplicate scenario Property 4 must exercise.
 */
const dedupeMonitorIdArb: fc.Arbitrary<number> = fc.constantFrom(1, 2, 3);
const dedupeRouteArb: fc.Arbitrary<string> = fc.constantFrom("/a", "/b", "/c");
const dedupePageTypeArb: fc.Arbitrary<string> = fc.constantFrom(
  "home",
  "plp",
  "pdp",
  "other"
);
const dedupePriorityArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 5 });
const dedupeSourceArb: fc.Arbitrary<string> = fc.constantFrom("csv", "seed");

// Build Targets as plain object literals (NOT fc.record — it yields
// null-prototype objects that break deepStrictEqual against the module's plain
// object output, per the note above for Property 1).
const targetArb: fc.Arbitrary<Target> = fc
  .tuple(
    dedupeMonitorIdArb,
    dedupeRouteArb,
    dedupePageTypeArb,
    dedupePriorityArb,
    dedupeSourceArb
  )
  .map(([monitorId, route, pageType, priority, source]) => ({
    monitorId,
    route,
    pageType,
    priority,
    source,
  }));

test("Feature: lighthouse-url-expansion, Property 4: dedupeTargets keeps exactly one target per (monitorId, route) and, on duplicates, the one with the MINIMUM priority. Validates: Requirements 6.1, 6.2", () => {
  fc.assert(
    fc.property(fc.array(targetArb, { minLength: 0, maxLength: 30 }), (targets) => {
      const result: Target[] = dedupeTargets(targets);

      // Helper to build the grouping key used by the module.
      const keyOf = (t: Target) => `${t.monitorId}\u0000${t.route}`;

      // Group the INPUT by (monitorId, route) so we can assert against the
      // expected representative per group.
      const inputGroups = new Map<string, Target[]>();
      for (const t of targets) {
        const k = keyOf(t);
        const arr = inputGroups.get(k);
        if (arr) arr.push(t);
        else inputGroups.set(k, [t]);
      }

      // (1) Uniqueness: the output has exactly one target per distinct
      //     (monitorId, route) present in the input — no key appears twice.
      const outKeys = result.map(keyOf);
      assert.equal(
        outKeys.length,
        new Set(outKeys).size,
        "output contains duplicate (monitorId, route) pairs"
      );
      assert.equal(
        result.length,
        inputGroups.size,
        "output count must equal number of distinct (monitorId, route) groups"
      );

      // (3a) Every (monitorId, route) in the output existed in the input.
      const inputKeySet = new Set(inputGroups.keys());
      for (const k of outKeys) {
        assert.ok(
          inputKeySet.has(k),
          `output fabricated a (monitorId, route) pair not present in input: ${k}`
        );
      }

      // (3b) Every distinct (monitorId, route) in the input appears in output
      //      (no lost pairs).
      const outKeySet = new Set(outKeys);
      for (const k of inputKeySet) {
        assert.ok(outKeySet.has(k), `output dropped an input pair: ${k}`);
      }

      // (2) For each group, the kept target's priority equals the MIN priority
      //     among the inputs of that group.
      for (const kept of result) {
        const group = inputGroups.get(keyOf(kept)) as Target[];
        const minPriority = group.reduce(
          (m, t) => Math.min(m, t.priority),
          Infinity
        );
        assert.equal(
          kept.priority,
          minPriority,
          `kept priority ${kept.priority} != min ${minPriority} for ${keyOf(kept)}`
        );
        // The kept target must be one of the actual inputs of that group (not a
        // fabricated object) — it matches an input with the minimum priority.
        assert.ok(
          group.some(
            (t) =>
              t.monitorId === kept.monitorId &&
              t.route === kept.route &&
              t.pageType === kept.pageType &&
              t.priority === kept.priority &&
              t.source === kept.source
          ),
          `kept target is not one of the group's inputs for ${keyOf(kept)}`
        );
      }
    }),
    { numRuns: 200 }
  );
});

/* ------------------------------------------------------------------ */
/*  Feature: lighthouse-url-expansion, Property 5: Idempotencia de la  */
/*  deduplicación y de la ingesta pura                                 */
/* ------------------------------------------------------------------ */

// Self-contained require for this block. `dedupeTargets`/`buildTargets` would
// collide with the module-scope `const { dedupeTargets } = require(...)` of
// Property 4, so we use a uniquely-named alias and call `ingest.dedupeTargets`
// / `ingest.buildTargets`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ingest = require("../../../ops/lib/csv-ingest.js");

interface P5Target {
  monitorId: number;
  route: string;
  pageType: string;
  priority: number;
  source: string;
}

interface P5CsvRecord {
  url: string;
  type: string;
  n: number;
}

/**
 * Targets with small (monitorId, route) domains so collisions are frequent:
 * 3 monitor ids × 3 routes = 9 distinct pairs, with varying priorities. Built
 * as plain object literals (NOT fc.record, which yields null-prototype objects
 * that break deepStrictEqual against the module's plain object output).
 */
const p5MonitorIdArb: fc.Arbitrary<number> = fc.constantFrom(1, 2, 3);
const p5RouteArb: fc.Arbitrary<string> = fc.constantFrom("/a", "/b", "/c");
const p5PageTypeArb: fc.Arbitrary<string> = fc.constantFrom(
  "home",
  "plp",
  "pdp",
  "other"
);
const p5PriorityArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 5 });
const p5SourceArb: fc.Arbitrary<string> = fc.constantFrom("csv", "seed");

const p5TargetArb: fc.Arbitrary<P5Target> = fc
  .tuple(p5MonitorIdArb, p5RouteArb, p5PageTypeArb, p5PriorityArb, p5SourceArb)
  .map(([monitorId, route, pageType, priority, source]) => ({
    monitorId,
    route,
    pageType,
    priority,
    source,
  }));

/**
 * CsvRecord generator for `buildTargets`: mixes
 *   - valid http(s) URLs whose host is one of the 5 Monitor_Base_Hosts,
 *   - cross-subdomain URLs (apex without `www.`, `tiendas.`, `magasin.`, blog…),
 *   - malformed/unsupported URLs (no scheme, ftp:, empty, multiple `?`),
 * with recognized and unrecognized/empty page types and assorted weights, so
 * the pipeline exercises every discard reason and the dedupe collapse.
 */
const p5SchemeArb = fc.constantFrom("http://", "https://");
const p5MonitorHostArb = fc.constantFrom(...MONITORS.map((m) => m.host));
const p5CrossHostArb = fc.constantFrom(
  "animalis.com",
  "tiendas.kiwoko.com",
  "magasin.tiendanimal.pt",
  "kiwoko.pt",
  "blog.animalis.com"
);
const p5TypeArb = fc.constantFrom(
  "home",
  "plp",
  "pdp",
  "blog",
  "brand",
  "store locator",
  "servicios",
  "new pdp",
  "weirdtype",
  ""
);
const p5WeightArb = fc.integer({ min: 0, max: 8 });
const p5InvalidUrlArb = fc.constantFrom(
  "not-a-url",
  "ftp://www.kiwoko.com/x",
  "http://",
  "https://www.kiwoko.com/a?b?c",
  "://missing-scheme",
  ""
);

// Path (+ optional query) suffix reusing the Property 2 arbitraries. `pathArb`
// always starts with "/" (root → "/"), `queryArb` yields the query body.
const p5SuffixArb: fc.Arbitrary<string> = fc
  .tuple(pathArb, fc.boolean(), queryArb)
  .map(([path, hasQuery, query]) => {
    let s = path;
    if (hasQuery && query.length > 0) s += `?${query}`;
    return s;
  });

const p5RecordArb: fc.Arbitrary<P5CsvRecord> = fc.oneof(
  // Valid: host matches a Monitor_Base_Host.
  fc
    .tuple(p5SchemeArb, p5MonitorHostArb, p5SuffixArb, p5TypeArb, p5WeightArb)
    .map(([scheme, host, suffix, type, n]) => ({
      url: `${scheme}${host}${suffix}`,
      type,
      n,
    })),
  // Cross-subdomain: real-looking host that is NOT a Monitor_Base_Host.
  fc
    .tuple(p5SchemeArb, p5CrossHostArb, p5SuffixArb, p5TypeArb, p5WeightArb)
    .map(([scheme, host, suffix, type, n]) => ({
      url: `${scheme}${host}${suffix}`,
      type,
      n,
    })),
  // Invalid: malformed / unsupported scheme / multiple "?".
  fc.tuple(p5InvalidUrlArb, p5TypeArb, p5WeightArb).map(([url, type, n]) => ({
    url,
    type,
    n,
  }))
);

test("Feature: lighthouse-url-expansion, Property 5: dedupeTargets and buildTargets are idempotent — dedupeTargets(dedupeTargets(t)) ≡ dedupeTargets(t) and buildTargets(records, monitors) is referentially stable across runs. Validates: Requirements 6.3, 10.1", () => {
  // (a) Idempotence of dedupeTargets: applying it to an already-deduped set
  //     returns an equal set (Req 6.3).
  fc.assert(
    fc.property(fc.array(p5TargetArb, { minLength: 0, maxLength: 30 }), (targets) => {
      const once: P5Target[] = ingest.dedupeTargets(targets);
      const twice: P5Target[] = ingest.dedupeTargets(once);
      assert.deepEqual(twice, once);
    }),
    { numRuns: 200 }
  );

  // (b) Idempotence / determinism of the pure ingestion: running buildTargets
  //     twice over the same inputs yields deep-equal {targets, discards}
  //     (Req 10.1), and its emitted targets are already a dedupe fixpoint
  //     (dedupeTargets over them is a no-op — Req 6.3).
  fc.assert(
    fc.property(fc.array(p5RecordArb, { minLength: 0, maxLength: 40 }), (records) => {
      const r1 = ingest.buildTargets(records, MONITORS);
      const r2 = ingest.buildTargets(records, MONITORS);

      assert.deepEqual(r1.targets, r2.targets);
      assert.deepEqual(r1.discards, r2.discards);

      // The targets buildTargets returns are already deduped: re-deduping is a
      // fixpoint (idempotent ingestion).
      assert.deepEqual(ingest.dedupeTargets(r1.targets), r1.targets);
    }),
    { numRuns: 200 }
  );
});
