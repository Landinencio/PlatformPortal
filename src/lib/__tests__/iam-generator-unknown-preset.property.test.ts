// Feature: iam-role-least-privilege, Property 17: identificador de preset inexistente aborta la generación
/**
 * Property test de que un identificador de preset inexistente aborta la generación.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/generator.ts (generateIamRoleHcl)
 *
 * Property 17: identificador de preset inexistente aborta la generación
 *   SI la selección referencia al menos un `presetId` inexistente en el
 *   Catálogo_IAM, ENTONCES `generateIamRoleHcl` aborta la generación devolviendo
 *   `{ ok: false, code: "unknown_preset" }` con un `detail` que identifica el id
 *   ausente, y NO produce HCL (no hay campo `hcl` en el resultado). (Requirement 4.9)
 *
 * El espacio de entrada son selecciones que mezclan ids reales del catálogo
 * (rama cubierta) con ≥1 id que no existe (`getPresetById(id) === undefined`),
 * intercalados en una posición arbitraria para no depender del orden. Los
 * campos obligatorios (`roleName`/`namespace`/`targetEnvironments`) siempre son
 * válidos, de modo que la única causa posible de fallo es el preset inexistente.
 *
 * **Validates: Requirements 4.9**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { generateIamRoleHcl } from "../iam-catalog/generator";
import type { PresetSelection } from "../iam-catalog/generator";
import { IAM_CATALOG, getPresetById } from "../iam-catalog/catalog";

/** Ids reales del catálogo publicado. */
const CATALOG_IDS: readonly string[] = IAM_CATALOG.map((p) => p.id);

// Sanidad: el catálogo debe exponer al menos un preset para que la propiedad
// tenga sentido (y de hecho ≥40 por diseño).
test("Property 17: precondición — el catálogo expone presets", () => {
  assert.ok(CATALOG_IDS.length > 0, "IAM_CATALOG no expone ningún preset");
});

/** Selección con un id real del catálogo (con o sin scope). */
const coveredSelectionArb: fc.Arbitrary<PresetSelection> = fc.record({
  presetId: fc.constantFrom(...CATALOG_IDS),
  resourceArns: fc.option(fc.array(fc.string(), { maxLength: 3 }), { nil: undefined }),
});

/** Ids no vacíos que NO existen en el catálogo (verificado contra `getPresetById`). */
const unknownIdArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((id) => id.trim().length > 0 && getPresetById(id) === undefined);

/** Selección con un id inexistente en el catálogo. */
const unknownSelectionArb: fc.Arbitrary<PresetSelection> = fc.record({
  presetId: unknownIdArb,
  resourceArns: fc.option(fc.array(fc.string(), { maxLength: 3 }), { nil: undefined }),
});

/** Campos obligatorios siempre válidos: la única causa de fallo es el preset. */
const roleNameArb: fc.Arbitrary<string> = fc.constantFrom(
  "my-service",
  "oms-consumer",
  "payments_worker",
  "data-etl-role",
);
const namespaceArb: fc.Arbitrary<string> = fc.constantFrom("oms", "payments", "data-science", "n8n");
const targetEnvsArb: fc.Arbitrary<string[]> = fc.constantFrom(
  ["dev"],
  ["dev", "uat"],
  ["dev", "uat", "prod"],
  ["tooling"],
);

/** Comparación por code points (misma que usa el generador para elegir el reportado). */
function byCodePoints(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

test("Property 17: selección con id inexistente → unknown_preset sin HCL", () => {
  fc.assert(
    fc.property(
      fc.array(coveredSelectionArb, { minLength: 0, maxLength: 8 }),
      fc.array(unknownSelectionArb, { minLength: 1, maxLength: 3 }),
      fc.integer({ min: 0, max: 11 }),
      roleNameArb,
      namespaceArb,
      targetEnvsArb,
      (covered, unknown, insertAt, roleName, namespace, targetEnvironments) => {
        // Intercalar las selecciones desconocidas en una posición arbitraria
        // para no depender del orden de entrada.
        const merged = [...covered];
        const pos = Math.min(insertAt, merged.length);
        merged.splice(pos, 0, ...unknown);

        const result = generateIamRoleHcl({
          roleName,
          namespace,
          selections: merged,
          targetEnvironments,
        });

        // Aborta: ok === false con code unknown_preset.
        assert.equal(result.ok, false, "debería abortar con ok === false");
        assert.equal(
          (result as { code: string }).code,
          "unknown_preset",
          `code esperado unknown_preset, recibido: ${JSON.stringify(result)}`,
        );

        // No produce HCL (no hay campo hcl en el resultado de error).
        assert.equal(
          "hcl" in result,
          false,
          "el resultado de error no debe incluir campo hcl",
        );

        // El detail identifica un id ausente. El generador reporta el id ausente
        // menor por code points; comprobamos que ese id aparece en el detail.
        const detail = (result as { detail: string }).detail;
        assert.equal(typeof detail, "string");
        const distinctUnknown = [...new Set(unknown.map((s) => s.presetId))].sort(byCodePoints);
        const smallestMissing = distinctUnknown[0];
        assert.ok(
          detail.includes(smallestMissing),
          `el detail "${detail}" debería identificar el id ausente "${smallestMissing}"`,
        );
      },
    ),
    { numRuns: 100 },
  );
});
