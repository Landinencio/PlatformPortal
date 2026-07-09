// Feature: iam-role-least-privilege, Property 6: aceptación de scope dentro de los límites
/**
 * Property test de aceptación de scope dentro de los límites.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/arn.ts
 *
 * Property 6: aceptación de scope dentro de los límites
 *   ∀ preset scopable del Catálogo_IAM y ∀ lista de 1..50 ARNs bien formados y
 *   coherentes con el servicio del preset (cada uno de 1..2048 caracteres y sin
 *   comodines), `validateScope(arns, preset)` los acepta TODOS (`rejected`
 *   vacío) y no señala exceso de límite (`tooMany === false`). Los ARNs
 *   aceptados son exactamente el conjunto de entrada, deduplicado (3.1).
 *
 * Se generan ARNs SIN comodines porque algunos presets scopables no los
 * permiten (`allowWildcards === false`); así la aceptación queda garantizada
 * con independencia del preset elegido.
 *
 * **Validates: Requirements 3.1**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { validateScope, MAX_ARNS_PER_PRESET } from "../iam-catalog/arn";
import { IAM_CATALOG } from "../iam-catalog/catalog";
import type { AwsService, IamPreset } from "../iam-catalog/catalog";

/**
 * Mapeo `AwsService` → prefijo de servicio dentro del ARN. Espejo de la tabla
 * canónica del módulo bajo prueba, para construir ARNs coherentes con el
 * preset (las excepciones son eventbridge→events, s3-datalake→s3 y
 * redshift-data→redshift).
 */
const SERVICE_ARN_PREFIX: Record<AwsService, string> = {
  s3: "s3",
  sqs: "sqs",
  sns: "sns",
  eventbridge: "events",
  dynamodb: "dynamodb",
  secretsmanager: "secretsmanager",
  ssm: "ssm",
  logs: "logs",
  cloudwatch: "cloudwatch",
  kinesis: "kinesis",
  lambda: "lambda",
  states: "states",
  ses: "ses",
  bedrock: "bedrock",
  athena: "athena",
  glue: "glue",
  lakeformation: "lakeformation",
  firehose: "firehose",
  "redshift-data": "redshift",
  elasticmapreduce: "elasticmapreduce",
  kafka: "kafka",
  sagemaker: "sagemaker",
  "s3-datalake": "s3",
};

/** Presets scopables reales del catálogo publicado. */
const SCOPABLE_PRESETS: readonly IamPreset[] = IAM_CATALOG.filter((p) => p.scopable === true);

// Sanidad: el catálogo debe exponer al menos un preset scopable para que la
// propiedad tenga sentido.
test("Property 6: precondición — el catálogo expone presets scopables", () => {
  assert.ok(SCOPABLE_PRESETS.length > 0, "no hay presets scopables en IAM_CATALOG");
});

/** Caracteres seguros para el segmento de recurso (sin comodines `*`/`?`). */
const SAFE_RESOURCE_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/.".split("");

/** Token de recurso seguro (posiblemente vacío; se prefija con el índice). */
const resourceTokenArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SAFE_RESOURCE_CHARS), { minLength: 0, maxLength: 24 })
  .map((chars) => chars.join(""));

/** Region opcional (vacía para servicios globales). */
const regionArb = fc.constantFrom("", "eu-west-1", "us-east-1", "eu-central-1");
/** Cuenta opcional: vacía (global) o 12 dígitos. */
const accountArb = fc.constantFrom("", "123456789012", "333344445555", "444455556666");

/** Construye un ARN bien formado, sin comodines, para un prefijo de servicio. */
function buildArn(prefix: string, region: string, account: string, resource: string): string {
  return `arn:aws:${prefix}:${region}:${account}:${resource}`;
}

test("Property 6: validateScope acepta todos los ARNs bien formados dentro del límite", () => {
  fc.assert(
    fc.property(
      fc
        .integer({ min: 0, max: SCOPABLE_PRESETS.length - 1 })
        .map((i) => SCOPABLE_PRESETS[i]),
      regionArb,
      accountArb,
      fc.array(resourceTokenArb, { minLength: 1, maxLength: MAX_ARNS_PER_PRESET }),
      (preset, region, account, tokens) => {
        const prefix = SERVICE_ARN_PREFIX[preset.service];
        // ARNs únicos (el índice garantiza unicidad) y sin comodines.
        const arns = tokens.map((tok, i) =>
          buildArn(prefix, region, account, `res-${i}-${tok}`),
        );

        // Precondición del generador: cada ARN dentro de 1..2048 chars.
        for (const arn of arns) {
          assert.ok(
            arn.length >= 1 && arn.length <= 2048,
            `ARN fuera de rango de longitud: ${arn.length}`,
          );
        }

        const result = validateScope(arns, preset);

        // Todos aceptados: ninguno rechazado.
        assert.deepEqual(
          result.rejected,
          [],
          `esperaba 0 rechazos, hubo ${result.rejected.length}: ${JSON.stringify(result.rejected)}`,
        );
        // No se supera el límite (≤ 50 ARNs).
        assert.equal(result.tooMany, false, "tooMany debería ser false para ≤ 50 ARNs");
        // Los aceptados son exactamente el conjunto de entrada (deduplicado).
        assert.deepEqual(
          new Set(result.accepted),
          new Set(arns),
          "el conjunto aceptado debe coincidir con la entrada",
        );
      },
    ),
    { numRuns: 100 },
  );
});
