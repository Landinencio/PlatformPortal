// Feature: iam-role-least-privilege, Property 7: Resource canónico (scope presente o ausente)
/**
 * Property test del Resource canónico (scope presente o ausente).
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/generator.ts
 *
 * Property 7: Resource canónico (scope presente o ausente)
 *   Para toda selección de un Preset_IAM cubierto por el Catálogo_IAM y campos
 *   obligatorios válidos (roleName / namespace / targetEnvironments):
 *     - Si se aporta ≥1 ARN no vacío y bien formado (coherente con el servicio
 *       del preset), el campo `Resource` de la Politica_Generada contiene
 *       EXACTAMENTE esos ARNs, deduplicados y en orden lexicográfico estable
 *       (3.2).
 *     - Si NO se aporta scope, o todos los ARNs están en blanco / sólo espacios,
 *       el campo `Resource` es `[defaultArnTemplate]` del preset (3.4).
 *   Además la salida es reproducible: la misma selección semántica produce HCL
 *   byte-idéntico entre ejecuciones y con independencia del orden de los ARNs de
 *   entrada (permutaciones).
 *
 * Se generan ARNs SIN comodines (`*`/`?`) porque algunos presets scopables no
 * los permiten (`allowWildcards === false`); así la aceptación del scope queda
 * garantizada con independencia del preset elegido.
 *
 * **Validates: Requirements 3.2, 3.4**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  generateIamRoleHcl,
  type GenerateIamRoleInput,
} from "../iam-catalog/generator";
import { IAM_CATALOG } from "../iam-catalog/catalog";
import type { AwsService, IamPreset } from "../iam-catalog/catalog";

/**
 * Mapeo `AwsService` → prefijo de servicio dentro del ARN. Espejo de la tabla
 * canónica de `arn.ts`, para construir ARNs coherentes con el servicio del
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

/** Presets scopables reales del catálogo publicado. */
const SCOPABLE_PRESETS: readonly IamPreset[] = IAM_CATALOG.filter((p) => p.scopable === true);
/** Todos los presets publicados (para el caso de scope ausente). */
const ALL_PRESETS: readonly IamPreset[] = IAM_CATALOG;

test("Property 7: precondición — el catálogo expone presets scopables", () => {
  assert.ok(SCOPABLE_PRESETS.length > 0, "no hay presets scopables en IAM_CATALOG");
  assert.ok(ALL_PRESETS.length > 0, "IAM_CATALOG está vacío");
});

/**
 * Extrae del HCL generado el ÚNICO array `Resource = [...]`. La generación con
 * un solo preset emite exactamente un Statement y, por tanto, un `Resource`.
 * Devuelve la lista parseada como JSON (los ARNs generados no contienen comillas
 * ni backslashes, de modo que el bloque es JSON válido).
 */
function extractResource(hcl: string): string[] {
  const matches = [...hcl.matchAll(/Resource\s*=\s*(\[[\s\S]*?\])/g)];
  assert.equal(matches.length, 1, `esperaba exactamente 1 array Resource, hubo ${matches.length}`);
  return JSON.parse(matches[0][1]) as string[];
}

/** Caracteres seguros para el segmento de recurso (sin comodines `*`/`?`). */
const SAFE_RESOURCE_CHARS =
  "abcdefghijklmnopqrstuvwxyz0123456789-_/.".split("");

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

/** Subconjunto no vacío de entornos destino válidos. */
const targetEnvsArb: fc.Arbitrary<string[]> = fc
  .subarray(["dev", "uat", "prod"], { minLength: 1 })
  .filter((a) => a.length > 0);

test("Property 7: con scope válido, Resource = ARNs deduplicados+ordenados y reproducible", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: SCOPABLE_PRESETS.length - 1 }).map((i) => SCOPABLE_PRESETS[i]),
      regionArb,
      accountArb,
      fc.array(resourceTokenArb, { minLength: 1, maxLength: 12 }),
      roleNameArb,
      namespaceArb,
      targetEnvsArb,
      (preset, region, account, tokens, roleName, namespace, targetEnvironments) => {
        const prefix = SERVICE_ARN_PREFIX[preset.service];
        // Se permiten índices repetidos deliberadamente para forzar duplicados
        // y verificar la deduplicación. `res/<tok>` nunca es vacío.
        const arns = tokens.map((tok) => `arn:aws:${prefix}:${region}:${account}:res/${tok}`);

        const input: GenerateIamRoleInput = {
          roleName,
          namespace,
          selections: [{ presetId: preset.id, resourceArns: arns }],
          targetEnvironments,
        };

        const result = generateIamRoleHcl(input);
        assert.equal(result.ok, true, `esperaba ok:true, obtuve ${JSON.stringify(result)}`);
        if (!result.ok) return;

        const emitted = extractResource(result.hcl);
        const expected = [...new Set(arns)].sort();
        assert.deepEqual(emitted, expected, "Resource debe ser los ARNs deduplicados+ordenados");

        // Reproducibilidad: misma entrada → HCL byte-idéntico.
        const again = generateIamRoleHcl(input);
        assert.equal(again.ok, true);
        if (again.ok) {
          assert.equal(again.hcl, result.hcl, "la generación debe ser byte-idéntica entre ejecuciones");
        }
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 7: el orden de los ARNs de entrada no altera el HCL (permutación)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: SCOPABLE_PRESETS.length - 1 }).map((i) => SCOPABLE_PRESETS[i]),
      regionArb,
      accountArb,
      // ≥2 tokens únicos para que la permutación sea observable.
      fc.uniqueArray(resourceTokenArb.filter((t) => t.length > 0), {
        minLength: 2,
        maxLength: 10,
      }),
      roleNameArb,
      namespaceArb,
      targetEnvsArb,
      (preset, region, account, tokens, roleName, namespace, targetEnvironments) => {
        const prefix = SERVICE_ARN_PREFIX[preset.service];
        const arns = tokens.map((tok) => `arn:aws:${prefix}:${region}:${account}:res/${tok}`);
        // Permutación determinista dependiente del input: rotación + inversión.
        const permuted = [...arns.slice(1), arns[0]].reverse();

        const base = generateIamRoleHcl({
          roleName,
          namespace,
          selections: [{ presetId: preset.id, resourceArns: arns }],
          targetEnvironments,
        });
        const perm = generateIamRoleHcl({
          roleName,
          namespace,
          selections: [{ presetId: preset.id, resourceArns: permuted }],
          targetEnvironments,
        });
        assert.equal(base.ok, true);
        assert.equal(perm.ok, true);
        if (base.ok && perm.ok) {
          assert.equal(perm.hcl, base.hcl, "permutar los ARNs de entrada no debe cambiar el HCL");
        }
      },
    ),
    { numRuns: 100 },
  );
});

test("Property 7: sin scope o con ARNs en blanco, Resource = [defaultArnTemplate]", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: ALL_PRESETS.length - 1 }).map((i) => ALL_PRESETS[i]),
      // Scope ausente (undefined), lista vacía, o lista de sólo-blancos.
      fc.oneof(
        fc.constant(undefined),
        fc.constant([] as string[]),
        fc.array(fc.constantFrom("", " ", "   ", "\t", "\n"), { minLength: 1, maxLength: 5 }),
      ),
      roleNameArb,
      namespaceArb,
      targetEnvsArb,
      (preset, resourceArns, roleName, namespace, targetEnvironments) => {
        const input: GenerateIamRoleInput = {
          roleName,
          namespace,
          selections: [{ presetId: preset.id, resourceArns }],
          targetEnvironments,
        };

        const result = generateIamRoleHcl(input);
        assert.equal(result.ok, true, `esperaba ok:true, obtuve ${JSON.stringify(result)}`);
        if (!result.ok) return;

        const emitted = extractResource(result.hcl);
        assert.deepEqual(
          emitted,
          [preset.defaultArnTemplate],
          "sin scope, Resource debe ser la plantilla por defecto del preset",
        );

        // Reproducibilidad también en el camino sin scope.
        const again = generateIamRoleHcl(input);
        assert.equal(again.ok, true);
        if (again.ok) {
          assert.equal(again.hcl, result.hcl, "la generación debe ser byte-idéntica entre ejecuciones");
        }
      },
    ),
    { numRuns: 100 },
  );
});
