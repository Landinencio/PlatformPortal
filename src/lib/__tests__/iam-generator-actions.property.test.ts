// Feature: iam-role-least-privilege, Property 14: la política sólo contiene acciones de los presets seleccionados
/**
 * Property test de que la política sólo contiene acciones de los presets seleccionados.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/generator.ts (generateIamRoleHcl)
 *
 * Property 14: la política sólo contiene acciones de los presets seleccionados
 *   Para toda selección de Preset_IAM cubierta por el Catálogo_IAM, el conjunto
 *   de acciones IAM presentes en la Politica_Generada (los campos `Action` de
 *   todos los `Statement` del HCL emitido) es EXACTAMENTE la unión de las
 *   acciones declaradas por los presets seleccionados: ni una acción de más
 *   (ninguna acción ajena a los presets), ni una de menos (todas las acciones
 *   de los presets seleccionados aparecen).
 *
 * Se seleccionan presets SIN Scope_De_Recurso (se usa el `defaultArnTemplate`
 * de cada preset) para garantizar una generación válida con independencia del
 * preset elegido; la propiedad bajo prueba es sobre las acciones, no sobre el
 * scope. Las selecciones se muestrean como subconjuntos no vacíos de ids reales
 * del catálogo publicado.
 *
 * **Validates: Requirements 4.4**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { generateIamRoleHcl } from "../iam-catalog/generator";
import { IAM_CATALOG, getPresetById } from "../iam-catalog/catalog";

/** Ids de todos los presets publicados del catálogo. */
const PRESET_IDS: readonly string[] = IAM_CATALOG.map((p) => p.id);

// Sanidad: el catálogo debe exponer presets para que la propiedad tenga sentido.
test("Property 14: precondición — el catálogo expone presets", () => {
  assert.ok(PRESET_IDS.length > 0, "IAM_CATALOG no expone ningún preset");
});

/**
 * Extrae de un HCL generado el conjunto de todas las acciones IAM presentes en
 * los campos `Action = [ ... ]` de los Statement. Parseo textual: localiza cada
 * bloque `Action = [...]` y recolecta las cadenas entrecomilladas de su interior.
 */
function parseActionsFromHcl(hcl: string): Set<string> {
  const actions = new Set<string>();
  const blockRe = /Action\s*=\s*\[([\s\S]*?)\]/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(hcl)) !== null) {
    const inner = block[1];
    const strRe = /"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = strRe.exec(inner)) !== null) {
      actions.add(m[1]);
    }
  }
  return actions;
}

test("Property 14: las acciones del HCL son la unión exacta de las de los presets seleccionados", () => {
  fc.assert(
    fc.property(
      // Subconjunto no vacío de ids reales del catálogo (sin duplicados).
      fc.uniqueArray(fc.constantFrom(...PRESET_IDS), { minLength: 1 }),
      // Nombre de rol y namespace no vacíos; entornos destino no vacíos.
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      fc.uniqueArray(fc.constantFrom("dev", "uat", "prod"), { minLength: 1 }),
      (presetIds, roleName, namespace, targetEnvironments) => {
        const selections = presetIds.map((presetId) => ({ presetId }));

        const result = generateIamRoleHcl({
          roleName,
          namespace,
          selections,
          targetEnvironments,
        });

        // La selección está cubierta por el catálogo → la generación debe tener éxito.
        assert.equal(
          result.ok,
          true,
          `esperaba generación exitosa, obtuve: ${JSON.stringify(result)}`,
        );
        if (!result.ok) return;

        // Unión esperada: todas las acciones de los presets seleccionados.
        const expected = new Set<string>();
        for (const id of presetIds) {
          const preset = getPresetById(id);
          assert.ok(preset, `preset ausente inesperadamente: ${id}`);
          for (const action of preset.actions) expected.add(action);
        }

        const actual = parseActionsFromHcl(result.hcl);

        // Ni más (ninguna acción ajena a los presets)…
        for (const action of actual) {
          assert.ok(
            expected.has(action),
            `acción ajena en la política: "${action}" no pertenece a los presets seleccionados`,
          );
        }
        // …ni menos (todas las acciones de los presets aparecen).
        for (const action of expected) {
          assert.ok(
            actual.has(action),
            `falta en la política una acción de preset: "${action}"`,
          );
        }
        // Igualdad exacta de conjuntos.
        assert.deepEqual(
          new Set(actual),
          expected,
          "el conjunto de acciones de la política debe ser la unión exacta de los presets",
        );
      },
    ),
    { numRuns: 100 },
  );
});
