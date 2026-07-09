// Feature: iam-role-least-privilege, Property 15: expresión count según los entornos destino
/**
 * Property test de la expresión count según los entornos destino.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/generator.ts (generateIamRoleHcl)
 *
 * Property 15: expresión count según los entornos destino
 *   Para toda selección de un Preset_IAM cubierto por el Catálogo_IAM y campos
 *   obligatorios válidos (roleName / namespace):
 *     - Si `targetEnvironments` es un subconjunto PROPIO no vacío de
 *       {dev, uat, prod} (es decir, NO están los tres), cada recurso condicionado
 *       (`aws_iam_role`, `aws_iam_policy`, `aws_iam_role_policy_attachment`)
 *       incluye la línea `count = contains([<entornos canónicos>], var.environment) ? 1 : 0`
 *       con los entornos en el orden canónico dev→uat→prod, y las referencias
 *       cruzadas usan el índice `[0]` (4.6).
 *     - Si `targetEnvironments` es el conjunto COMPLETO {dev, uat, prod} (en
 *       cualquier orden), el HCL NO contiene ninguna expresión `count =` ni
 *       ninguna referencia indexada `[0]` (4.8).
 *
 * **Validates: Requirements 4.6, 4.8**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  generateIamRoleHcl,
  type GenerateIamRoleInput,
} from "../iam-catalog/generator";
import { IAM_CATALOG } from "../iam-catalog/catalog";
import type { IamPreset } from "../iam-catalog/catalog";

/** Todos los presets publicados (cubiertos por el Catálogo_IAM). */
const ALL_PRESETS: readonly IamPreset[] = IAM_CATALOG;

/** Orden canónico de los entornos condicionables (espejo del generador). */
const CANONICAL_ENV_ORDER: readonly string[] = ["dev", "uat", "prod"];

/** roleName válido (etiqueta de recurso no vacía). */
const roleNameArb = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-".split("")), {
    minLength: 1,
    maxLength: 20,
  })
  .map((c) => `svc-${c.join("")}`);

/** namespace válido no vacío. */
const namespaceArb = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-".split("")), {
    minLength: 1,
    maxLength: 16,
  })
  .map((c) => `ns-${c.join("")}`);

/** Un preset cualquiera del catálogo publicado. */
const presetArb = fc
  .integer({ min: 0, max: ALL_PRESETS.length - 1 })
  .map((i) => ALL_PRESETS[i]);

/**
 * Subconjunto PROPIO no vacío de {dev, uat, prod}: 1 o 2 entornos (nunca los 3).
 * Se produce en orden arbitrario para verificar que el generador reordena
 * canónicamente. Se dedup + baraja para simular entradas del usuario.
 */
const properSubsetArb: fc.Arbitrary<string[]> = fc
  .subarray(["dev", "uat", "prod"], { minLength: 1, maxLength: 2 })
  .filter((a) => a.length >= 1 && a.length <= 2)
  .chain((sub) => fc.shuffledSubarray(sub, { minLength: sub.length, maxLength: sub.length }));

/** Conjunto completo {dev, uat, prod} en cualquier orden (con posibles repetidos). */
const fullSetArb: fc.Arbitrary<string[]> = fc.shuffledSubarray(["dev", "uat", "prod"], {
  minLength: 3,
  maxLength: 3,
});

// Precondición: el catálogo no está vacío.
test("Property 15: precondición — el catálogo publica presets", () => {
  assert.ok(ALL_PRESETS.length > 0, "IAM_CATALOG está vacío");
});

/** Construye la línea `count` esperada para un subconjunto de entornos. */
function expectedCountLine(subset: readonly string[]): string {
  const ordered = CANONICAL_ENV_ORDER.filter((e) => subset.includes(e));
  const envList = ordered.map((e) => JSON.stringify(e)).join(", ");
  return `count = contains([${envList}], var.environment) ? 1 : 0`;
}

/** Cuenta ocurrencias no solapadas de `needle` en `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

test("Property 15: subconjunto propio → count canónico en los 3 recursos + refs [0]", () => {
  fc.assert(
    fc.property(
      presetArb,
      roleNameArb,
      namespaceArb,
      properSubsetArb,
      (preset, roleName, namespace, targetEnvironments) => {
        const input: GenerateIamRoleInput = {
          roleName,
          namespace,
          selections: [{ presetId: preset.id }],
          targetEnvironments,
        };

        const result = generateIamRoleHcl(input);
        assert.equal(result.ok, true, `esperaba ok:true, obtuve ${JSON.stringify(result)}`);
        if (!result.ok) return;

        const line = expectedCountLine(targetEnvironments);
        // Los 3 recursos condicionados (role, policy, attachment) llevan la línea count.
        assert.equal(
          countOccurrences(result.hcl, line),
          3,
          `esperaba 3 líneas count "${line}" en el HCL:\n${result.hcl}`,
        );

        // Las referencias cruzadas del attachment usan el índice [0].
        assert.ok(
          result.hcl.includes("[0].name"),
          `esperaba referencia aws_iam_role.<label>[0].name en:\n${result.hcl}`,
        );
        assert.ok(
          result.hcl.includes("[0].arn"),
          `esperaba referencia aws_iam_policy.<label>[0].arn en:\n${result.hcl}`,
        );
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 15: conjunto completo {dev,uat,prod} → sin count ni referencias [0]", () => {
  fc.assert(
    fc.property(
      presetArb,
      roleNameArb,
      namespaceArb,
      fullSetArb,
      (preset, roleName, namespace, targetEnvironments) => {
        const input: GenerateIamRoleInput = {
          roleName,
          namespace,
          selections: [{ presetId: preset.id }],
          targetEnvironments,
        };

        const result = generateIamRoleHcl(input);
        assert.equal(result.ok, true, `esperaba ok:true, obtuve ${JSON.stringify(result)}`);
        if (!result.ok) return;

        assert.equal(
          countOccurrences(result.hcl, "count ="),
          0,
          `con el conjunto completo no debe haber ninguna expresión count en:\n${result.hcl}`,
        );
        assert.equal(
          countOccurrences(result.hcl, "[0]"),
          0,
          `con el conjunto completo no debe haber ninguna referencia [0] en:\n${result.hcl}`,
        );
      },
    ),
    { numRuns: 100 },
  );
});
