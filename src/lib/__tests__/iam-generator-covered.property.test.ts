// Feature: iam-role-least-privilege, Property 11: cobertura del catálogo decide el camino
/**
 * Property test de que la cobertura del catálogo decide el camino.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/generator.ts (isCoveredByCatalog)
 *
 * Property 11: cobertura del catálogo decide el camino
 *   La cobertura de una selección respecto al Catálogo_IAM decide el camino de
 *   generación (determinista vs. delegación al Infra_Agent):
 *     - SI toda `PresetSelection` referencia un `presetId` presente en
 *       `IAM_CATALOG`, ENTONCES `isCoveredByCatalog(selections) === true` (4.1).
 *     - SI la selección incluye al menos un `presetId` ausente del catálogo,
 *       ENTONCES `isCoveredByCatalog(selections) === false` (4.5).
 *
 * El espacio de entrada son listas de selecciones formadas por ids reales del
 * catálogo (rama cubierta) y listas que además contienen al menos un id que no
 * existe en el catálogo (rama no cubierta). `fast-check` muestrea ambos casos.
 *
 * **Validates: Requirements 4.1, 4.5**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { isCoveredByCatalog } from "../iam-catalog/generator";
import type { PresetSelection } from "../iam-catalog/generator";
import { IAM_CATALOG, getPresetById } from "../iam-catalog/catalog";

/** Ids reales del catálogo publicado. */
const CATALOG_IDS: readonly string[] = IAM_CATALOG.map((p) => p.id);

// Sanidad: el catálogo debe exponer al menos un preset para que la propiedad
// tenga sentido (y de hecho ≥40 por diseño).
test("Property 11: precondición — el catálogo expone presets", () => {
  assert.ok(CATALOG_IDS.length > 0, "IAM_CATALOG no expone ningún preset");
});

/** Selección con un id real del catálogo (con o sin scope). */
const coveredSelectionArb: fc.Arbitrary<PresetSelection> = fc.record({
  presetId: fc.constantFrom(...CATALOG_IDS),
  resourceArns: fc.option(fc.array(fc.string(), { maxLength: 3 }), { nil: undefined }),
});

/** Ids que NO existen en el catálogo (verificado contra `getPresetById`). */
const unknownIdArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((id) => getPresetById(id) === undefined);

/** Selección con un id inexistente en el catálogo. */
const unknownSelectionArb: fc.Arbitrary<PresetSelection> = fc.record({
  presetId: unknownIdArb,
  resourceArns: fc.option(fc.array(fc.string(), { maxLength: 3 }), { nil: undefined }),
});

test("Property 11: selección con todos los ids del catálogo → cubierta (true)", () => {
  fc.assert(
    fc.property(
      fc.array(coveredSelectionArb, { minLength: 1, maxLength: 10 }),
      (selections) => {
        assert.equal(
          isCoveredByCatalog(selections),
          true,
          `selección con ids reales debería estar cubierta: ${JSON.stringify(
            selections.map((s) => s.presetId),
          )}`,
        );
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 11: selección con algún id ausente → no cubierta (false)", () => {
  fc.assert(
    fc.property(
      // 0..10 selecciones cubiertas + ≥1 selección con id inexistente, mezcladas.
      fc.array(coveredSelectionArb, { minLength: 0, maxLength: 10 }),
      fc.array(unknownSelectionArb, { minLength: 1, maxLength: 3 }),
      fc.integer({ min: 0, max: 13 }),
      (covered, unknown, insertAt) => {
        // Intercalar las selecciones desconocidas en una posición arbitraria
        // para no depender del orden.
        const merged = [...covered];
        const pos = Math.min(insertAt, merged.length);
        merged.splice(pos, 0, ...unknown);

        assert.equal(
          isCoveredByCatalog(merged),
          false,
          `selección con id(s) ausente(s) NO debería estar cubierta: ${JSON.stringify(
            unknown.map((s) => s.presetId),
          )}`,
        );
      },
    ),
    { numRuns: 100 },
  );
});
