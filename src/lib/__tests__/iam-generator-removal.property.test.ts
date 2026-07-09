// Feature: iam-role-least-privilege, Property 22: quitar permisos preserva el complemento exacto
/**
 * Property test de que quitar permisos preserva el complemento exacto.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/generator.ts
 *   (applyRemoval, generateIamRoleHcl, parseRolePresetIds)
 *
 * Property 22: quitar permisos preserva el complemento exacto
 *   ∀ conjunto de permisos actuales (ids de preset reales del Catálogo_IAM) y
 *   ∀ subconjunto a quitar, el rol regenerado tras `applyRemoval` contiene
 *   EXACTAMENTE los permisos actuales menos los seleccionados para quitar; los
 *   permisos no seleccionados permanecen sin cambios (6.7). Es decir:
 *     kept = applyRemoval(current, remove)
 *     ids(generateIamRoleHcl(kept)) === set(current) \ set(remove)
 *   El round-trip generar → parsear (`parseRolePresetIds`) es la evidencia de que
 *   el HCL resultante refleja exactamente el complemento, sin añadir ni perder
 *   presets. Cuando el complemento es vacío, la generación no produce HCL sino
 *   `{ ok: false, code: "empty_selection" }` (no hay rol que emitir).
 *
 * Estrategia de generación: `current` es un subconjunto no vacío de ids DISTINTOS
 * del catálogo publicado; `remove` es un subconjunto (posiblemente vacío, posible-
 * mente total) de `current` mezclado con ids-ruido ausentes del conjunto actual
 * (que no deben afectar al complemento). Los presets se generan con su
 * `defaultArnTemplate` (sin scope explícito), suficiente para un HCL válido.
 *
 * **Validates: Requirements 6.7**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  applyRemoval,
  generateIamRoleHcl,
  parseRolePresetIds,
} from "../iam-catalog/generator";
import type { PresetSelection } from "../iam-catalog/generator";
import { IAM_CATALOG } from "../iam-catalog/catalog";

/** Ids reales del catálogo publicado. */
const CATALOG_IDS: readonly string[] = IAM_CATALOG.map((p) => p.id);

/** Máximo de presets distintos por selección (acotado para runs rápidos). */
const MAX_CURRENT = Math.min(8, CATALOG_IDS.length);

/** Ids-ruido que NO existen en el catálogo (no deben influir en el complemento). */
const NOISE_IDS: readonly string[] = [
  "does-not-exist-1",
  "phantom-preset",
  "no-such-id-xyz",
];

/** Conjuntos de entornos destino admisibles. */
const ENV_SETS: readonly string[][] = [
  ["dev"],
  ["prod"],
  ["dev", "uat"],
  ["dev", "uat", "prod"],
  ["tooling"],
];

// Sanidad: el catálogo debe exponer presets para que la propiedad tenga sentido.
test("Property 22: precondición — el catálogo expone presets", () => {
  assert.ok(CATALOG_IDS.length > 0, "IAM_CATALOG no expone ningún preset");
});

/**
 * Caso de prueba: un conjunto `current` de ids distintos del catálogo, un
 * subconjunto `removeFromCurrent` de esos ids, ids-ruido a quitar (ausentes de
 * current), y los campos de rol/entornos.
 */
const removalCaseArb = fc
  .shuffledSubarray(CATALOG_IDS as string[], { minLength: 1, maxLength: MAX_CURRENT })
  .chain((current) =>
    fc.record({
      current: fc.constant(current),
      // Subconjunto (posiblemente vacío o total) de los ids actuales a quitar.
      removeFromCurrent: fc.shuffledSubarray(current, {
        minLength: 0,
        maxLength: current.length,
      }),
      // Ids-ruido a quitar que no pertenecen al conjunto actual.
      noiseRemove: fc.subarray(NOISE_IDS as string[], { minLength: 0, maxLength: NOISE_IDS.length }),
      roleName: fc.constantFrom("my-service-role", "oms-worker", "data_pipeline-role"),
      namespace: fc.constantFrom("oms", "n8n", "data-science"),
      environments: fc.constantFrom(...ENV_SETS),
    }),
  );

test("Property 22: applyRemoval + regeneración preserva el complemento exacto", () => {
  fc.assert(
    fc.property(removalCaseArb, (c) => {
      const { current, removeFromCurrent, noiseRemove, roleName, namespace, environments } = c;

      const remove = [...removeFromCurrent, ...noiseRemove];
      const kept = applyRemoval(current, remove);

      // Complemento exacto esperado: set(current) \ set(remove).
      const removeSet = new Set(remove);
      const expected = new Set(current.filter((id) => !removeSet.has(id)));

      // `applyRemoval` ya debe devolver exactamente el complemento (como conjunto).
      assert.deepEqual(
        new Set(kept),
        expected,
        `applyRemoval no produjo el complemento exacto: kept=${JSON.stringify(
          kept,
        )} esperado=${JSON.stringify([...expected])}`,
      );

      const selections: PresetSelection[] = kept.map((presetId) => ({ presetId }));
      const result = generateIamRoleHcl({
        roleName,
        namespace,
        selections,
        targetEnvironments: environments,
      });

      if (expected.size === 0) {
        // Complemento vacío ⇒ no hay rol que emitir (generación abortada).
        assert.equal(result.ok, false, "complemento vacío debería abortar la generación");
        if (!result.ok) {
          assert.equal(
            result.code,
            "empty_selection",
            `código inesperado para complemento vacío: ${result.code}`,
          );
        }
        return;
      }

      // Complemento no vacío ⇒ HCL cuyos ids parseados son exactamente el complemento.
      assert.ok(result.ok, `generación no fue ok: ${JSON.stringify(result)}`);
      if (result.ok) {
        const parsed = new Set(parseRolePresetIds(result.hcl));
        assert.deepEqual(
          parsed,
          expected,
          `los ids del HCL regenerado no coinciden con el complemento: parsed=${JSON.stringify(
            [...parsed],
          )} esperado=${JSON.stringify([...expected])}`,
        );
      }
    }),
    { numRuns: 100 },
  );
});
