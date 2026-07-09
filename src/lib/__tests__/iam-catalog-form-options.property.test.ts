// Feature: iam-role-least-privilege, Property 5: opciones de formulario deterministas e idénticas entre flujos
/**
 * Property test de opciones de formulario deterministas e idénticas entre flujos.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/catalog.ts (buildFormOptions)
 *
 * Property 5: opciones de formulario deterministas e idénticas entre flujos
 *   Para todo catálogo, `buildFormOptions(catálogo)` produce exactamente los
 *   presets del catálogo (los mismos identificadores), en un orden estable; y
 *   dos invocaciones sobre la misma entrada son idénticas en contenido y orden
 *   (una única fuente compartida por el Formulario_Creacion y el
 *   Formulario_Modificacion, 2.4/2.5).
 *
 * Estrategia de generación: se muestrean permutaciones del catálogo publicado
 * `IAM_CATALOG` para confirmar que el orden de salida es INDEPENDIENTE del orden
 * de entrada (determinismo de orden). El conjunto de ids de salida debe coincidir
 * exactamente con el del catálogo de entrada, y dos invocaciones consecutivas
 * deben ser deep-equal.
 *
 * **Validates: Requirements 2.4, 2.5**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { IAM_CATALOG, buildFormOptions } from "../iam-catalog/catalog";
import type { IamPreset, PresetFormOption } from "../iam-catalog/catalog";

/** Conjunto de ids del catálogo publicado (fuente de verdad para comparación). */
const CATALOG_IDS: readonly string[] = IAM_CATALOG.map((p) => p.id);

/** Comparación de igualdad de secuencias de opciones (contenido + orden). */
function sameOptions(
  a: readonly PresetFormOption[],
  b: readonly PresetFormOption[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.service !== y.service ||
      x.family !== y.family ||
      x.accessLevel !== y.accessLevel ||
      x.labelKey !== y.labelKey ||
      x.scopable !== y.scopable ||
      x.allowWildcards !== y.allowWildcards
    ) {
      return false;
    }
  }
  return true;
}

// Sanidad: el catálogo debe exponer presets para que la propiedad tenga sentido.
test("Property 5: precondición — el catálogo expone presets", () => {
  assert.ok(CATALOG_IDS.length > 0, "IAM_CATALOG no expone ningún preset");
});

test("Property 5: buildFormOptions produce exactamente los ids del catálogo", () => {
  fc.assert(
    fc.property(
      fc.shuffledSubarray(IAM_CATALOG as IamPreset[], {
        minLength: IAM_CATALOG.length,
        maxLength: IAM_CATALOG.length,
      }),
      (permuted) => {
        const options = buildFormOptions(permuted);

        // (1) Mismos ids que el catálogo de entrada (ni más, ni menos).
        const outIds = new Set(options.map((o) => o.id));
        const inIds = new Set(permuted.map((p) => p.id));
        assert.equal(
          outIds.size,
          inIds.size,
          "el número de ids de salida difiere del de entrada",
        );
        for (const id of inIds) {
          assert.ok(outIds.has(id), `falta el id "${id}" en las opciones`);
        }
        assert.equal(
          options.length,
          permuted.length,
          "buildFormOptions no conserva la cardinalidad del catálogo",
        );
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 5: el orden de salida es estable e independiente del orden de entrada", () => {
  fc.assert(
    fc.property(
      fc.shuffledSubarray(IAM_CATALOG as IamPreset[], {
        minLength: IAM_CATALOG.length,
        maxLength: IAM_CATALOG.length,
      }),
      fc.shuffledSubarray(IAM_CATALOG as IamPreset[], {
        minLength: IAM_CATALOG.length,
        maxLength: IAM_CATALOG.length,
      }),
      (permA, permB) => {
        // Dos permutaciones distintas de la misma entrada → misma salida (orden estable).
        const optsA = buildFormOptions(permA);
        const optsB = buildFormOptions(permB);
        assert.ok(
          sameOptions(optsA, optsB),
          "el orden de salida depende del orden de entrada",
        );
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 5: dos invocaciones sobre la misma entrada son deep-equal", () => {
  fc.assert(
    fc.property(
      fc.shuffledSubarray(IAM_CATALOG as IamPreset[], {
        minLength: IAM_CATALOG.length,
        maxLength: IAM_CATALOG.length,
      }),
      (permuted) => {
        const first = buildFormOptions(permuted);
        const second = buildFormOptions(permuted);
        assert.ok(
          sameOptions(first, second),
          "dos invocaciones idénticas producen resultados distintos",
        );
        // Contenido y orden byte a byte vía JSON (comparación estructural fuerte).
        assert.deepEqual(
          JSON.parse(JSON.stringify(first)),
          JSON.parse(JSON.stringify(second)),
          "las opciones no son deep-equal entre invocaciones",
        );
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 5: fuente compartida crear/modificar — misma salida que el catálogo canónico", () => {
  // El Formulario_Creacion y el Formulario_Modificacion invocan la MISMA función
  // sobre el MISMO catálogo → obtienen exactamente las mismas opciones (2.5).
  const create = buildFormOptions(IAM_CATALOG);
  const modify = buildFormOptions(IAM_CATALOG);
  assert.ok(
    sameOptions(create, modify),
    "las opciones de creación y modificación divergen",
  );
});
