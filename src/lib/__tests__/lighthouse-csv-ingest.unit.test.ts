/**
 * Unit / example tests for the pure Lighthouse CSV ingest module
 * (`ops/lib/csv-ingest.js`).
 *
 * Feature: lighthouse-url-expansion (task 1.5)
 *
 * These are EXAMPLE-based tests (not property tests) covering host→monitor
 * mapping and route derivation edge cases. They live in a SEPARATE file from
 * the property tests (`lighthouse-csv-ingest.property.test.ts`) so they do not
 * collide with property test tasks that share that file. The `npm test` glob
 * `src/lib/__tests__/*.test.ts` picks this file up automatically.
 *
 * The module under test is plain CommonJS under `ops/`; tsx imports it by
 * relative path without a build step.
 *
 * Covers Requirements 2.2, 2.3, 12.1, 12.2.
 */

import test from "node:test";
import assert from "node:assert/strict";

// CommonJS module imported by relative path (see design.md).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  mapHostToMonitor,
  deriveRoute,
  mapPageType,
  derivePriority,
  derivePriorityFromWeight,
} = require("../../../ops/lib/csv-ingest.js");

/**
 * The five Monitor_Base_Hosts (design.md "Mapa de hosts de monitores"),
 * derived from `synthetic_monitors.url` (host normalized to lowercase).
 */
const MONITORS: { id: number; host: string }[] = [
  { id: 1, host: "www.animalis.com" },
  { id: 2, host: "www.kiwoko.com" },
  { id: 3, host: "www.kiwoko.pt" },
  { id: 4, host: "www.tiendanimal.es" },
  { id: 5, host: "www.tiendanimal.pt" },
];

/* ------------------------------------------------------------------ */
/*  Req 2.2: each Monitor_Base_Host maps to its monitor_id (1..5)      */
/* ------------------------------------------------------------------ */

test("Req 2.2: each Monitor_Base_Host maps to its monitor_id (1..5)", () => {
  for (const monitor of MONITORS) {
    const url = `https://${monitor.host}/some/path`;
    assert.deepEqual(
      mapHostToMonitor(url, MONITORS),
      { monitorId: monitor.id },
      `host ${monitor.host} should map to monitor ${monitor.id}`
    );
  }
});

test("Req 2.1/2.2: host match is case-insensitive (uppercase host normalizes)", () => {
  assert.deepEqual(mapHostToMonitor("https://WWW.KIWOKO.COM/", MONITORS), {
    monitorId: 2,
  });
});

/* ------------------------------------------------------------------ */
/*  Req 2.3: cross-subdomain hosts → crossSubdomain                    */
/* ------------------------------------------------------------------ */

test("Req 2.3: apex host without www. → crossSubdomain", () => {
  assert.deepEqual(mapHostToMonitor("https://animalis.com/perros", MONITORS), {
    crossSubdomain: true,
    host: "animalis.com",
  });
});

test("Req 2.3: tiendas. subdomain → crossSubdomain", () => {
  assert.deepEqual(
    mapHostToMonitor("https://tiendas.tiendanimal.es/madrid", MONITORS),
    { crossSubdomain: true, host: "tiendas.tiendanimal.es" }
  );
});

test("Req 2.3: magasin. subdomain → crossSubdomain", () => {
  assert.deepEqual(
    mapHostToMonitor("https://magasin.animalis.com/paris", MONITORS),
    { crossSubdomain: true, host: "magasin.animalis.com" }
  );
});

/* ------------------------------------------------------------------ */
/*  Req 2.4: malformed URL / no host → error                          */
/* ------------------------------------------------------------------ */

test("Req 2.4: malformed URL → error (processing continues)", () => {
  const result = mapHostToMonitor("not a url", MONITORS);
  assert.ok("error" in result, "expected an error result for a malformed URL");
});

test("Req 2.4: relative path with no host → error", () => {
  const result = mapHostToMonitor("/just/a/path", MONITORS);
  assert.ok("error" in result, "expected an error result for a hostless URL");
});

/* ------------------------------------------------------------------ */
/*  Req 12.1: non-http(s) scheme → deriveRoute error                  */
/* ------------------------------------------------------------------ */

test("Req 12.1: ftp:// scheme → deriveRoute invalid_format error", () => {
  const result = deriveRoute("ftp://www.kiwoko.com/file.txt");
  assert.ok("error" in result, "expected an error result for ftp scheme");
  assert.match((result as { error: string }).error, /invalid_format/);
});

test("Req 12.1: mailto: scheme → deriveRoute invalid_format error", () => {
  const result = deriveRoute("mailto:hello@kiwoko.com");
  assert.ok("error" in result, "expected an error result for mailto scheme");
  assert.match((result as { error: string }).error, /invalid_format/);
});

/* ------------------------------------------------------------------ */
/*  Req 12.2: query with multiple `?` → deriveRoute error             */
/* ------------------------------------------------------------------ */

test("Req 12.2: query with multiple `?` → deriveRoute invalid_format error", () => {
  const result = deriveRoute("https://www.kiwoko.com/x?a=1?b=2");
  assert.ok("error" in result, "expected an error for a malformed query");
  assert.match((result as { error: string }).error, /invalid_format/);
});

test("Req 12.2: a single `?` before a `?` inside the fragment is valid", () => {
  // The extra `?` lives in the fragment, which is excluded; only one `?` is in
  // the query portion, so the route is valid.
  const result = deriveRoute("https://www.kiwoko.com/x?a=1#sec?ignored");
  assert.ok("route" in result, "expected a valid route");
  assert.equal((result as { route: string }).route, "/x?a=1");
});

/* ================================================================== */
/*  Task 1.8 — page type map entries and priority rules               */
/*  Covers Requirements 4.1, 4.2, 4.3, 4.5, 5.4, 5.5                   */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/*  Req 4.1/4.2: every PAGE_TYPE_MAP entry maps to its page_type       */
/* ------------------------------------------------------------------ */

const PAGE_TYPE_CASES: { input: string; pageType: string }[] = [
  { input: "home", pageType: "home" },
  { input: "plp", pageType: "plp" },
  { input: "pdp", pageType: "pdp" },
  { input: "blog", pageType: "blog" },
  { input: "brand", pageType: "brand" },
  { input: "store locator", pageType: "store_locator" },
  { input: "servicios", pageType: "services" },
  { input: "new pdp", pageType: "pdp" },
];

test("Req 4.1/4.2: every PAGE_TYPE_MAP entry maps to its page_type (recognized)", () => {
  for (const { input, pageType } of PAGE_TYPE_CASES) {
    assert.deepEqual(
      mapPageType(input),
      { pageType, recognized: true },
      `type "${input}" should map to "${pageType}"`
    );
  }
});

test("Req 4.2: 'new pdp' and 'store locator' multi-word entries map correctly", () => {
  assert.deepEqual(mapPageType("new pdp"), { pageType: "pdp", recognized: true });
  assert.deepEqual(mapPageType("store locator"), {
    pageType: "store_locator",
    recognized: true,
  });
  assert.deepEqual(mapPageType("servicios"), {
    pageType: "services",
    recognized: true,
  });
});

/* ------------------------------------------------------------------ */
/*  Req 4.4: normalization (trim + case-insensitive) before mapping    */
/* ------------------------------------------------------------------ */

test("Req 4.4: leading/trailing whitespace is trimmed before mapping", () => {
  assert.deepEqual(mapPageType("  home  "), { pageType: "home", recognized: true });
  assert.deepEqual(mapPageType("\tplp\n"), { pageType: "plp", recognized: true });
});

test("Req 4.4: mapping is case-insensitive", () => {
  assert.deepEqual(mapPageType("HOME"), { pageType: "home", recognized: true });
  assert.deepEqual(mapPageType("STORE LOCATOR"), {
    pageType: "store_locator",
    recognized: true,
  });
  assert.deepEqual(mapPageType("New PDP"), { pageType: "pdp", recognized: true });
});

test("Req 4.4: combined case + whitespace normalization", () => {
  assert.deepEqual(mapPageType("  STORE LOCATOR  "), {
    pageType: "store_locator",
    recognized: true,
  });
});

/* ------------------------------------------------------------------ */
/*  Req 4.3/4.5: empty / unrecognized type → other (not recognized)    */
/* ------------------------------------------------------------------ */

test("Req 4.5: empty / whitespace-only type → other (not recognized)", () => {
  assert.deepEqual(mapPageType(""), { pageType: "other", recognized: false });
  assert.deepEqual(mapPageType("   "), { pageType: "other", recognized: false });
  assert.deepEqual(mapPageType("\t\n"), { pageType: "other", recognized: false });
});

test("Req 4.5: non-string type → other (not recognized)", () => {
  assert.deepEqual(mapPageType(undefined), { pageType: "other", recognized: false });
  assert.deepEqual(mapPageType(null), { pageType: "other", recognized: false });
});

test("Req 4.3: unrecognized type → other (not recognized)", () => {
  assert.deepEqual(mapPageType("category"), {
    pageType: "other",
    recognized: false,
  });
  assert.deepEqual(mapPageType("checkout"), {
    pageType: "other",
    recognized: false,
  });
  assert.deepEqual(mapPageType("services"), {
    // "services" is the OUTPUT value, not an input key → unrecognized
    pageType: "other",
    recognized: false,
  });
});

/* ------------------------------------------------------------------ */
/*  Req 5.4: home page type ⇒ priority = 1 (regardless of weight)      */
/* ------------------------------------------------------------------ */

test("Req 5.4: home ⇒ priority 1 regardless of weight", () => {
  assert.deepEqual(derivePriority({ n: 5, pageType: "home" }), {
    priority: 1,
    classified: true,
  });
  // Even with a low weight, home stays at priority 1.
  assert.deepEqual(derivePriority({ n: 0, pageType: "home" }), {
    priority: 1,
    classified: true,
  });
  // Even with an out-of-range weight, the home rule wins.
  assert.deepEqual(derivePriority({ n: -3, pageType: "home" }), {
    priority: 1,
    classified: true,
  });
});

test("Req 5: non-home page type derives priority from weight", () => {
  // weight 5 → priority 1, weight 3 → priority 3, weight 0 → priority 5
  assert.deepEqual(derivePriority({ n: 5, pageType: "pdp" }), {
    priority: 1,
    classified: true,
  });
  assert.deepEqual(derivePriority({ n: 3, pageType: "plp" }), {
    priority: 3,
    classified: true,
  });
  assert.deepEqual(derivePriority({ n: 0, pageType: "blog" }), {
    priority: 5,
    classified: true,
  });
});

/* ------------------------------------------------------------------ */
/*  Req 5.5: absent / out-of-range / non-integer weight                */
/*           → priority 5, classified=false                            */
/* ------------------------------------------------------------------ */

test("Req 5.5: absent weight → priority 5, classified=false", () => {
  assert.deepEqual(derivePriorityFromWeight(undefined), {
    priority: 5,
    classified: false,
  });
  assert.deepEqual(derivePriorityFromWeight(null), {
    priority: 5,
    classified: false,
  });
  // via derivePriority for a non-home record with no weight
  assert.deepEqual(derivePriority({ pageType: "pdp" }), {
    priority: 5,
    classified: false,
  });
});

test("Req 5.5: out-of-range weight (negative / too large) → priority 5, classified=false", () => {
  assert.deepEqual(derivePriorityFromWeight(-1), {
    priority: 5,
    classified: false,
  });
  assert.deepEqual(derivePriorityFromWeight(2147483648), {
    priority: 5,
    classified: false,
  });
});

test("Req 5.5: non-integer weight → priority 5, classified=false", () => {
  assert.deepEqual(derivePriorityFromWeight(2.5), {
    priority: 5,
    classified: false,
  });
  assert.deepEqual(derivePriorityFromWeight(NaN), {
    priority: 5,
    classified: false,
  });
  assert.deepEqual(derivePriorityFromWeight("3" as unknown as number), {
    priority: 5,
    classified: false,
  });
});

test("Req 5.1/5.2: derivePriorityFromWeight full mapping table", () => {
  assert.deepEqual(derivePriorityFromWeight(5), { priority: 1, classified: true });
  assert.deepEqual(derivePriorityFromWeight(6), { priority: 1, classified: true });
  assert.deepEqual(derivePriorityFromWeight(4), { priority: 2, classified: true });
  assert.deepEqual(derivePriorityFromWeight(3), { priority: 3, classified: true });
  assert.deepEqual(derivePriorityFromWeight(2), { priority: 4, classified: true });
  assert.deepEqual(derivePriorityFromWeight(1), { priority: 5, classified: true });
  assert.deepEqual(derivePriorityFromWeight(0), { priority: 5, classified: true });
});
