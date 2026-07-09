/**
 * Property-based tests for `normalizeTargetEnvironments`
 * (`src/lib/infra/environments-parser.ts`).
 *
 * Feature: infra-self-service-hardening
 * Task 1.6 — Property 7: applyFilters on TargetEnvironmentsPayload is
 * idempotent and commutative.
 *
 * Conventions (repo): node:test + node:assert/strict, fast-check ^4,
 * `{ numRuns: 100 }`, un comentario `// Feature: ...` por propiedad y una
 * propiedad ↔ un test.
 *
 * Validates: Requirements 4.1, 4.2
 *   4.1 — array de 1..3 elementos únicos, todos en {"dev","uat","prod"}.
 *   4.2 — cualquier payload que viole 4.1 se rechaza (aquí: se devuelve `null`).
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { normalizeTargetEnvironments } from "../environments-parser";

// ---------------------------------------------------------------------------
// Arbitrarios
// ---------------------------------------------------------------------------

/** Dominio cerrado del criterio 4.1. */
const ENV_DOMAIN = ["dev", "uat", "prod"] as const;
const envArb: fc.Arbitrary<(typeof ENV_DOMAIN)[number]> = fc.constantFrom(
  ...ENV_DOMAIN,
);

/**
 * Payload válido: array de 1..3 envs únicos del dominio (Req 4.1).
 * `uniqueArray` garantiza dedup y respeta length 1..3.
 */
const validPayloadArb: fc.Arbitrary<string[]> = fc.uniqueArray(envArb, {
  minLength: 1,
  maxLength: 3,
});

/**
 * Permuta un array preservando su contenido. Fisher–Yates guiado por un
 * generador de índices de fast-check para tener shrinking determinista.
 */
const permutationArb = <T>(arr: readonly T[]): fc.Arbitrary<T[]> => {
  if (arr.length <= 1) return fc.constant([...arr]);
  return fc
    .tuple(
      ...Array.from({ length: arr.length - 1 }, (_, i) =>
        fc.integer({ min: 0, max: arr.length - 1 - i }),
      ),
    )
    .map((picks) => {
      const copy = [...arr];
      const out: T[] = [];
      for (const pick of picks) {
        out.push(copy.splice(pick, 1)[0]);
      }
      out.push(copy[0]);
      return out;
    });
};

/**
 * Payloads inválidos: violan alguna cláusula del Req 4.1.
 *   - no-array (`unknown` que no sea array)
 *   - array vacío (length 0)
 *   - array demasiado largo (con duplicados obligados, length > 3)
 *   - elemento fuera del dominio
 *   - elemento con tipo distinto de string
 *   - duplicados
 */
const invalidPayloadArb: fc.Arbitrary<unknown> = fc.oneof(
  // No es array.
  fc.string(),
  fc.integer(),
  fc.constant(null),
  fc.constant(undefined),
  fc.constant({}),
  fc.record({ length: fc.integer({ min: 0, max: 10 }) }), // objeto array-like que NO es array

  // Array vacío.
  fc.constant([] as unknown[]),

  // Array demasiado largo (siempre length > 3).
  fc.array(envArb, { minLength: 4, maxLength: 8 }),

  // Elemento fuera del dominio.
  fc
    .tuple(
      fc.constantFrom("staging", "prd", "test", "development", "DEV", "Dev", ""),
      fc.array(envArb, { maxLength: 2 }),
    )
    .map(([bad, rest]) => [bad, ...rest]),

  // Elemento con tipo distinto de string (dentro de un array por lo demás plausible).
  fc
    .tuple(
      fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.constant({})),
      fc.array(envArb, { maxLength: 2 }),
    )
    .map(([bad, rest]) => [bad, ...rest]),

  // Duplicados: mismo env repetido (length ∈ [2, 6]).
  envArb.chain((e) =>
    fc
      .integer({ min: 2, max: 6 })
      .map((n) => Array.from({ length: n }, () => e)),
  ),
);

/** Deep-equal shorthand centrado en el output del SUT: `null | Env[]`. */
const same = (a: unknown, b: unknown) => {
  assert.deepStrictEqual(a, b);
};

// ---------------------------------------------------------------------------
// Property 7 — sub-propiedades
// ---------------------------------------------------------------------------

// Feature: infra-self-service-hardening, Property 7: applyFilters on TargetEnvironmentsPayload is idempotent and commutative
test("Property 7 — idempotencia: normalize(normalize(x)) deep-equals normalize(x) para cualquier x", () => {
  fc.assert(
    fc.property(fc.oneof(validPayloadArb, invalidPayloadArb), (x) => {
      const once = normalizeTargetEnvironments(x);
      const twice = normalizeTargetEnvironments(once as unknown);
      same(twice, once);
    }),
    { numRuns: 100 },
  );
});

// Feature: infra-self-service-hardening, Property 7: applyFilters on TargetEnvironmentsPayload is idempotent and commutative
test("Property 7 — permutación (conmutatividad de la validación): normalize(π(x)) deep-equals normalize(x)", () => {
  fc.assert(
    fc.property(
      validPayloadArb.chain((x) => permutationArb(x).map((π) => ({ x, π }))),
      ({ x, π }) => {
        // Sanidad: π es una permutación real de x (mismo multiset).
        assert.strictEqual(π.length, x.length);
        assert.deepStrictEqual([...π].sort(), [...x].sort());

        const a = normalizeTargetEnvironments(x);
        const b = normalizeTargetEnvironments(π);
        same(a, b);
      },
    ),
    { numRuns: 100 },
  );
});

// Feature: infra-self-service-hardening, Property 7: applyFilters on TargetEnvironmentsPayload is idempotent and commutative
test("Property 7 — rejection stability: mismo input rechazado ⇒ mismo `null`", () => {
  fc.assert(
    fc.property(invalidPayloadArb, (x) => {
      const first = normalizeTargetEnvironments(x);
      // Precondición: el input elegido cae en la clase "rechazado".
      fc.pre(first === null);

      // Determinismo (función pura): dos invocaciones con el mismo input
      // producen el mismo resultado. Rechazado ⇒ `null` en ambos casos.
      const second = normalizeTargetEnvironments(x);
      assert.strictEqual(first, null);
      assert.strictEqual(second, null);
    }),
    { numRuns: 100 },
  );
});

// Feature: infra-self-service-hardening, Property 7: applyFilters on TargetEnvironmentsPayload is idempotent and commutative
test("Property 7 — acceptance stability: mismo input aceptado ⇒ mismo array canónico (dev < uat < prod)", () => {
  const CANONICAL_ORDER = ["dev", "uat", "prod"] as const;
  fc.assert(
    fc.property(validPayloadArb, (x) => {
      const first = normalizeTargetEnvironments(x);
      const second = normalizeTargetEnvironments(x);

      // Los válidos SIEMPRE producen un array (no `null`).
      assert.ok(Array.isArray(first));
      assert.ok(Array.isArray(second));

      // Determinismo estructural entre dos invocaciones.
      same(first, second);

      // Orden canónico documentado (dev < uat < prod) — no un orden arbitrario.
      const inCanonical = CANONICAL_ORDER.filter((e) => x.includes(e));
      assert.deepStrictEqual(first, inCanonical);
    }),
    { numRuns: 100 },
  );
});
