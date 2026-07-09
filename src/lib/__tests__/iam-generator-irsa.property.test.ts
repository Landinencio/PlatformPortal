// Feature: iam-role-least-privilege, Property 13: el HCL generado sigue el Patrón IRSA
/**
 * Property test de que el HCL generado sigue el Patrón IRSA.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/generator.ts
 *
 * Property 13: el HCL generado sigue el Patrón IRSA
 *   ∀ selección válida cubierta por el Catálogo_IAM (uno o más presets reales,
 *   con o sin Scope_De_Recurso, y cualquier subconjunto no vacío de entornos
 *   destino), `generateIamRoleHcl` produce HCL que sigue el Patron_IRSA nativo
 *   verificado en `iac/services/roles.tf` (NO módulos IAM):
 *     - un recurso `aws_iam_role` cuyo trust es
 *       `assume_role_policy = templatefile("role_templates/iskaypet_dh_access.json.tmpl", ...)`,
 *     - un recurso `aws_iam_policy` scoped (documento de política inline), y
 *     - un recurso `aws_iam_role_policy_attachment` que enlaza ambos.
 *
 * **Validates: Requirements 4.3**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  generateIamRoleHcl,
  isCoveredByCatalog,
  type PresetSelection,
} from "../iam-catalog/generator";
import { IAM_CATALOG } from "../iam-catalog/catalog";

/** Ids de preset reales del catálogo publicado (dominio de selección cubierta). */
const PRESET_IDS: readonly string[] = IAM_CATALOG.map((p) => p.id);

// Sanidad: el catálogo publica presets, de modo que `fc.constantFrom` sobre sus
// ids es un generador válido y la propiedad ejercita selecciones cubiertas.
test("Property 13: precondición — IAM_CATALOG expone presets", () => {
  assert.ok(PRESET_IDS.length > 0, "IAM_CATALOG no debería estar vacío");
});

/** Selección de un preset real (sin scope ⇒ usa defaultArnTemplate del preset). */
const presetSelectionArb: fc.Arbitrary<PresetSelection> = fc
  .constantFrom(...PRESET_IDS)
  .map((presetId) => ({ presetId }));

/** 1..8 selecciones de presets reales (posiblemente repetidos: se fusionan). */
const selectionsArb: fc.Arbitrary<PresetSelection[]> = fc.array(presetSelectionArb, {
  minLength: 1,
  maxLength: 8,
});

/** Subconjunto no vacío de los entornos destino disponibles. */
const targetEnvironmentsArb: fc.Arbitrary<string[]> = fc.oneof(
  fc
    .subarray(["dev", "uat", "prod"], { minLength: 1 })
    .filter((envs) => envs.length > 0),
  fc.constant(["tooling"]),
);

/** Nombre de rol y namespace no vacíos (campos obligatorios, 7.3). */
const roleNameArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .map((s) => `svc-${s.replace(/[^A-Za-z0-9_-]/g, "")}-role`);
const namespaceArb: fc.Arbitrary<string> = fc.constantFrom(
  "oms",
  "payments",
  "data-science",
  "marketplace",
  "n8n",
);

test("Property 13: el HCL generado sigue el Patrón IRSA nativo", () => {
  fc.assert(
    fc.property(
      roleNameArb,
      namespaceArb,
      selectionsArb,
      targetEnvironmentsArb,
      (roleName, namespace, selections, targetEnvironments) => {
        // Toda selección de ids reales está cubierta por el catálogo.
        assert.equal(
          isCoveredByCatalog(selections),
          true,
          "la selección debería estar cubierta por el catálogo",
        );

        const result = generateIamRoleHcl({
          roleName,
          namespace,
          selections,
          targetEnvironments,
        });

        assert.equal(
          result.ok,
          true,
          `generación fallida: ${result.ok ? "" : `${result.code} — ${result.detail}`}`,
        );
        if (!result.ok) return;

        const { hcl } = result;

        // 1) Recurso rol IAM (patrón nativo, no módulo IAM).
        assert.ok(
          hcl.includes('resource "aws_iam_role"'),
          `falta el recurso aws_iam_role:\n${hcl}`,
        );

        // 2) Trust vía templatefile del template IRSA canónico.
        assert.ok(
          hcl.includes(
            'templatefile("role_templates/iskaypet_dh_access.json.tmpl"',
          ),
          `falta el trust IRSA con templatefile:\n${hcl}`,
        );
        assert.ok(
          hcl.includes("assume_role_policy = templatefile("),
          `el trust debe asignarse a assume_role_policy:\n${hcl}`,
        );

        // 3) Política inline scoped.
        assert.ok(
          hcl.includes('resource "aws_iam_policy"'),
          `falta el recurso aws_iam_policy:\n${hcl}`,
        );

        // 4) Attachment que enlaza rol y política.
        assert.ok(
          hcl.includes('resource "aws_iam_role_policy_attachment"'),
          `falta el recurso aws_iam_role_policy_attachment:\n${hcl}`,
        );

        // NO usar módulos IAM (steering): el patrón es nativo.
        assert.ok(
          !/\bmodule\s+"/.test(hcl),
          `el HCL no debe usar módulos IAM:\n${hcl}`,
        );
      },
    ),
    { numRuns: 100 },
  );
});
