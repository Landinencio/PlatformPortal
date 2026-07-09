// Feature: iam-role-least-privilege, Property 8: validación de ARN total, con conservación y anti-cross-service
/**
 * Property test de validación de ARN total, con conservación y anti-cross-service.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/arn.ts
 *
 * Property 8: validación de ARN total, con conservación y anti-cross-service
 *   ∀ ARN arbitrario (bien formado, malformado — segmentos faltantes, cuenta
 *   distinta de 12 dígitos, recurso vacío — o de otro servicio):
 *     - `validateArnFormat` es TOTAL (nunca lanza) y rechaza los malformados con
 *       un `code` estable, aceptando los bien formados (3.3).
 *     - `validateArnForPreset` marca `cross_service` todo ARN cuyo servicio no
 *       coincide con el del preset (3.5).
 *     - en una lista mixta, `validateScope` conserva la partición: los ARNs
 *       coherentes con el preset van a `accepted` y los inválidos a `rejected`
 *       (cada uno con su `code`), sin pérdida de entradas (3.3/3.5).
 *
 * **Validates: Requirements 3.3, 3.5**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  validateArnFormat,
  validateArnForPreset,
  validateScope,
  serviceArnPrefix,
} from "../iam-catalog/arn";
import type { ArnRejectCode } from "../iam-catalog/arn";
import { IAM_CATALOG } from "../iam-catalog/catalog";
import type { IamPreset } from "../iam-catalog/catalog";

/** Códigos de rechazo válidos — espejo del tipo `ArnRejectCode`. */
const VALID_CODES = new Set<ArnRejectCode>([
  "bad_format",
  "empty",
  "bad_account",
  "cross_service",
  "wildcard_not_allowed",
]);

/**
 * Prefijos de servicio de ARN conocidos, usados para construir ARNs de "otro
 * servicio" (cross-service). Cubre las dos familias del catálogo.
 */
const KNOWN_PREFIXES: readonly string[] = [
  "s3",
  "sqs",
  "sns",
  "events",
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
  "athena",
  "glue",
  "firehose",
  "redshift",
  "elasticmapreduce",
  "kafka",
  "sagemaker",
];

/**
 * Segmento de recurso "seguro": no vacío, sin comodines (`*`/`?`), sin espacios
 * en los extremos y sin `:` para no complicar el parseo. Garantiza que el ARN
 * construido sea coherente con cualquier preset (independiente de allowWildcards).
 */
const safeResource: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 30 })
  .map((s) => {
    const cleaned = s.replace(/[^a-zA-Z0-9/_-]/g, "");
    return cleaned.length > 0 ? cleaned : "res";
  });

/** ARN bien formado y sin comodines para el prefijo de servicio dado. */
function validArn(prefix: string): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom("eu-west-1", "us-east-1", "eu-central-1", ""),
      fc.constantFrom("123456789012", "333344445555", "444455556666", ""),
      safeResource,
    )
    .map(([region, account, resource]) => `arn:aws:${prefix}:${region}:${account}:${resource}`);
}

/** ARN bien formado de cualquier servicio conocido. */
const validArnAnyService: fc.Arbitrary<string> = fc
  .constantFrom(...KNOWN_PREFIXES)
  .chain((prefix) => validArn(prefix));

/**
 * ARN malformado (siempre rechazado por `validateArnFormat` con un `code`):
 *  - segmentos faltantes (parts < 6),
 *  - prefijo distinto de `arn`,
 *  - cuenta no vacía distinta de 12 dígitos (`bad_account`),
 *  - recurso vacío,
 *  - servicio vacío.
 */
const malformedArn: fc.Arbitrary<string> = fc.oneof(
  // Segmentos faltantes (parts < 6) → bad_format.
  fc.constantFrom(
    "arn",
    "arn:aws",
    "arn:aws:s3",
    "arn:aws:sqs:eu-west-1",
    "arn:aws:sqs:eu-west-1:123456789012",
  ),
  // No empieza por "arn" → bad_format.
  fc.constantFrom("aws:s3:::bucket", "notanarn", "https://example.com/x:y:z:a:b:c"),
  // Cuenta no vacía distinta de 12 dígitos → bad_account.
  fc
    .tuple(
      fc.constantFrom("sqs", "dynamodb", "lambda", "kinesis"),
      fc.constantFrom("123", "12345678901", "1234567890123", "abcdefghijkl"),
      safeResource,
    )
    .map(([svc, acct, res]) => `arn:aws:${svc}:eu-west-1:${acct}:${res}`),
  // Recurso vacío → bad_format.
  fc.constantFrom("arn:aws:sqs:eu-west-1:123456789012:", "arn:aws:s3:::", "arn:aws:dynamodb:eu-west-1:123456789012:"),
  // Servicio vacío → bad_format.
  fc.constantFrom("arn:aws::eu-west-1:123456789012:res", "arn:aws:::::res"),
);

/** Cadenas en blanco / sólo espacios → `empty`. */
const blankArn: fc.Arbitrary<string> = fc.constantFrom("", " ", "   ", "\t", "\n", "  \n\t ");

/** ARN bien formado de un servicio DISTINTO al del preset (cross-service). */
function crossServiceArn(preset: IamPreset): fc.Arbitrary<string> {
  const own = serviceArnPrefix(preset.service);
  const others = KNOWN_PREFIXES.filter((p) => p !== own);
  return fc.constantFrom(...others).chain((prefix) => validArn(prefix));
}

test("Property 8: validateArnFormat es total — nunca lanza y clasifica válidos vs malformados con code", () => {
  const tagged = fc.oneof(
    validArnAnyService.map((arn) => ({ arn, expectValid: true })),
    malformedArn.map((arn) => ({ arn, expectValid: false })),
    blankArn.map((arn) => ({ arn, expectValid: false })),
  );
  fc.assert(
    fc.property(tagged, ({ arn, expectValid }) => {
      let result: ReturnType<typeof validateArnFormat> | undefined;
      assert.doesNotThrow(() => {
        result = validateArnFormat(arn);
      });
      assert.ok(result !== undefined);
      assert.equal(result.valid, expectValid, `arn=${JSON.stringify(arn)} → ${JSON.stringify(result)}`);
      if (expectValid) {
        assert.equal(result.code, undefined, `un ARN válido no debe traer code: ${JSON.stringify(result)}`);
      } else {
        assert.ok(
          result.code !== undefined && VALID_CODES.has(result.code),
          `rechazo sin code válido: ${JSON.stringify(result)}`,
        );
      }
    }),
    { numRuns: 100 },
  );
});

test("Property 8: validateArnForPreset acepta un ARN coherente con el servicio del preset", () => {
  const scenario = fc
    .constantFrom(...IAM_CATALOG)
    .chain((preset) =>
      fc.record({ preset: fc.constant(preset), arn: validArn(serviceArnPrefix(preset.service)) }),
    );
  fc.assert(
    fc.property(scenario, ({ preset, arn }) => {
      const result = validateArnForPreset(arn, preset);
      assert.equal(result.valid, true, `esperaba válido: ${arn} para preset ${preset.id}`);
      assert.equal(result.code, undefined);
    }),
    { numRuns: 100 },
  );
});

test("Property 8: validateArnForPreset marca cross_service para un ARN de otro servicio", () => {
  const scenario = fc
    .constantFrom(...IAM_CATALOG)
    .chain((preset) => fc.record({ preset: fc.constant(preset), arn: crossServiceArn(preset) }));
  fc.assert(
    fc.property(scenario, ({ preset, arn }) => {
      const result = validateArnForPreset(arn, preset);
      assert.equal(result.valid, false, `esperaba rechazo cross-service: ${arn} vs preset ${preset.id}`);
      assert.equal(result.code, "cross_service", `motivo esperado cross_service: ${JSON.stringify(result)}`);
    }),
    { numRuns: 100 },
  );
});

test("Property 8: validateScope conserva la partición — válidos→accepted, inválidos→rejected", () => {
  const scenario = fc.constantFrom(...IAM_CATALOG).chain((preset) => {
    const own = serviceArnPrefix(preset.service);
    return fc.record({
      preset: fc.constant(preset),
      valid: fc.array(validArn(own), { maxLength: 10 }),
      malformed: fc.array(malformedArn, { maxLength: 8 }),
      cross: fc.array(crossServiceArn(preset), { maxLength: 8 }),
    });
  });
  fc.assert(
    fc.property(scenario, ({ preset, valid, malformed, cross }) => {
      // Lista mixta (≤26 ⇒ nunca supera el límite de 50).
      const invalid = [...malformed, ...cross];
      const all = [...valid, ...invalid];
      const result = validateScope(all, preset);

      // Dentro del límite.
      assert.equal(result.tooMany, false);

      const validTrimmed = new Set(valid.map((a) => a.trim()));

      // Todo ARN válido (deduplicado) aparece en accepted.
      for (const v of validTrimmed) {
        assert.ok(
          result.accepted.includes(v),
          `ARN válido ausente de accepted: ${v} (preset ${preset.id})`,
        );
      }

      // accepted contiene EXCLUSIVAMENTE ARNs válidos (ni cross ni malformados).
      for (const a of result.accepted) {
        assert.ok(
          validTrimmed.has(a),
          `accepted contiene un ARN no coherente con el preset: ${a} (preset ${preset.id})`,
        );
      }

      // accepted está deduplicado y ordenado lexicográficamente.
      assert.equal(new Set(result.accepted).size, result.accepted.length, "accepted con duplicados");
      const sorted = [...result.accepted].sort();
      assert.deepEqual(result.accepted, sorted, "accepted no está ordenado");

      // Todo ARN inválido aparece en rejected con un code estable.
      for (const inv of invalid) {
        const t = inv.trim();
        const hit = result.rejected.find((r) => r.arn === t);
        assert.ok(hit !== undefined, `ARN inválido ausente de rejected: ${JSON.stringify(t)} (preset ${preset.id})`);
        assert.equal(hit.valid, false);
        assert.ok(
          hit.code !== undefined && VALID_CODES.has(hit.code),
          `rechazo sin code válido: ${JSON.stringify(hit)}`,
        );
      }

      // Conservación: cada ARN de entrada no-blanco cae en accepted o rejected.
      for (const arn of all) {
        const t = arn.trim();
        if (t.length === 0) continue;
        const inAccepted = result.accepted.includes(t);
        const inRejected = result.rejected.some((r) => r.arn === t);
        assert.ok(inAccepted || inRejected, `ARN perdido (ni accepted ni rejected): ${JSON.stringify(t)}`);
      }
    }),
    { numRuns: 100 },
  );
});
