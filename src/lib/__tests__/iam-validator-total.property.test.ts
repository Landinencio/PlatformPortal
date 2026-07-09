// Feature: iam-role-least-privilege, Property 18: el Validador_IAM es total y default-deny
/**
 * Property test de que el Validador_IAM es total y default-deny.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/validator.ts
 *
 * Property 18: el Validador_IAM es total y default-deny
 *   ∀ entrada arbitraria (cadenas vacías, texto no-JSON, documentos de política
 *   malformados, ARNs inválidos): `validateIamPolicyAdmin` y
 *   `validateManagedPolicyArn` nunca lanzan y devuelven un veredicto que es
 *   exactamente uno de { "aceptable", "Politica_Admin" } (5.1). Toda entrada
 *   vacía o malformada (o ARN inválido) obtiene el veredicto "Politica_Admin"
 *   por defecto — default-deny (5.2). Todo veredicto "Politica_Admin" incluye
 *   una `rule` concreta que identifica el motivo del rechazo (5.3).
 *
 * **Validates: Requirements 5.1, 5.2, 5.3**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  validateIamPolicyAdmin,
  validateManagedPolicyArn,
} from "../iam-catalog/validator";
import type { IamValidationResult } from "../iam-catalog/validator";

/** Veredictos válidos — espejo del tipo `IamVerdict`. */
const VALID_VERDICTS = new Set<string>(["aceptable", "Politica_Admin"]);

/** Reglas de rechazo válidas — espejo del tipo `IamAdminRule`. */
const VALID_RULES = new Set<string>([
  "empty_or_malformed",
  "managed_full_access",
  "managed_administrator",
  "wildcard_action_on_all_resources",
  "invalid_managed_arn",
]);

/**
 * Aserta las invariantes universales de todo resultado del validador:
 *  - veredicto ∈ {aceptable, Politica_Admin} (5.1)
 *  - si es Politica_Admin ⇒ trae una `rule` válida (5.3)
 *  - si es aceptable ⇒ no trae `rule`
 */
function assertWellFormed(result: IamValidationResult): void {
  assert.ok(
    VALID_VERDICTS.has(result.verdict),
    `Veredicto inválido: ${JSON.stringify(result.verdict)}`,
  );
  if (result.verdict === "Politica_Admin") {
    assert.ok(
      result.rule !== undefined && VALID_RULES.has(result.rule),
      `Politica_Admin sin rule válida: ${JSON.stringify(result)}`,
    );
  } else {
    assert.equal(
      result.rule,
      undefined,
      `aceptable no debe traer rule: ${JSON.stringify(result)}`,
    );
  }
}

/**
 * Generador de entradas arbitrarias para el validador: mezcla de basura
 * totalmente libre con fragmentos representativos (texto no-JSON, documentos
 * de política JSON/HCL malformados, nombres/ARNs de managed policy plausibles).
 */
const arbitraryPolicyInput: fc.Arbitrary<string> = fc.oneof(
  // Basura arbitraria (incluye vacíos, unicode, saltos de línea).
  fc.string(),
  // Sólo espacios en blanco (se trata como ausencia → default-deny).
  fc.constantFrom("", " ", "   ", "\t", "\n", "  \n\t "),
  // Texto no-JSON plausible.
  fc.constantFrom(
    "not a policy",
    "arn:aws:iam::123456789012:policy/SomeReadOnly",
    "AmazonS3ReadOnlyAccess",
    "AmazonS3FullAccess",
    "AdministratorAccess",
    "path/to/AdministratorAccess",
    "some/nested/path/ServiceFullAccess",
  ),
  // Documentos JSON malformados (empiezan por { o [ pero no parsean → 5.2).
  fc.constantFrom(
    "{",
    "[",
    '{"Version":',
    '{"Statement": [ {',
    "[ {,, ] }",
    '{"Statement": [ { "Effect": "Allow", ',
  ),
  // Documentos JSON bien formados variados.
  fc.constantFrom(
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::b/*"]}]}',
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}',
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:*"],"Resource":["*"]}]}',
    '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"*","Resource":"*"}]}',
  ),
  // Fragmentos HCL plausibles.
  fc.constantFrom(
    'resource "aws_iam_policy" "x" { policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["sqs:SendMessage"], Resource = ["arn:aws:sqs:eu-west-1:123456789012:q"] }] }) }',
    'policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "*", Resource = "*" }] })',
  ),
);

/** Generador de ARNs de managed policy: válidos, inválidos y admin. */
const arbitraryManagedArn: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.constantFrom(
    "",
    "   ",
    "not-an-arn",
    "arn:aws:iam::123456789012:role/foo", // no es policy
    "arn:aws:s3:::bucket", // servicio equivocado
    "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
    "arn:aws:iam::aws:policy/AdministratorAccess",
    "arn:aws:iam::aws:policy/AmazonS3FullAccess",
    "arn:aws:iam::123456789012:policy/team/CustomReadOnly",
    "arn:aws:iam::123456789012:policy/path/to/ServiceFullAccess",
  ),
);

test("Property 18: validateIamPolicyAdmin es total — nunca lanza y el veredicto es well-formed", () => {
  fc.assert(
    fc.property(arbitraryPolicyInput, (input) => {
      const result = validateIamPolicyAdmin(input);
      assertWellFormed(result);
    }),
    { numRuns: 100 },
  );
});

test("Property 18: validateManagedPolicyArn es total — nunca lanza y el veredicto es well-formed", () => {
  fc.assert(
    fc.property(arbitraryManagedArn, (arn) => {
      const result = validateManagedPolicyArn(arn);
      assertWellFormed(result);
    }),
    { numRuns: 100 },
  );
});

test("Property 18: entrada vacía o sólo-espacios ⇒ default-deny (Politica_Admin con rule)", () => {
  const blankArb = fc.constantFrom("", " ", "   ", "\t", "\n", "  \n\t ");
  fc.assert(
    fc.property(blankArb, (blank) => {
      const result = validateIamPolicyAdmin(blank);
      assert.equal(result.verdict, "Politica_Admin");
      assert.equal(result.rule, "empty_or_malformed");
      const arnResult = validateManagedPolicyArn(blank);
      assert.equal(arnResult.verdict, "Politica_Admin");
      assert.equal(arnResult.rule, "invalid_managed_arn");
    }),
    { numRuns: 100 },
  );
});

test("Property 18: documento JSON malformado ⇒ default-deny (Politica_Admin, empty_or_malformed)", () => {
  // Prefijo { o [ que rompe el parseo JSON → malformado (5.2).
  const malformedJsonArb: fc.Arbitrary<string> = fc
    .constantFrom("{", "[")
    .chain((prefix) =>
      fc.string().map((rest) => {
        // Aseguramos que no parsee como JSON válido: prefijo abierto + basura,
        // sin cerrar la estructura.
        return `${prefix}${rest.replace(/[}\]]/g, "")}`;
      }),
    );
  fc.assert(
    fc.property(malformedJsonArb, (doc) => {
      const result = validateIamPolicyAdmin(doc);
      assert.equal(result.verdict, "Politica_Admin");
      assert.equal(result.rule, "empty_or_malformed");
    }),
    { numRuns: 100 },
  );
});

test("Property 18: ARN de managed policy con formato inválido ⇒ default-deny (invalid_managed_arn)", () => {
  // Cadenas no vacías que NO casan el patrón arn:aws:iam::(aws|12d):policy/...
  const invalidArnArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1 })
    .filter((s) => {
      const t = s.trim();
      return t.length > 0 && !/^arn:aws:iam::(?:aws|\d{12}):policy\/.+$/.test(t);
    });
  fc.assert(
    fc.property(invalidArnArb, (arn) => {
      const result = validateManagedPolicyArn(arn);
      assert.equal(result.verdict, "Politica_Admin");
      assert.equal(result.rule, "invalid_managed_arn");
    }),
    { numRuns: 100 },
  );
});
