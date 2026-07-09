// Feature: ai-portal-explorer, Property 1: El entorno objetivo está fijado a desarrollo
/**
 * Property-based test for the Safety_Guard environment check.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/safety-guard.ts
 *
 * Property 1: El entorno objetivo está fijado a desarrollo.
 *   Para toda base URL, `isDevTargetEnvironment` devuelve verdadero SI Y SOLO SI
 *   la URL es una URL http(s) válida cuyo host es el host canónico del
 *   Target_Environment de desarrollo (`portal-dev`,
 *   `portal.today.dev.tooling.dp.iskaypet.com`). En cualquier otro caso (host de
 *   producción, dominios externos, protocolos no http(s), strings malformados)
 *   devuelve falso, de modo que el Explorer abortaría el Exploration_Run antes
 *   de realizar ninguna Visit.
 *
 * **Validates: Requirements 1.2**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/safety-guard.prop01.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { isDevTargetEnvironment, DEV_TARGET_HOST } from "../safety-guard";

/* ------------------------------------------------------------------ */
/*  Arbitraries                                                        */
/* ------------------------------------------------------------------ */

/** Path segments that don't break URL parsing. */
const arbPath: fc.Arbitrary<string> = fc
  .array(fc.stringMatching(/^[a-zA-Z0-9._~-]{1,8}$/), { maxLength: 4 })
  .map((segs) => (segs.length === 0 ? "" : "/" + segs.join("/")));

/** Optional query string like "?a=1&b=foo". */
const arbQuery: fc.Arbitrary<string> = fc
  .array(
    fc.tuple(
      fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,5}$/),
      fc.stringMatching(/^[a-zA-Z0-9]{0,6}$/),
    ),
    { maxLength: 3 },
  )
  .map((pairs) =>
    pairs.length === 0 ? "" : "?" + pairs.map(([k, v]) => `${k}=${v}`).join("&"),
  );

/** Optional :port suffix. */
const arbPort: fc.Arbitrary<string> = fc.option(
  fc.integer({ min: 1, max: 65535 }).map((p) => `:${p}`),
  { nil: "" },
);

/** Case variations of the dev host (hostname comparison is case-insensitive). */
const arbDevHostCasing: fc.Arbitrary<string> = fc
  .array(fc.boolean(), { minLength: DEV_TARGET_HOST.length, maxLength: DEV_TARGET_HOST.length })
  .map((flags) =>
    DEV_TARGET_HOST.split("")
      .map((ch, i) => (flags[i] ? ch.toUpperCase() : ch))
      .join(""),
  );

/** Valid dev-target URLs: http/https, varied casing, port, path, query. */
const arbDevUrl: fc.Arbitrary<string> = fc
  .record({
    scheme: fc.constantFrom("http", "https"),
    host: arbDevHostCasing,
    port: arbPort,
    path: arbPath,
    query: arbQuery,
  })
  .map(({ scheme, host, port, path, query }) => `${scheme}://${host}${port}${path}${query}`);

/** Production / external hosts that must be rejected. */
const NON_DEV_HOSTS = [
  "portal.today.tooling.dp.iskaypet.com", // PROD (no `dev` segment)
  "portal.today.uat.tooling.dp.iskaypet.com",
  "dev.tooling.dp.iskaypet.com",
  "portal.today.dev.tooling.dp.iskaypet.com.evil.com", // suffix attack
  "evil-portal.today.dev.tooling.dp.iskaypet.com", // prefix attack
  "iskaypet.com",
  "localhost",
  "127.0.0.1",
  "example.com",
  "google.com",
  "portal.today.dev.tooling.dp.iskaypet.org", // wrong TLD
];

/** Valid http(s) URLs whose host is NOT the dev target → must be false. */
const arbNonDevUrl: fc.Arbitrary<string> = fc
  .record({
    scheme: fc.constantFrom("http", "https"),
    host: fc.constantFrom(...NON_DEV_HOSTS),
    port: arbPort,
    path: arbPath,
    query: arbQuery,
  })
  .map(({ scheme, host, port, path, query }) => `${scheme}://${host}${port}${path}${query}`);

/** Non-http(s) protocols pointing at the dev host → must be false. */
const arbNonHttpUrl: fc.Arbitrary<string> = fc
  .constantFrom("ftp", "ws", "wss", "file", "data", "javascript", "ssh", "mailto")
  .map((scheme) => `${scheme}://${DEV_TARGET_HOST}/path`);

/** Malformed / non-parseable strings → must be false. */
const arbMalformed: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  fc.constant("   "),
  fc.constant(DEV_TARGET_HOST), // bare host, no scheme → not a valid absolute URL
  fc.constant("not a url"),
  fc.constant("http://"),
  fc.constant("://" + DEV_TARGET_HOST),
  fc.stringMatching(/^[a-zA-Z0-9 ]{0,12}$/),
);

/* ------------------------------------------------------------------ */
/*  Property 1                                                         */
/* ------------------------------------------------------------------ */

test("Property 1: dev-target URLs are accepted (true)", () => {
  fc.assert(
    fc.property(arbDevUrl, (url) => {
      assert.equal(
        isDevTargetEnvironment(url),
        true,
        `expected dev-target URL to be accepted: ${url}`,
      );
    }),
    { numRuns: 100 },
  );
});

test("Property 1: production and external hosts are rejected (false)", () => {
  fc.assert(
    fc.property(arbNonDevUrl, (url) => {
      assert.equal(
        isDevTargetEnvironment(url),
        false,
        `expected non-dev host to be rejected: ${url}`,
      );
    }),
    { numRuns: 100 },
  );
});

test("Property 1: non-http(s) protocols on the dev host are rejected (false)", () => {
  fc.assert(
    fc.property(arbNonHttpUrl, (url) => {
      assert.equal(
        isDevTargetEnvironment(url),
        false,
        `expected non-http(s) protocol to be rejected: ${url}`,
      );
    }),
    { numRuns: 100 },
  );
});

test("Property 1: malformed strings are rejected (false)", () => {
  fc.assert(
    fc.property(arbMalformed, (s) => {
      // A malformed string can never equal a valid dev-target URL.
      assert.equal(
        isDevTargetEnvironment(s),
        false,
        `expected malformed string to be rejected: ${JSON.stringify(s)}`,
      );
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Directed examples                                                  */
/* ------------------------------------------------------------------ */

test("Property 1 (example): canonical dev URL is accepted, prod is rejected", () => {
  assert.equal(isDevTargetEnvironment(`https://${DEV_TARGET_HOST}`), true);
  assert.equal(isDevTargetEnvironment(`https://${DEV_TARGET_HOST}/finops?tab=costs`), true);
  // PROD host (no `dev` segment) must be rejected.
  assert.equal(
    isDevTargetEnvironment("https://portal.today.tooling.dp.iskaypet.com"),
    false,
  );
  // Non-string / empty inputs.
  assert.equal(isDevTargetEnvironment(""), false);
  // @ts-expect-error — defensive: non-string input is rejected.
  assert.equal(isDevTargetEnvironment(undefined), false);
});
