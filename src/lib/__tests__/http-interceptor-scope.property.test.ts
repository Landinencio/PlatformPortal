/**
 * Property test — ámbito de interceptación del Interceptor_HTTP.
 *
 * Feature: session-nav-hardening, Property 5: La interceptación cubre exactamente mismo-origen /api/ excluyendo /api/auth/
 *
 * Module under test: src/lib/session/http-interceptor-core.ts
 *
 * Property 5: Para CUALQUIER URL (relativa o absoluta) y origen,
 * `shouldInterceptApiUrl(url, origin)` devuelve `true` SI Y SOLO SI la URL
 * resuelve al mismo origen, su path empieza por `/api/` y NO empieza por
 * `/api/auth/`. Cualquier URL de otro origen, con path que no empiece por
 * `/api/`, o bajo `/api/auth/`, devuelve `false`, con independencia del
 * método HTTP.
 *
 * **Validates: Requirements 2.1, 2.4**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { shouldInterceptApiUrl } from "../session/http-interceptor-core";

const RUNS = { numRuns: 100 } as const;

/* ------------------------------------------------------------------ */
/*  Generadores                                                        */
/* ------------------------------------------------------------------ */

/** Métodos HTTP: el ámbito es independiente del método (no se inspecciona). */
const arbMethod = fc.constantFrom(
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
);

/** Orígenes válidos del Portal (esquema + host [+ puerto]). */
const arbOrigin = fc.constantFrom(
  "https://portal.today.tooling.dp.iskaypet.com",
  "https://portal.today.dev.tooling.dp.iskaypet.com",
  "http://localhost:3000",
  "https://example.com",
  "http://127.0.0.1:8080",
);

/** Segmentos de path seguros (sin separadores ni caracteres de control). */
const arbSegment = fc
  .stringMatching(/^[a-zA-Z0-9._~!$&'()*+,;=:@-]+$/)
  .filter((s) => s.length > 0);

/** Cola de path: 0..5 segmentos unidos por "/" (posible query añadida aparte). */
const arbTail = fc
  .array(arbSegment, { minLength: 0, maxLength: 5 })
  .map((segs) => segs.join("/"));

/** Query string opcional (incluye vacío). */
const arbQuery = fc.oneof(
  fc.constant(""),
  fc.constant("?"),
  arbSegment.map((s) => `?q=${s}`),
  fc.tuple(arbSegment, arbSegment).map(([a, b]) => `?a=${a}&b=${b}`),
);

/** Paths que DEBEN interceptarse: `/api/<algo-no-auth>`. */
const arbInterceptablePath = fc
  .tuple(
    arbSegment.filter((s) => s !== "auth"),
    arbTail,
    arbQuery,
  )
  .map(([first, tail, query]) => {
    const rest = tail.length > 0 ? `/${tail}` : "";
    return `/api/${first}${rest}${query}`;
  });

/** Paths bajo `/api/auth/` — NUNCA se interceptan. */
const arbAuthPath = fc
  .tuple(arbTail, arbQuery)
  .map(([tail, query]) => {
    const rest = tail.length > 0 ? `/${tail}` : "";
    return `/api/auth/${rest}${query}`.replace("//", "/");
  })
  .map((p) => (p.startsWith("/api/auth") ? p : "/api/auth/x"));

/** Paths que NO son `/api/*` — no se interceptan. */
const arbNonApiPath = fc.oneof(
  fc.constantFrom(
    "/",
    "/finops",
    "/metrics",
    "/apix/foo", // "api" como prefijo pero no segmento "/api/"
    "/api", // sin barra final: no es "/api/"
    "/apidocs",
    "/health",
    "/static/app.js",
  ),
  fc.tuple(arbSegment.filter((s) => s !== "api"), arbTail).map(([first, tail]) => {
    const rest = tail.length > 0 ? `/${tail}` : "";
    return `/${first}${rest}`;
  }),
);

/** Orígenes cross-origin distintos del origen del Portal. */
const arbCrossOrigin = fc.constantFrom(
  "https://evil.com",
  "http://evil.com",
  "https://api.other.com",
  "https://iskaypet.com",
  "http://localhost:4000",
);

/* ------------------------------------------------------------------ */
/*  Property 5                                                         */
/* ------------------------------------------------------------------ */

test("Property 5: es total — devuelve booleano sin lanzar para cualquier url/origen", () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), (url, origin) => {
      const result = shouldInterceptApiUrl(url, origin);
      assert.equal(typeof result, "boolean");
    }),
    RUNS,
  );
});

test("Property 5: intercepta mismo-origen /api/ (no /api/auth/), relativa e independiente del método", () => {
  fc.assert(
    fc.property(arbOrigin, arbInterceptablePath, arbMethod, (origin, path, _method) => {
      // Relativa al origen.
      assert.equal(shouldInterceptApiUrl(path, origin), true);
      // Absoluta al mismo origen: mismo resultado.
      assert.equal(shouldInterceptApiUrl(origin + path, origin), true);
    }),
    RUNS,
  );
});

test("Property 5: NO intercepta /api/auth/* (mismo origen), relativa ni absoluta", () => {
  fc.assert(
    fc.property(arbOrigin, arbAuthPath, arbMethod, (origin, path, _method) => {
      assert.equal(shouldInterceptApiUrl(path, origin), false);
      assert.equal(shouldInterceptApiUrl(origin + path, origin), false);
    }),
    RUNS,
  );
});

test("Property 5: NO intercepta paths que no empiezan por /api/ (mismo origen)", () => {
  fc.assert(
    fc.property(arbOrigin, arbNonApiPath, (origin, path) => {
      assert.equal(shouldInterceptApiUrl(path, origin), false);
      assert.equal(shouldInterceptApiUrl(origin + path, origin), false);
    }),
    RUNS,
  );
});

test("Property 5: NO intercepta cross-origin aunque el path sea /api/*", () => {
  fc.assert(
    fc.property(arbOrigin, arbCrossOrigin, arbInterceptablePath, (origin, other, path) => {
      fc.pre(other !== origin);
      // URL absoluta a OTRO origen: nunca se intercepta.
      assert.equal(shouldInterceptApiUrl(other + path, origin), false);
    }),
    RUNS,
  );
});

test("Property 5: equivalencia con la especificación (iff mismo-origen && /api/ && !/api/auth/)", () => {
  const arbAnyPath = fc.oneof(arbInterceptablePath, arbAuthPath, arbNonApiPath);

  fc.assert(
    fc.property(arbOrigin, arbAnyPath, (origin, path) => {
      const absolute = origin + path;
      // Modelo de referencia sobre la URL absoluta mismo-origen.
      const resolved = new URL(absolute);
      const expected =
        resolved.origin === origin &&
        resolved.pathname.startsWith("/api/") &&
        !resolved.pathname.startsWith("/api/auth/");

      assert.equal(shouldInterceptApiUrl(absolute, origin), expected);
      assert.equal(shouldInterceptApiUrl(path, origin), expected);
    }),
    RUNS,
  );
});
