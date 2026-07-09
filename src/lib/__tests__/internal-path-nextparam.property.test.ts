/**
 * Property test del parámetro `next` construido por `buildNextParam`.
 *
 * Feature: session-nav-hardening
 * Module under test: src/lib/navigation/internal-path.ts
 *
 * Covers:
 *  - Property 2: El parámetro next construido es siempre una ruta interna
 *    válida o vacío.
 *    Para cualquier `pathname` y `search`, `buildNextParam` devuelve o bien la
 *    cadena vacía, o bien un valor tal que `resolveNextParam(valor)` es igual a
 *    `capturePreviousRoute(pathname, search)` y ese valor decodificado es una
 *    ruta interna válida con longitud cruda ≤ 2048.
 *    **Validates: Requirements 3.2**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  buildNextParam,
  resolveNextParam,
  capturePreviousRoute,
  isInternalPath,
  MAX_INTERNAL_PATH_LENGTH,
} from "../navigation/internal-path";

/* ------------------------------------------------------------------ */
/*  Generators: pathname (web-path-like) + search string              */
/* ------------------------------------------------------------------ */

/**
 * `pathname` arbitrario que cubre ambas ramas de `buildNextParam`:
 *  - rutas internas válidas (web-path que empieza por "/"),
 *  - rutas inválidas / adversariales (open-redirect, control chars, vacías,
 *    strings arbitrarios, cadenas > 2048).
 */
const arbPathname = fc.oneof(
  // Rutas internas plausibles generadas por fast-check (empiezan por "/").
  fc.webPath(),
  // Rutas internas construidas a mano con segmentos.
  fc
    .array(fc.stringMatching(/^[A-Za-z0-9\-_.]+$/), { minLength: 1, maxLength: 6 })
    .map((segs) => "/" + segs.join("/")),
  // Casos adversariales / inválidos (deben degradar a "").
  fc.constantFrom(
    "",
    "//evil.com",
    "/\\evil.com",
    "http://evil.com",
    "https://evil.com/x",
    "relative/no-slash",
    "/a\nb",
    "/a\rb",
    "/a\tb",
    "/foo://bar",
  ),
  // Strings totalmente arbitrarios (mayoría inválidos).
  fc.string(),
  // Cadena que supera el tope de 2048 (inválida).
  fc.constant("/" + "a".repeat(MAX_INTERNAL_PATH_LENGTH + 10)),
);

/** `search` arbitrario: ausente, con o sin "?" inicial, o adversarial. */
const arbSearch = fc.option(
  fc.oneof(
    fc.webQueryParameters(),
    fc.string(),
    fc.constantFrom("", "?a=1", "a=1", "?x=%2Fy", "?open=//evil"),
  ),
  { nil: undefined },
);

/* ------------------------------------------------------------------ */
/*  Property 2                                                         */
/* ------------------------------------------------------------------ */

// Feature: session-nav-hardening, Property 2: El parámetro next construido es siempre una ruta interna válida o vacío
test("Property 2: buildNextParam devuelve vacío o un next interno válido y reversible", () => {
  fc.assert(
    fc.property(arbPathname, arbSearch, (pathname, search) => {
      const raw = capturePreviousRoute(pathname, search);
      const next = buildNextParam(pathname, search);

      if (next === "") {
        // Rama vacía: solo ocurre cuando la ruta cruda no es interna válida.
        assert.equal(
          isInternalPath(raw),
          false,
          `buildNextParam devolvió "" para una ruta interna válida: ${JSON.stringify(raw)}`,
        );
        return;
      }

      // Rama no vacía: el valor es totalmente reversible y seguro.

      // (1) resolveNextParam(next) reconstruye exactamente la Ruta_Previa cruda.
      assert.equal(
        resolveNextParam(next),
        raw,
        `resolveNextParam(next) !== capturePreviousRoute (next=${JSON.stringify(next)})`,
      );

      // (2) El valor decodificado es una ruta interna válida.
      const decoded = decodeURIComponent(next);
      assert.equal(
        isInternalPath(decoded),
        true,
        `el next decodificado no es ruta interna válida: ${JSON.stringify(decoded)}`,
      );
      assert.equal(decoded, raw, "el next decodificado no coincide con la ruta cruda");

      // (3) La longitud CRUDA (antes de codificar) respeta el tope de 2048.
      assert.ok(
        raw.length <= MAX_INTERNAL_PATH_LENGTH,
        `longitud cruda ${raw.length} > ${MAX_INTERNAL_PATH_LENGTH}`,
      );
    }),
    { numRuns: 100 },
  );
});
