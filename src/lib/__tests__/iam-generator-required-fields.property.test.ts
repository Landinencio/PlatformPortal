// Feature: iam-role-least-privilege, Property 24: campos obligatorios de la solicitud
/**
 * Property test de los campos obligatorios de la solicitud.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/generator.ts (validateRequiredRoleFields)
 *
 * Property 24: campos obligatorios de la solicitud
 *   `validateRequiredRoleFields` decide si una Solicitud_Infra de rol IAM tiene
 *   los tres campos obligatorios (7.3): `roleName`, `namespace` y al menos un
 *   entorno destino, todos presentes y no vacíos (tras recortar espacios).
 *     - Si los TRES son válidos (roleName no vacío, namespace no vacío y
 *       `targetEnvironments` contiene ≥1 string no vacío), devuelve `true`.
 *     - Si CUALQUIERA falta o está vacío/blanco (roleName ausente/blanco,
 *       namespace ausente/blanco, o `targetEnvironments` vacío / con todos los
 *       entornos en blanco), devuelve `false`.
 *   La función es TOTAL: nunca lanza, sea cual sea la entrada.
 *
 * Estrategia de generación:
 *   - Arbitrarios de strings "no vacíos" (al menos un carácter no-espacio) y
 *     "en blanco" (vacío o solo whitespace).
 *   - Caso válido: los tres campos poblados con valores no vacíos → true.
 *   - Casos inválidos: se fuerza que exactamente uno de los tres campos sea
 *     inválido (blank roleName, blank namespace, o entornos vacíos/all-blank),
 *     manteniendo los otros dos válidos → false.
 *
 * **Validates: Requirements 7.3**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  validateRequiredRoleFields,
  type GenerateIamRoleInput,
} from "../iam-catalog/generator";

/** Selección mínima irrelevante para la validación de campos obligatorios. */
const DUMMY_SELECTIONS: GenerateIamRoleInput["selections"] = [{ presetId: "s3-read-only" }];

/** String no vacío: contiene al menos un carácter no-espacio. */
const nonEmptyStringArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** String "en blanco": vacío o compuesto solo de whitespace. */
const blankStringArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  fc
    .array(fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v"), {
      minLength: 1,
      maxLength: 6,
    })
    .map((chars) => chars.join("")),
);

/** Lista de entornos con al menos un valor no vacío (válida). */
const validEnvsArb: fc.Arbitrary<string[]> = fc
  .array(fc.oneof(nonEmptyStringArb, blankStringArb), { minLength: 1, maxLength: 5 })
  .filter((envs) => envs.some((e) => e.trim().length > 0));

/**
 * Lista de entornos inválida: vacía, o con todos los elementos en blanco. Ambos
 * casos deben tratarse como ausencia de entorno destino.
 */
const invalidEnvsArb: fc.Arbitrary<string[]> = fc.oneof(
  fc.constant([] as string[]),
  fc.array(blankStringArb, { minLength: 1, maxLength: 5 }),
);

test("Property 24: los tres campos válidos ⇒ true", () => {
  fc.assert(
    fc.property(nonEmptyStringArb, nonEmptyStringArb, validEnvsArb, (roleName, namespace, envs) => {
      const input: GenerateIamRoleInput = {
        roleName,
        namespace,
        selections: DUMMY_SELECTIONS,
        targetEnvironments: envs,
      };
      assert.equal(
        validateRequiredRoleFields(input),
        true,
        `esperaba true con roleName=${JSON.stringify(roleName)}, namespace=${JSON.stringify(
          namespace,
        )}, envs=${JSON.stringify(envs)}`,
      );
    }),
    { numRuns: 100 },
  );
});

test("Property 24: roleName ausente/blanco ⇒ false", () => {
  fc.assert(
    fc.property(blankStringArb, nonEmptyStringArb, validEnvsArb, (badRole, namespace, envs) => {
      const input: GenerateIamRoleInput = {
        roleName: badRole,
        namespace,
        selections: DUMMY_SELECTIONS,
        targetEnvironments: envs,
      };
      assert.equal(
        validateRequiredRoleFields(input),
        false,
        `esperaba false con roleName en blanco ${JSON.stringify(badRole)}`,
      );
    }),
    { numRuns: 100 },
  );
});

test("Property 24: namespace ausente/blanco ⇒ false", () => {
  fc.assert(
    fc.property(nonEmptyStringArb, blankStringArb, validEnvsArb, (roleName, badNs, envs) => {
      const input: GenerateIamRoleInput = {
        roleName,
        namespace: badNs,
        selections: DUMMY_SELECTIONS,
        targetEnvironments: envs,
      };
      assert.equal(
        validateRequiredRoleFields(input),
        false,
        `esperaba false con namespace en blanco ${JSON.stringify(badNs)}`,
      );
    }),
    { numRuns: 100 },
  );
});

test("Property 24: entornos destino vacíos o todos en blanco ⇒ false", () => {
  fc.assert(
    fc.property(nonEmptyStringArb, nonEmptyStringArb, invalidEnvsArb, (roleName, namespace, envs) => {
      const input: GenerateIamRoleInput = {
        roleName,
        namespace,
        selections: DUMMY_SELECTIONS,
        targetEnvironments: envs,
      };
      assert.equal(
        validateRequiredRoleFields(input),
        false,
        `esperaba false con entornos inválidos ${JSON.stringify(envs)}`,
      );
    }),
    { numRuns: 100 },
  );
});
