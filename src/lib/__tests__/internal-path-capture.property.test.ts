// Feature: session-nav-hardening, Property 3: La captura de la Ruta_Previa es determinista
/**
 * Property test para la captura determinista de la Ruta_Previa.
 *
 * Feature: session-nav-hardening
 * Module under test: src/lib/navigation/internal-path.ts (`capturePreviousRoute`)
 *
 * Property 3: La captura de la Ruta_Previa es determinista
 *   ∀ (pathname, search): `capturePreviousRoute(pathname, search)` es
 *   determinista e igual a `pathname` concatenado con `search`, anteponiendo
 *   `?` únicamente cuando `search` es no vacío y no comienza ya por `?`,
 *   sin depender de estado externo (dos llamadas iguales dan el mismo valor).
 *
 * **Validates: Requirements 4.1**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { capturePreviousRoute } from "../navigation/internal-path";

/**
 * Generador de `pathname`: rutas plausibles (con "/" inicial) y también cadenas
 * arbitrarias, para explorar el espacio de entrada sin asumir validez.
 */
const pathnameArb: fc.Arbitrary<string> = fc.oneof(
  fc.webPath(),
  fc.string(),
  fc.constantFrom("/", "/finops", "/metrics/dora", "/tickets"),
);

/**
 * Generador de `search`: incluye vacío, con `?` inicial, sin `?` inicial y
 * cadenas arbitrarias, para cubrir las tres ramas de concatenación.
 */
const searchArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  fc.string(),
  fc.string().map((s) => "?" + s),
  fc.constantFrom("?a=1", "?a=1&b=2", "tab=costs", "x=%20"),
);

/** Modelo de referencia independiente de la implementación. */
function expected(pathname: string, search?: string): string {
  if (!search) return pathname;
  if (search.startsWith("?")) return pathname + search;
  return pathname + "?" + search;
}

test("Property 3: capturePreviousRoute concatena pathname + search anteponiendo `?` solo si procede", () => {
  fc.assert(
    fc.property(pathnameArb, searchArb, (pathname, search) => {
      assert.equal(capturePreviousRoute(pathname, search), expected(pathname, search));
    }),
    { numRuns: 100 },
  );
});

test("Property 3: capturePreviousRoute es determinista — dos llamadas iguales dan el mismo resultado", () => {
  fc.assert(
    fc.property(pathnameArb, searchArb, (pathname, search) => {
      const first = capturePreviousRoute(pathname, search);
      const second = capturePreviousRoute(pathname, search);
      assert.equal(first, second);
    }),
    { numRuns: 100 },
  );
});

test("Property 3: search omitido (undefined) devuelve el pathname tal cual", () => {
  fc.assert(
    fc.property(pathnameArb, (pathname) => {
      assert.equal(capturePreviousRoute(pathname), pathname);
    }),
    { numRuns: 100 },
  );
});
