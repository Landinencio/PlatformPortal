// Feature: iam-role-least-privilege, Property 10: límite de 50 ARNs
/**
 * Property test del límite de 50 ARNs.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/arn.ts
 *
 * Property 10: límite de 50 ARNs
 *   Para toda lista de ARNs válidos de un preset scopable:
 *     - si contiene MÁS de 50 ARNs (`MAX_ARNS_PER_PRESET`), `validateScope`
 *       marca `tooMany === true` y conserva a lo sumo 50 ARNs dentro del límite
 *       (`accepted.length ≤ MAX_ARNS_PER_PRESET`) (3.7).
 *     - si contiene 50 ARNs o menos, `validateScope` marca `tooMany === false`.
 *
 * Nota de generación: `validateScope` trata los ARNs en blanco/espacios como
 * ausencia, así que el generador produce ARNs distintos, no vacíos y bien
 * formados (sin comodines, válidos también para presets `allowWildcards=false`)
 * para superar o mantenerse por debajo del límite de forma fiable.
 *
 * **Validates: Requirements 3.7**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  validateScope,
  serviceArnPrefix,
  MAX_ARNS_PER_PRESET,
} from "../iam-catalog/arn";
import { IAM_CATALOG } from "../iam-catalog/catalog";
import type { IamPreset } from "../iam-catalog/catalog";

/** Presets scopables reales del catálogo publicado (admiten Scope_De_Recurso). */
const SCOPABLE_PRESETS: readonly IamPreset[] = IAM_CATALOG.filter((p) => p.scopable);

/**
 * Construye `count` ARNs distintos, no vacíos y bien formados para `preset`, sin
 * comodines (por tanto válidos también cuando `preset.allowWildcards === false`).
 * El servicio del ARN casa con el prefijo del preset (evita `cross_service`) y
 * el recurso es único por índice (evita colisiones/dedup).
 */
function buildValidArns(preset: IamPreset, count: number): string[] {
  const prefix = serviceArnPrefix(preset.service);
  const arns: string[] = [];
  for (let i = 0; i < count; i++) {
    arns.push(`arn:aws:${prefix}:eu-west-1:123456789012:resource-${i}`);
  }
  return arns;
}

test("Property 10: >50 ARNs válidos ⇒ tooMany y ≤50 conservados", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...SCOPABLE_PRESETS),
      // Cantidad estrictamente por encima del límite de 50.
      fc.integer({ min: MAX_ARNS_PER_PRESET + 1, max: 120 }),
      (preset, count) => {
        const arns = buildValidArns(preset, count);
        const result = validateScope(arns, preset);

        assert.equal(
          result.tooMany,
          true,
          `Con ${count} ARNs (>${MAX_ARNS_PER_PRESET}) tooMany debe ser true`,
        );
        assert.ok(
          result.accepted.length <= MAX_ARNS_PER_PRESET,
          `accepted (${result.accepted.length}) no debe exceder ${MAX_ARNS_PER_PRESET}`,
        );
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 10: ≤50 ARNs válidos ⇒ tooMany === false", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...SCOPABLE_PRESETS),
      // Cantidad dentro del límite (1..50).
      fc.integer({ min: 1, max: MAX_ARNS_PER_PRESET }),
      (preset, count) => {
        const arns = buildValidArns(preset, count);
        const result = validateScope(arns, preset);

        assert.equal(
          result.tooMany,
          false,
          `Con ${count} ARNs (<=${MAX_ARNS_PER_PRESET}) tooMany debe ser false`,
        );
        // Todos los ARNs generados son válidos y distintos ⇒ se aceptan todos.
        assert.equal(result.accepted.length, count);
        assert.equal(result.rejected.length, 0);
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 10: exactamente 50 ARNs válidos ⇒ tooMany === false (frontera)", () => {
  fc.assert(
    fc.property(fc.constantFrom(...SCOPABLE_PRESETS), (preset) => {
      const arns = buildValidArns(preset, MAX_ARNS_PER_PRESET);
      const result = validateScope(arns, preset);
      assert.equal(result.tooMany, false);
      assert.equal(result.accepted.length, MAX_ARNS_PER_PRESET);
    }),
    { numRuns: 100 },
  );
});

test("Property 10: 51 ARNs válidos ⇒ tooMany y conserva 50 (frontera)", () => {
  fc.assert(
    fc.property(fc.constantFrom(...SCOPABLE_PRESETS), (preset) => {
      const arns = buildValidArns(preset, MAX_ARNS_PER_PRESET + 1);
      const result = validateScope(arns, preset);
      assert.equal(result.tooMany, true);
      assert.equal(result.accepted.length, MAX_ARNS_PER_PRESET);
    }),
    { numRuns: 100 },
  );
});
