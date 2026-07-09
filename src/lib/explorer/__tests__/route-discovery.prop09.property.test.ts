// Feature: ai-portal-explorer, Property 9: Solo se incluyen URLs internas al Target_Environment
/**
 * Property-based test for the Route_Discovery internal-URL guard.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/route-discovery.ts
 *
 * Property 9: Solo se incluyen URLs internas al Target_Environment.
 *   Para toda URL y base URL, `isInternalUrl(url, baseUrl)` devuelve verdadero
 *   SI Y SOLO SI la URL resuelta pertenece al dominio de la base URL: su `host`
 *   (hostname:puerto) coincide con el de la base (comparación case-insensitive
 *   del hostname) Y su protocolo es http(s). En consecuencia, el Route_Inventory
 *   construido por `buildRouteInventory` excluye toda URL externa al dominio del
 *   Target_Environment.
 *
 *   Generadores dirigidos (con resultado esperado conocido):
 *     - URLs internas absolutas (mismo host, casing variado, path/query, puerto
 *       por defecto del esquema que se normaliza) → true.
 *     - Rutas relativas (resueltas contra la base) → true.
 *     - Hosts externos → false.
 *     - Protocolos no http(s): mailto:, javascript:, tel:, ftp:, ws:, file:… → false.
 *     - URLs protocol-relative `//otro-host` → false.
 *     - Puertos no-por-defecto sobre el host interno → false (el host difiere).
 *     - Base URL malformada → false (sin importar la URL).
 *   Además: todo el `buildRouteInventory(baseUrl)` solo contiene rutas internas.
 *
 * **Validates: Requirements 4.6**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/route-discovery.prop09.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { isInternalUrl, buildRouteInventory } from "../route-discovery";

/* ------------------------------------------------------------------ */
/*  Target_Environment base (portal-dev)                               */
/* ------------------------------------------------------------------ */

const BASE_URL = "https://portal.today.dev.tooling.dp.iskaypet.com";
const BASE_HOST = "portal.today.dev.tooling.dp.iskaypet.com";

/* ------------------------------------------------------------------ */
/*  Building-block arbitraries                                         */
/* ------------------------------------------------------------------ */

/** Path always starting with a single "/" (never "//", which is protocol-relative). */
const arbPath: fc.Arbitrary<string> = fc
  .array(fc.stringMatching(/^[a-zA-Z0-9._~-]{1,8}$/), { maxLength: 4 })
  .map((segs) => "/" + segs.join("/"));

/** Optional query string like "?a=1&b=foo". */
const arbQuery: fc.Arbitrary<string> = fc
  .array(
    fc.tuple(
      fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,5}$/),
      fc.stringMatching(/^[a-zA-Z0-9]{0,6}$/),
    ),
    { maxLength: 3 },
  )
  .map((pairs) => (pairs.length === 0 ? "" : "?" + pairs.map(([k, v]) => `${k}=${v}`).join("&")));

/** Case variations of the internal host (hostname comparison is case-insensitive). */
const arbHostCasing: fc.Arbitrary<string> = fc
  .array(fc.boolean(), { minLength: BASE_HOST.length, maxLength: BASE_HOST.length })
  .map((flags) =>
    BASE_HOST.split("")
      .map((ch, i) => (flags[i] ? ch.toUpperCase() : ch))
      .join(""),
  );

/* ------------------------------------------------------------------ */
/*  TRUE cases                                                         */
/* ------------------------------------------------------------------ */

/**
 * Internal absolute URLs: same hostname (varied casing), http or https, optional
 * scheme-default port (which the URL parser normalizes away so the host stays
 * equal to the base host), varied path/query.
 */
const arbInternalAbsolute: fc.Arbitrary<string> = fc
  .record({
    scheme: fc.constantFrom("http", "https"),
    host: arbHostCasing,
    useDefaultPort: fc.boolean(),
    path: arbPath,
    query: arbQuery,
  })
  .map(({ scheme, host, useDefaultPort, path, query }) => {
    // Default ports (http:80, https:443) are dropped by URL → host stays bare.
    const port = useDefaultPort ? (scheme === "https" ? ":443" : ":80") : "";
    return `${scheme}://${host}${port}${path}${query}`;
  });

/** Relative URLs that resolve against the base → same host → internal. */
const arbRelative: fc.Arbitrary<string> = fc.oneof(
  fc.record({ path: arbPath, query: arbQuery }).map(({ path, query }) => `${path}${query}`),
  // Bare query / empty / dot segments all resolve to the base host.
  arbQuery.filter((q) => q.length > 0),
  fc.constantFrom("", ".", "./finops", "../metrics", "/", "/api/health"),
);

/* ------------------------------------------------------------------ */
/*  FALSE cases                                                        */
/* ------------------------------------------------------------------ */

/** Hosts that are NOT the internal target host. */
const EXTERNAL_HOSTS = [
  "portal.today.tooling.dp.iskaypet.com", // PROD (no `dev` segment)
  "portal.today.uat.tooling.dp.iskaypet.com",
  "portal.today.dev.tooling.dp.iskaypet.com.evil.com", // suffix attack
  "evil-portal.today.dev.tooling.dp.iskaypet.com", // prefix attack
  "iskaypet.com",
  "localhost",
  "127.0.0.1",
  "example.com",
  "google.com",
  "portal.today.dev.tooling.dp.iskaypet.org", // wrong TLD
] as const;

/** External absolute URLs (http/https) → host differs → not internal. */
const arbExternalAbsolute: fc.Arbitrary<string> = fc
  .record({
    scheme: fc.constantFrom("http", "https"),
    host: fc.constantFrom(...EXTERNAL_HOSTS),
    path: arbPath,
    query: arbQuery,
  })
  .map(({ scheme, host, path, query }) => `${scheme}://${host}${path}${query}`);

/** Protocol-relative URLs `//other-host/...` → resolve to an external host. */
const arbProtocolRelative: fc.Arbitrary<string> = fc
  .record({ host: fc.constantFrom(...EXTERNAL_HOSTS), path: arbPath })
  .map(({ host, path }) => `//${host}${path}`);

/** Non-http(s) schemes (even pointing at the internal host) → not navigable. */
const arbNonHttp: fc.Arbitrary<string> = fc.oneof(
  fc.constant("mailto:soporte@iskaypet.com"),
  fc.constant("javascript:alert(1)"),
  fc.constant("tel:+34123456789"),
  fc.constant(`ftp://${BASE_HOST}/file.txt`),
  fc.constantFrom("ws", "wss", "file", "data", "ssh").map((s) => `${s}://${BASE_HOST}/x`),
);

/** Internal hostname but a NON-default port → host (hostname:port) differs → false. */
const arbInternalWrongPort: fc.Arbitrary<string> = fc
  .record({
    scheme: fc.constantFrom("http", "https"),
    port: fc.integer({ min: 1, max: 65535 }).filter((p) => p !== 80 && p !== 443),
    path: arbPath,
  })
  .map(({ scheme, port, path }) => `${scheme}://${BASE_HOST}:${port}${path}`);

/** Malformed base URLs → `new URL(baseUrl)` throws → always false. */
const arbMalformedBase: fc.Arbitrary<string> = fc.constantFrom(
  "",
  "   ",
  "not a url",
  "://missing-scheme",
  "http://",
  ":",
  "ht!tp://bad",
);

/* ------------------------------------------------------------------ */
/*  Property 9                                                         */
/* ------------------------------------------------------------------ */

test("Property 9: internal absolute URLs are internal (true)", () => {
  fc.assert(
    fc.property(arbInternalAbsolute, (url) => {
      assert.equal(isInternalUrl(url, BASE_URL), true, `expected internal: ${url}`);
    }),
    { numRuns: 100 },
  );
});

test("Property 9: relative URLs resolve to the internal host (true)", () => {
  fc.assert(
    fc.property(arbRelative, (url) => {
      assert.equal(isInternalUrl(url, BASE_URL), true, `expected internal: ${JSON.stringify(url)}`);
    }),
    { numRuns: 100 },
  );
});

test("Property 9: external hosts are not internal (false)", () => {
  fc.assert(
    fc.property(arbExternalAbsolute, (url) => {
      assert.equal(isInternalUrl(url, BASE_URL), false, `expected external: ${url}`);
    }),
    { numRuns: 100 },
  );
});

test("Property 9: protocol-relative URLs to other hosts are not internal (false)", () => {
  fc.assert(
    fc.property(arbProtocolRelative, (url) => {
      assert.equal(isInternalUrl(url, BASE_URL), false, `expected external: ${url}`);
    }),
    { numRuns: 100 },
  );
});

test("Property 9: non-http(s) protocols are not internal (false)", () => {
  fc.assert(
    fc.property(arbNonHttp, (url) => {
      assert.equal(isInternalUrl(url, BASE_URL), false, `expected rejected: ${url}`);
    }),
    { numRuns: 100 },
  );
});

test("Property 9: internal hostname with a non-default port is not internal (false)", () => {
  fc.assert(
    fc.property(arbInternalWrongPort, (url) => {
      assert.equal(isInternalUrl(url, BASE_URL), false, `expected rejected (port): ${url}`);
    }),
    { numRuns: 100 },
  );
});

test("Property 9: a malformed base URL makes everything non-internal (false)", () => {
  fc.assert(
    fc.property(
      arbMalformedBase,
      fc.oneof(arbInternalAbsolute, arbRelative, arbExternalAbsolute),
      (badBase, url) => {
        assert.equal(isInternalUrl(url, badBase), false, `expected false for bad base: ${badBase}`);
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 9: buildRouteInventory contains only internal routes", async () => {
  const inventory = await buildRouteInventory(BASE_URL);
  assert.ok(inventory.length > 0, "inventory should not be empty");
  for (const route of inventory) {
    assert.equal(
      isInternalUrl(route.path, BASE_URL),
      true,
      `route ${route.kind} ${route.path} is not internal to the Target_Environment`,
    );
  }
});

/* ------------------------------------------------------------------ */
/*  Directed examples                                                  */
/* ------------------------------------------------------------------ */

test("Property 9 (example): canonical internal vs external", () => {
  assert.equal(isInternalUrl(`${BASE_URL}/finops?tab=costs`, BASE_URL), true);
  assert.equal(isInternalUrl("/api/metrics/dora-core", BASE_URL), true);
  // Case-insensitive hostname.
  assert.equal(isInternalUrl(`https://${BASE_HOST.toUpperCase()}/admin`, BASE_URL), true);
  // PROD host (no `dev`) and external domains are rejected.
  assert.equal(isInternalUrl("https://portal.today.tooling.dp.iskaypet.com/finops", BASE_URL), false);
  assert.equal(isInternalUrl("https://google.com", BASE_URL), false);
  // Non-http(s) protocols.
  assert.equal(isInternalUrl("mailto:foo@iskaypet.com", BASE_URL), false);
  assert.equal(isInternalUrl(`javascript:void(0)`, BASE_URL), false);
});
