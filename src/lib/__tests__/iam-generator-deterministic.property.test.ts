// Feature: iam-role-least-privilege, Property 12: generación byte-idéntica e independiente del orden
/**
 * Property test de generación byte-idéntica e independiente del orden.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/generator.ts (generateIamRoleHcl)
 *
 * Property 12: generación byte-idéntica e independiente del orden
 *   ∀ selección de N presets scopables distintos del Catálogo_IAM, cada uno con
 *   un conjunto de ARNs bien formados y coherentes con su servicio, el HCL
 *   producido por `generateIamRoleHcl` es idéntico BYTE A BYTE aunque se permute
 *   el orden de los presets y el orden de los ARNs de entrada. La misma selección
 *   semántica (mismos presetIds, mismos ARNs, mismos campos de rol y entornos)
 *   produce siempre el mismo texto, con independencia del orden en que el usuario
 *   marque los presets o pegue los ARNs (4.2).
 *
 * Estrategia de generación: se muestrean subconjuntos de presets scopables
 * (distintos, vía `shuffledSubarray`), se generan ARNs sin comodines y coherentes
 * con el servicio de cada preset (así ningún preset los rechaza, sea cual sea su
 * `allowWildcards`), y se derivan DOS órdenes distintos de la misma entrada:
 *   - el orden de los presets se permuta con claves aleatorias independientes;
 *   - el orden de los ARNs de cada preset se invierte en la variante permutada.
 * Ambas entradas deben producir `ok === true` y el mismo `hcl` exacto.
 *
 * **Validates: Requirements 4.2**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { generateIamRoleHcl } from "../iam-catalog/generator";
import type { PresetSelection } from "../iam-catalog/generator";
import { IAM_CATALOG } from "../iam-catalog/catalog";
import type { AwsService, IamPreset } from "../iam-catalog/catalog";

/**
 * Mapeo `AwsService` → prefijo de servicio dentro del ARN (espejo de la tabla
 * canónica del módulo de validación de ARNs). Las excepciones son
 * eventbridge→events, s3-datalake→s3 y redshift-data→redshift.
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

/** Máximo de presets distintos por selección (acotado para runs rápidos). */
const MAX_PRESETS_PER_SELECTION = Math.min(6, SCOPABLE_PRESETS.length);

/** Caracteres seguros para el segmento de recurso (sin comodines `*`/`?`). */
const SAFE_RESOURCE_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/.".split("");

/** Token de recurso seguro (posiblemente vacío; se prefija con el índice). */
const resourceTokenArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SAFE_RESOURCE_CHARS), { minLength: 0, maxLength: 16 })
  .map((chars) => chars.join(""));

/** Construye un ARN bien formado, sin comodines, para un prefijo de servicio. */
function buildArn(prefix: string, region: string, account: string, resource: string): string {
  return `arn:aws:${prefix}:${region}:${account}:${resource}`;
}

/** Comparación estable por code points (independiente de locale). */
function byCodePoints(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Conjuntos de entornos destino admisibles (subconjuntos de dev/uat/prod o tooling). */
const ENV_SETS: readonly string[][] = [
  ["dev"],
  ["uat"],
  ["prod"],
  ["dev", "uat"],
  ["dev", "uat", "prod"],
  ["tooling"],
];

// Sanidad: el catálogo debe exponer presets scopables para que la propiedad tenga sentido.
test("Property 12: precondición — el catálogo expone presets scopables", () => {
  assert.ok(SCOPABLE_PRESETS.length > 0, "no hay presets scopables en IAM_CATALOG");
});

/**
 * Arbitrario que produce una selección base de presets scopables distintos con
 * sus ARNs, más las claves de permutación de orden de presets (A y B).
 */
const selectionCaseArb = fc
  .shuffledSubarray(SCOPABLE_PRESETS as IamPreset[], {
    minLength: 1,
    maxLength: MAX_PRESETS_PER_SELECTION,
  })
  .chain((presets) => {
    const n = presets.length;
    return fc.record({
      presets: fc.constant(presets),
      // Un listado de ARNs (1..5) por cada preset seleccionado.
      arnLists: fc.tuple(
        ...presets.map(() => fc.array(resourceTokenArb, { minLength: 1, maxLength: 5 })),
      ),
      region: fc.constantFrom("", "eu-west-1", "us-east-1", "eu-central-1"),
      account: fc.constantFrom("", "123456789012", "333344445555"),
      roleName: fc.constantFrom("my-service-role", "oms-worker", "data_pipeline-role"),
      namespace: fc.constantFrom("oms", "n8n", "data-science"),
      environments: fc.constantFrom(...ENV_SETS),
      // Claves independientes para permutar el orden de los presets (A y B).
      orderKeysA: fc.array(fc.double({ noNaN: true }), { minLength: n, maxLength: n }),
      orderKeysB: fc.array(fc.double({ noNaN: true }), { minLength: n, maxLength: n }),
    });
  });

test("Property 12: generateIamRoleHcl es byte-idéntico bajo permutación de presets y ARNs", () => {
  fc.assert(
    fc.property(selectionCaseArb, (c) => {
      const { presets, arnLists, region, account, roleName, namespace, environments } = c;

      // ARNs coherentes con el servicio de cada preset; el índice garantiza unicidad.
      const arnsByPreset: string[][] = presets.map((p, pi) => {
        const prefix = SERVICE_ARN_PREFIX[p.service];
        return arnLists[pi].map((tok, i) =>
          buildArn(prefix, region, account, `res-${pi}-${i}-${tok}`),
        );
      });

      // Orden A: permutación por orderKeysA (desempate estable por id).
      const orderA = presets
        .map((p, i) => ({ p, arns: arnsByPreset[i], k: c.orderKeysA[i] }))
        .sort((x, y) => x.k - y.k || byCodePoints(x.p.id, y.p.id));

      // Orden B: permutación distinta por orderKeysB, y ARNs de cada preset invertidos.
      const orderB = presets
        .map((p, i) => ({ p, arns: [...arnsByPreset[i]].reverse(), k: c.orderKeysB[i] }))
        .sort((x, y) => x.k - y.k || byCodePoints(x.p.id, y.p.id));

      const selectionsA: PresetSelection[] = orderA.map((x) => ({
        presetId: x.p.id,
        resourceArns: x.arns,
      }));
      const selectionsB: PresetSelection[] = orderB.map((x) => ({
        presetId: x.p.id,
        resourceArns: x.arns,
      }));

      const resultA = generateIamRoleHcl({
        roleName,
        namespace,
        selections: selectionsA,
        targetEnvironments: environments,
      });
      const resultB = generateIamRoleHcl({
        roleName,
        namespace,
        selections: selectionsB,
        targetEnvironments: environments,
      });

      // Ambas generaciones deben tener éxito.
      assert.ok(resultA.ok, `resultA no fue ok: ${JSON.stringify(resultA)}`);
      assert.ok(resultB.ok, `resultB no fue ok: ${JSON.stringify(resultB)}`);

      if (resultA.ok && resultB.ok) {
        // El HCL debe ser idéntico byte a byte pese al distinto orden de entrada.
        assert.equal(
          resultA.hcl,
          resultB.hcl,
          "el HCL difiere al permutar el orden de presets/ARNs (no es determinista)",
        );
        // Metadatos coherentes.
        assert.equal(resultA.actionsCount, resultB.actionsCount);
        assert.equal(resultA.filePath, resultB.filePath);
      }
    }),
    { numRuns: 100 },
  );
});
