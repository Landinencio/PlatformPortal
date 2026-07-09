// Feature: iam-role-least-privilege, Property 1: Integridad estructural de todo preset publicado
/**
 * Property test de integridad estructural de todo preset publicado.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/catalog.ts
 *
 * Property 1: Integridad estructural de todo preset publicado
 *   ∀ Preset_IAM de la colección publicada `IAM_CATALOG`:
 *     - su `id` es una cadena no vacía,
 *     - su lista de `actions` tiene entre 1 y 50 elementos sin duplicados,
 *     - su `defaultArnTemplate` es una cadena no vacía,
 *     - su `service` pertenece al conjunto de 23 Servicios_AWS soportados,
 *     - su `accessLevel` es uno de {read-only, read-write, custom-actions},
 *     - ninguna de sus acciones pertenece al plano de datos de RDS.
 *
 * Se muestrean los presets con `fc.constantFrom(...IAM_CATALOG)` para que la
 * propiedad recorra toda la colección publicada bajo `{ numRuns: 100 }`.
 *
 * **Validates: Requirements 1.1, 1.7**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { IAM_CATALOG } from "../iam-catalog/catalog";
import type { AccessLevel, AwsService, IamPreset } from "../iam-catalog/catalog";
import { isRdsDataPlaneAction } from "../iam-catalog/action-levels";

/** Dominio soportado de niveles de acceso (Nivel_De_Acceso). */
const SUPPORTED_ACCESS_LEVELS: ReadonlySet<AccessLevel> = new Set<AccessLevel>([
  "read-only",
  "read-write",
  "custom-actions",
]);

/** Dominio soportado de servicios (23 valores de `AwsService`). */
const SUPPORTED_SERVICES: ReadonlySet<AwsService> = new Set<AwsService>([
  // Familia aplicación/microservicio (14)
  "s3",
  "sqs",
  "sns",
  "eventbridge",
  "dynamodb",
  "secretsmanager",
  "ssm",
  "logs",
  "cloudwatch",
  "kinesis",
  "lambda",
  "states",
  "ses",
  "bedrock",
  // Familia Data & Analytics (9)
  "athena",
  "glue",
  "lakeformation",
  "firehose",
  "redshift-data",
  "elasticmapreduce",
  "kafka",
  "sagemaker",
  "s3-datalake",
]);

const MAX_ACTIONS_PER_PRESET = 50;

// Sanidad: la colección publicada no está vacía, de modo que
// `fc.constantFrom(...IAM_CATALOG)` es un generador válido y la propiedad
// realmente ejercita presets.
test("Property 1: precondición — IAM_CATALOG no está vacío", () => {
  assert.ok(IAM_CATALOG.length > 0, "IAM_CATALOG no debería estar vacío");
});

test("Property 1: todo preset publicado es estructuralmente íntegro", () => {
  fc.assert(
    fc.property(fc.constantFrom(...IAM_CATALOG), (preset: IamPreset) => {
      // id no vacío
      assert.equal(typeof preset.id, "string", `id no es string: ${JSON.stringify(preset.id)}`);
      assert.ok(preset.id.trim().length > 0, `id vacío en preset ${JSON.stringify(preset)}`);

      // actions: array de 1..50 elementos, todos strings, sin duplicados
      assert.ok(Array.isArray(preset.actions), `actions no es array en preset ${preset.id}`);
      assert.ok(
        preset.actions.length >= 1 && preset.actions.length <= MAX_ACTIONS_PER_PRESET,
        `preset ${preset.id} tiene ${preset.actions.length} acciones (esperado 1..${MAX_ACTIONS_PER_PRESET})`,
      );
      for (const action of preset.actions) {
        assert.equal(typeof action, "string", `acción no-string en preset ${preset.id}`);
      }
      assert.equal(
        new Set(preset.actions).size,
        preset.actions.length,
        `preset ${preset.id} tiene acciones duplicadas: ${JSON.stringify(preset.actions)}`,
      );

      // defaultArnTemplate no vacío
      assert.equal(
        typeof preset.defaultArnTemplate,
        "string",
        `defaultArnTemplate no es string en preset ${preset.id}`,
      );
      assert.ok(
        preset.defaultArnTemplate.trim().length > 0,
        `defaultArnTemplate vacío en preset ${preset.id}`,
      );

      // service en el dominio soportado
      assert.ok(
        SUPPORTED_SERVICES.has(preset.service),
        `service no soportado "${preset.service}" en preset ${preset.id}`,
      );

      // accessLevel en el dominio soportado
      assert.ok(
        SUPPORTED_ACCESS_LEVELS.has(preset.accessLevel),
        `accessLevel no soportado "${preset.accessLevel}" en preset ${preset.id}`,
      );

      // ninguna acción del plano de datos RDS (1.7)
      for (const action of preset.actions) {
        assert.equal(
          isRdsDataPlaneAction(action),
          false,
          `preset ${preset.id} contiene acción del plano de datos RDS: ${action}`,
        );
      }
    }),
    { numRuns: 100 },
  );
});
