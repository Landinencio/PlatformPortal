// Feature: iam-role-least-privilege, Property 20: round-trip de permisos actuales (generar → parsear)
/**
 * Property test del round-trip de permisos actuales (generar → parsear).
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/generator.ts
 *   (generateIamRoleHcl → parseRolePresetIds)
 *
 * Property 20: round-trip de permisos actuales (generar → parsear)
 *   ∀ selección no vacía de Preset_IAM DISTINTOS del Catálogo_IAM (ids reales,
 *   cubiertos), el HCL producido por `generateIamRoleHcl` codifica en sus `Sid`
 *   exactamente esos presets. Al reparsear ese HCL con `parseRolePresetIds` se
 *   recupera EXACTAMENTE el conjunto de ids seleccionados — ni más, ni menos.
 *   Este round-trip es la base del flujo de modificación: los permisos actuales
 *   de un rol se derivan del `.tf` generado sin pérdida ni contaminación (6.2).
 *
 * Estrategia de generación: se muestrean subconjuntos de presets reales del
 * catálogo publicado (distintos, vía `shuffledSubarray`) y se construye la
 * selección sin Scope_De_Recurso (cada preset cae a su `defaultArnTemplate`, lo
 * que evita el ruido de la validación de ARNs y no afecta al round-trip por
 * `Sid`). Se permutan roleName/namespace/entornos para variar la forma del HCL.
 * Se afirma que `new Set(parseRolePresetIds(hcl))` es igual al conjunto de ids
 * seleccionados.
 *
 * **Validates: Requirements 6.2**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { generateIamRoleHcl, parseRolePresetIds } from "../iam-catalog/generator";
import type { PresetSelection } from "../iam-catalog/generator";
import { IAM_CATALOG } from "../iam-catalog/catalog";
import type { IamPreset } from "../iam-catalog/catalog";

/** Todos los presets publicados del catálogo (ids reales, únicos y estables). */
const ALL_PRESETS: readonly IamPreset[] = IAM_CATALOG;

/** Máximo de presets distintos por selección (acotado para runs rápidos). */
const MAX_PRESETS_PER_SELECTION = Math.min(8, ALL_PRESETS.length);

/** Conjuntos de entornos destino admisibles (subconjuntos de dev/uat/prod o tooling). */
const ENV_SETS: readonly string[][] = [
  ["dev"],
  ["uat"],
  ["prod"],
  ["dev", "uat"],
  ["dev", "uat", "prod"],
  ["tooling"],
];

// Sanidad: el catálogo debe estar poblado para que la propiedad tenga sentido.
test("Property 20: precondición — el catálogo expone presets", () => {
  assert.ok(ALL_PRESETS.length > 0, "IAM_CATALOG está vacío");
});

/**
 * Arbitrario que produce una selección de presets DISTINTOS del catálogo con sus
 * campos de rol y entornos destino. Sin Scope_De_Recurso (default ARN).
 */
const selectionCaseArb = fc
  .shuffledSubarray(ALL_PRESETS as IamPreset[], {
    minLength: 1,
    maxLength: MAX_PRESETS_PER_SELECTION,
  })
  .chain((presets) =>
    fc.record({
      presets: fc.constant(presets),
      roleName: fc.constantFrom("my-service-role", "oms-worker", "data_pipeline-role"),
      namespace: fc.constantFrom("oms", "n8n", "data-science"),
      environments: fc.constantFrom(...ENV_SETS),
    }),
  );

test("Property 20: parseRolePresetIds(generateIamRoleHcl(sel)) recupera el conjunto exacto de ids", () => {
  fc.assert(
    fc.property(selectionCaseArb, (c) => {
      const { presets, roleName, namespace, environments } = c;

      const selectedIds = presets.map((p) => p.id);
      const expected = new Set(selectedIds);

      const selections: PresetSelection[] = presets.map((p) => ({ presetId: p.id }));

      const result = generateIamRoleHcl({
        roleName,
        namespace,
        selections,
        targetEnvironments: environments,
      });

      assert.ok(result.ok, `la generación no fue ok: ${JSON.stringify(result)}`);

      if (result.ok) {
        const recovered = new Set(parseRolePresetIds(result.hcl));

        // El round-trip recupera exactamente el conjunto seleccionado.
        assert.equal(
          recovered.size,
          expected.size,
          `nº de ids recuperados (${recovered.size}) != seleccionados (${expected.size})`,
        );
        for (const id of expected) {
          assert.ok(recovered.has(id), `falta el preset seleccionado "${id}" tras el round-trip`);
        }
        for (const id of recovered) {
          assert.ok(expected.has(id), `apareció un preset no seleccionado "${id}" tras el round-trip`);
        }
      }
    }),
    { numRuns: 100 },
  );
});
