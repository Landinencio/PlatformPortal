// Feature: iam-role-least-privilege, Property 16: el HCL generado supera validateHclSyntax
/**
 * Property test de que el HCL generado supera validateHclSyntax.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/generator.ts
 *
 * Property 16: el HCL generado supera validateHclSyntax
 *   Para TODA selección válida cubierta por el Catálogo_IAM (uno o más presets,
 *   con o sin Scope_De_Recurso, sobre cualquier subconjunto no vacío de entornos
 *   destino y también el conjunto completo dev+uat+prod), el HCL producido por
 *   `generateIamRoleHcl` supera `validateHclSyntax`: `validateHclSyntax(hcl).valid`
 *   es `true` (llaves balanceadas, strings cerrados, referencias `var.X` válidas,
 *   nombres de recurso válidos y expresiones `count` con paréntesis balanceados).
 *
 * Se generan ARNs SIN comodines (`*`/`?`) y coherentes con el servicio del preset
 * para que el scope sea siempre aceptado con independencia de `allowWildcards`.
 * Los `roleName` se restringen a etiquetas de recurso válidas para no confundir
 * la propiedad con validaciones ajenas (la sanitización del label es un detalle
 * interno del generador, no el objeto de esta propiedad).
 *
 * **Validates: Requirements 4.7**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  generateIamRoleHcl,
  type GenerateIamRoleInput,
  type PresetSelection,
} from "../iam-catalog/generator";
import { IAM_CATALOG } from "../iam-catalog/catalog";
import type { AwsService, IamPreset } from "../iam-catalog/catalog";
import { validateHclSyntax } from "../terraform-validator";

/**
 * Mapeo `AwsService` → prefijo de servicio dentro del ARN (espejo de la tabla
 * canónica de `arn.ts`), para construir ARNs coherentes con el servicio del
 * preset (excepciones: eventbridge→events, s3-datalake→s3, redshift-data→redshift).
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

/** Todos los presets publicados. */
const ALL_PRESETS: readonly IamPreset[] = IAM_CATALOG;

test("Property 16: precondición — el catálogo publicado no está vacío", () => {
  assert.ok(ALL_PRESETS.length > 0, "IAM_CATALOG está vacío");
});

/** Caracteres seguros para el segmento de recurso (sin comodines `*`/`?`). */
const SAFE_RESOURCE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-_/.".split("");

/** Token de recurso seguro (posiblemente vacío). */
const resourceTokenArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SAFE_RESOURCE_CHARS), { minLength: 0, maxLength: 16 })
  .map((chars) => chars.join(""));

const regionArb = fc.constantFrom("", "eu-west-1", "us-east-1", "eu-central-1");
const accountArb = fc.constantFrom("", "123456789012", "333344445555", "444455556666");

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

/**
 * Entornos destino: subconjunto propio no vacío de {dev,uat,prod} (emite `count`),
 * el conjunto completo (omite `count`), o ["tooling"]. Cubre ambos caminos de 4.6/4.8.
 */
const targetEnvsArb: fc.Arbitrary<string[]> = fc.oneof(
  fc.subarray(["dev", "uat", "prod"], { minLength: 1 }).filter((a) => a.length > 0),
  fc.constant(["dev", "uat", "prod"]),
  fc.constant(["tooling"]),
);

/** Selección de un preset con scope opcional (ausente, en blanco, o ARNs válidos). */
function selectionArb(preset: IamPreset): fc.Arbitrary<PresetSelection> {
  const prefix = SERVICE_ARN_PREFIX[preset.service];
  const arnsArb: fc.Arbitrary<string[]> = fc
    .array(resourceTokenArb, { minLength: 1, maxLength: 8 })
    .map((tokens) => tokens.map((tok) => `arn:aws:${prefix}:eu-west-1:123456789012:res/${tok}`));
  return fc
    .oneof(
      fc.constant(undefined),
      fc.constant([] as string[]),
      fc.array(fc.constantFrom("", " ", "  ", "\t"), { minLength: 1, maxLength: 4 }),
      arnsArb,
    )
    .map((resourceArns) => ({ presetId: preset.id, resourceArns }));
}

/** Selección de 1..5 presets únicos del catálogo, cada uno con scope opcional. */
const selectionsArb: fc.Arbitrary<PresetSelection[]> = fc
  .uniqueArray(fc.integer({ min: 0, max: ALL_PRESETS.length - 1 }), {
    minLength: 1,
    maxLength: 5,
  })
  .chain((indices) => fc.tuple(...indices.map((i) => selectionArb(ALL_PRESETS[i]))))
  .map((sels) => sels as PresetSelection[]);

test("Property 16: toda selección válida cubierta produce HCL que supera validateHclSyntax", () => {
  fc.assert(
    fc.property(
      selectionsArb,
      roleNameArb,
      namespaceArb,
      targetEnvsArb,
      (selections, roleName, namespace, targetEnvironments) => {
        const input: GenerateIamRoleInput = {
          roleName,
          namespace,
          selections,
          targetEnvironments,
        };

        const result = generateIamRoleHcl(input);
        assert.equal(result.ok, true, `esperaba ok:true, obtuve ${JSON.stringify(result)}`);
        if (!result.ok) return;

        const syntax = validateHclSyntax(result.hcl);
        assert.equal(
          syntax.valid,
          true,
          `validateHclSyntax debe ser valid; errores: ${JSON.stringify(syntax.errors)}\nHCL:\n${result.hcl}`,
        );
      },
    ),
    { numRuns: 100 },
  );
});
