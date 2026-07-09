/**
 * Property test — resolución del destino del Boton_Volver.
 *
 * Feature: session-nav-hardening, Property 8: La resolución del destino del Boton_Volver es total y segura
 *
 * Module under test: src/lib/navigation/back-target.ts
 *
 * Property 8: Para CUALQUIER valor de `destination` (`undefined`, ruta interna
 * válida o string arbitrario inválido), `resolveBackTarget` devuelve:
 *  - `{ kind: "history-or-home" }` cuando `destination` es `undefined`;
 *  - `{ kind: "explicit", path: destination }` cuando `destination` es una ruta
 *    interna válida;
 *  - `{ kind: "explicit", path: "/" }` cuando `destination` está presente pero
 *    no es una ruta interna válida.
 * Nunca produce un destino externo.
 *
 * **Validates: Requirements 5.6, 5.7, 5.8**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { resolveBackTarget } from "../navigation/back-target";
import { isInternalPath, MAX_INTERNAL_PATH_LENGTH } from "../navigation/internal-path";

const RUNS = { numRuns: 100 } as const;

/* ------------------------------------------------------------------ */
/*  Generadores                                                        */
/* ------------------------------------------------------------------ */

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

/** Strings presentes pero inválidos como ruta interna (open-redirect, control chars, no "/"). */
const arbInvalidString = fc
  .oneof(
    fc.constantFrom(
      "//x",
      "/\\x",
      "http://evil",
      "/a\nb",
      "/a\rb",
      "/a\tb",
      "//evil.com",
      "/\\evil.com",
      "https://evil.com/path",
      "/foo\r\nbar",
      "",
      "relative/path",
      "javascript:alert(1)",
      "foo://bar",
    ),
    arbTooLong,
    fc.string().filter((s) => !isInternalPath(s)),
  )
  .filter((s) => !isInternalPath(s));

/* ------------------------------------------------------------------ */
/*  Property 8                                                         */
/* ------------------------------------------------------------------ */

test("Property 8: destination undefined → { kind: 'history-or-home' }", () => {
  const target = resolveBackTarget(undefined);
  assert.deepEqual(target, { kind: "history-or-home" });
});

test("Property 8: destination interno válido → { kind: 'explicit', path: destination }", () => {
  fc.assert(
    fc.property(arbValidPath, (path) => {
      const target = resolveBackTarget(path);
      assert.deepEqual(target, { kind: "explicit", path });
    }),
    RUNS,
  );
});

test("Property 8: destination presente pero inválido → { kind: 'explicit', path: '/' }", () => {
  fc.assert(
    fc.property(arbInvalidString, (invalid) => {
      const target = resolveBackTarget(invalid);
      assert.deepEqual(target, { kind: "explicit", path: "/" });
    }),
    RUNS,
  );
});

test("Property 8: resolveBackTarget es total y nunca produce un destino externo", () => {
  const arbDestination: fc.Arbitrary<string | undefined> = fc.oneof(
    fc.constant(undefined),
    arbValidPath,
    arbInvalidString,
    fc.string(),
  );

  fc.assert(
    fc.property(arbDestination, (destination) => {
      const target = resolveBackTarget(destination);
      // El resultado pertenece SIEMPRE al conjunto discriminado esperado.
      assert.ok(target.kind === "history-or-home" || target.kind === "explicit");
      if (target.kind === "explicit") {
        // Un destino explícito es SIEMPRE una ruta interna válida (nunca externo).
        assert.equal(isInternalPath(target.path), true);
      }
    }),
    RUNS,
  );
});
