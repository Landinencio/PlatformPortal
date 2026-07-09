// Feature: iam-role-least-privilege, Property 21: partición de ARNs managed por veredicto
/**
 * Property test for the partition of managed policy ARNs by verdict.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/validator.ts (validateManagedPolicyArn)
 *
 * Property 21: partición de ARNs managed por veredicto
 *   Para toda lista de ARNs de managed policy, particionarla aplicando
 *   `validateManagedPolicyArn` a cada ARN produce dos grupos coherentes ARN a
 *   ARN con el veredicto individual: los ARNs con veredicto `Politica_Admin`
 *   caen en "rechazados" (siempre con `rule`/motivo) y el resto (`aceptable`)
 *   se conserva en "aceptados". La partición es exhaustiva y disjunta, y
 *   preserva el contenido y el orden de la lista de entrada.
 *
 * **Validates: Requirements 6.5**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { validateManagedPolicyArn } from "../iam-catalog/validator";

/** Cuenta válida en un ARN de managed policy: la partición AWS o 12 dígitos. */
const accountArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant("aws"),
  fc
    .integer({ min: 0, max: 999999999999 })
    .map((n) => n.toString().padStart(12, "0")),
);

/** Prefijo de path opcional del nombre de la managed policy (p.ej. "service-role/"). */
const pathPrefixArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  fc.constant("service-role/"),
  fc.constant("aws-service-role/foo/"),
);

/** Token alfanumérico seguro cuyo lowercase NO es admin (ni FullAccess ni Administrator). */
const safeSegmentArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[A-Za-z0-9]{1,24}$/)
  .filter((s) => {
    const lower = s.toLowerCase();
    return !lower.endsWith("fullaccess") && !lower.includes("administrator");
  });

/** ARN de managed policy bien formado y NO admin → veredicto `aceptable`. */
const acceptableArnArb: fc.Arbitrary<{ arn: string; expectAccepted: boolean }> =
  fc
    .tuple(accountArb, pathPrefixArb, safeSegmentArb)
    .map(([account, prefix, name]) => ({
      arn: `arn:aws:iam::${account}:policy/${prefix}${name}`,
      expectAccepted: true,
    }));

/** ARN de managed policy cuyo nombre termina en FullAccess (varias capitalizaciones). */
const fullAccessArnArb: fc.Arbitrary<{ arn: string; expectAccepted: boolean }> =
  fc
    .tuple(
      accountArb,
      pathPrefixArb,
      safeSegmentArb,
      fc.constantFrom("FullAccess", "fullaccess", "FULLACCESS", "FullACCESS"),
    )
    .map(([account, prefix, base, suffix]) => ({
      arn: `arn:aws:iam::${account}:policy/${prefix}${base}${suffix}`,
      expectAccepted: false,
    }));

/** ARN de managed policy cuyo nombre contiene Administrator (sin terminar en FullAccess). */
const administratorArnArb: fc.Arbitrary<{
  arn: string;
  expectAccepted: boolean;
}> = fc
  .tuple(
    accountArb,
    pathPrefixArb,
    fc.constantFrom(
      "AdministratorAccess",
      "administrator",
      "MyADMINISTRATORrole",
      "OrgAdministratorPolicy",
    ),
  )
  .map(([account, prefix, name]) => ({
    arn: `arn:aws:iam::${account}:policy/${prefix}${name}`,
    expectAccepted: false,
  }));

/** Strings que NO son un ARN de managed policy válido → veredicto Politica_Admin. */
const invalidArnArb: fc.Arbitrary<{ arn: string; expectAccepted: boolean }> = fc
  .oneof(
    fc.constant(""),
    fc.constant("   "),
    fc.constant("not-an-arn"),
    fc.constant("arn:aws:s3:::my-bucket"),
    fc.constant("arn:aws:iam::123456789012:role/foo"),
    fc.constant("arn:aws:iam::abc:policy/Foo"),
    fc.constant("arn:aws:iam::123456789012:policy/"),
    // Cadenas arbitrarias que no empiezan por el prefijo de un ARN IAM.
    fc.string().filter((s) => !s.trim().startsWith("arn:aws:iam::")),
  )
  .map((arn) => ({ arn, expectAccepted: false }));

/** Entrada mixta: cualquiera de las clases anteriores, etiquetada con su expectativa. */
const managedArnArb = fc.oneof(
  acceptableArnArb,
  fullAccessArnArb,
  administratorArnArb,
  invalidArnArb,
);

test("Property 21: la partición por veredicto coincide ARN a ARN con validateManagedPolicyArn", () => {
  fc.assert(
    fc.property(fc.array(managedArnArb), (tagged) => {
      const arns = tagged.map((t) => t.arn);

      // Partición determinista aplicando el validador a cada ARN.
      const accepted: string[] = [];
      const rejected: { arn: string; rule?: string }[] = [];
      for (const arn of arns) {
        const result = validateManagedPolicyArn(arn);
        if (result.verdict === "aceptable") {
          accepted.push(arn);
        } else {
          rejected.push({ arn, rule: result.rule });
        }
      }

      // Exhaustiva y disjunta: cada ARN cae en exactamente un grupo.
      assert.equal(
        accepted.length + rejected.length,
        arns.length,
        "la partición debe cubrir todos los ARNs sin solaparse",
      );

      // Los rechazados (Politica_Admin) siempre llevan un motivo (`rule`).
      for (const r of rejected) {
        assert.ok(
          typeof r.rule === "string" && r.rule.length > 0,
          `ARN rechazado sin motivo: ${JSON.stringify(r.arn)}`,
        );
      }

      // Coincidencia ARN a ARN con la expectativa del generador y conservación
      // de contenido + orden respecto a la lista de entrada.
      const expectedAccepted = tagged.filter((t) => t.expectAccepted).map((t) => t.arn);
      const expectedRejected = tagged.filter((t) => !t.expectAccepted).map((t) => t.arn);
      assert.deepEqual(accepted, expectedAccepted);
      assert.deepEqual(
        rejected.map((r) => r.arn),
        expectedRejected,
      );
    }),
    { numRuns: 100 },
  );
});
