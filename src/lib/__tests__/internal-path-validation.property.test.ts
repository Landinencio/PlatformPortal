/**
 * Property test — validación total de ruta interna y anti open-redirect.
 *
 * Feature: session-nav-hardening, Property 1: La validación de ruta interna es total y nunca permite open-redirect
 *
 * Module under test: src/lib/navigation/internal-path.ts
 *
 * Property 1: Para CUALQUIER entrada arbitraria (string, null, undefined o
 * valor no-string), `isInternalPath` termina devolviendo un booleano sin lanzar,
 * y `sanitizeInternalPath`/`resolveNextParam` devuelven SIEMPRE una ruta interna
 * válida: o bien la propia entrada cuando `isInternalPath` es true, o bien "/".
 * En particular, para toda entrada que empiece por "//", por "/\\", que contenga
 * "://", que contenga "\r", "\n" o "\t", que esté vacía, que no empiece por un
 * único "/", o que exceda 2048 caracteres, el resultado saneado es exactamente
 * "/" (nunca un host externo).
 *
 * **Validates: Requirements 3.3, 3.4, 4.2, 4.3, 5.8**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  isInternalPath,
  sanitizeInternalPath,
  resolveNextParam,
  MAX_INTERNAL_PATH_LENGTH,
} from "../navigation/internal-path";

const RUNS = { numRuns: 100 } as const;

/* ------------------------------------------------------------------ */
/*  Generadores                                                        */
/* ------------------------------------------------------------------ */

/** Strings arbitrarios (incluye vacíos, control chars, unicode). */
const arbAnyString = fc.string();

/** Vectores de ataque / entradas peligrosas conocidas. */
const arbAttack = fc.constantFrom(
  "//x",
  "/\\x",
  "http://evil",
  "/a\nb",
  "//evil.com",
  "/\\evil.com",
  "https://evil.com/path",
  "/foo\r\nbar",
  "/foo\tbar",
  "",
  "relative/path",
  "javascript:alert(1)",
);

/** Rutas internas válidas: "/" + segmentos sin caracteres prohibidos. */
const arbValidPath = fc
  .array(
    fc.stringMatching(/^[a-zA-Z0-9._~%!$&'()*+,;=:@-]+$/).filter((s) => s.length > 0),
    { minLength: 0, maxLength: 6 },
  )
  .map((segments) => "/" + segments.join("/"))
  .filter((p) => isInternalPath(p));

/** Cadenas por encima del tope de 2048 caracteres. */
const arbTooLong = fc
  .integer({ min: MAX_INTERNAL_PATH_LENGTH + 1, max: MAX_INTERNAL_PATH_LENGTH + 512 })
  .map((n) => "/" + "a".repeat(n));

/** Entradas no-string. */
const arbNonString = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.boolean(),
  fc.object(),
  fc.array(fc.anything()),
);

/** Universo unificado de entradas para las funciones que aceptan `unknown`. */
const arbCandidate: fc.Arbitrary<unknown> = fc.oneof(
  arbAnyString,
  arbAttack,
  arbValidPath,
  arbTooLong,
  arbNonString,
);

/* ------------------------------------------------------------------ */
/*  Property 1                                                         */
/* ------------------------------------------------------------------ */

test("Property 1: isInternalPath es total y devuelve siempre un booleano sin lanzar", () => {
  fc.assert(
    fc.property(arbCandidate, (candidate) => {
      const result = isInternalPath(candidate);
      assert.equal(typeof result, "boolean");
    }),
    RUNS,
  );
});

test("Property 1: sanitizeInternalPath devuelve la entrada si es válida, o exactamente '/'", () => {
  fc.assert(
    fc.property(arbCandidate, (candidate) => {
      const sanitized = sanitizeInternalPath(candidate);
      if (isInternalPath(candidate)) {
        assert.equal(sanitized, candidate);
      } else {
        assert.equal(sanitized, "/");
      }
      // El resultado saneado es SIEMPRE una ruta interna válida.
      assert.equal(isInternalPath(sanitized), true);
    }),
    RUNS,
  );
});

test("Property 1: resolveNextParam devuelve siempre una ruta interna válida (o '/')", () => {
  fc.assert(
    fc.property(arbCandidate, (candidate) => {
      const resolved = resolveNextParam(candidate);
      // Nunca produce un host externo: el resultado es siempre ruta interna válida.
      assert.equal(isInternalPath(resolved), true);
    }),
    RUNS,
  );
});

test("Property 1: entradas peligrosas / vacías / > 2048 se sanean exactamente a '/'", () => {
  const arbDangerous = fc.oneof(
    fc.constantFrom(
      "//x",
      "/\\x",
      "http://evil",
      "/a\nb",
      "/a\rb",
      "/a\tb",
      "//evil.com",
      "/\\evil.com",
      "https://evil.com",
      "",
      "relative",
      "foo://bar",
    ),
    arbTooLong,
    // strings arbitrarios que NO son rutas internas válidas
    arbAnyString.filter((s) => !isInternalPath(s)),
  );

  fc.assert(
    fc.property(arbDangerous, (dangerous) => {
      assert.equal(isInternalPath(dangerous), false);
      assert.equal(sanitizeInternalPath(dangerous), "/");
    }),
    RUNS,
  );
});

test("Property 1: resolveNextParam de un next válido codificado recupera la ruta interna", () => {
  fc.assert(
    fc.property(arbValidPath, (path) => {
      const encoded = encodeURIComponent(path);
      const resolved = resolveNextParam(encoded);
      assert.equal(isInternalPath(resolved), true);
      assert.equal(resolved, path);
    }),
    RUNS,
  );
});
