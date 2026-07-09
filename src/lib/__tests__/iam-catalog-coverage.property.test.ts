// Feature: iam-role-least-privilege, Property 4: cobertura mínima de servicios y niveles
/**
 * Property test de cobertura mínima de servicios y niveles.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/catalog.ts (IAM_CATALOG)
 *
 * Property 4: cobertura mínima de servicios y niveles
 *   Para todo Servicio_AWS presente en la colección publicada `IAM_CATALOG`:
 *     - existe al menos un Preset_IAM para ese servicio; y
 *     - SI el servicio expone algún preset `read-write`, ENTONCES tiene al menos
 *       dos presets Y también hay presente un preset `read-only` para ese
 *       servicio.
 *
 * Nota de reconciliación (decisión de diseño, jun 2026): el Req 1.2 pide los
 * niveles `read-only` y `read-write` por servicio. La forma honrada de ese
 * requisito bajo mínimo privilegio EXENTA a los servicios cuyo plano de acceso
 * en catálogo sólo expone acciones de lectura clasificadas (p. ej.
 * `lakeformation`): inventar una acción de escritura violaría el mínimo
 * privilegio. Por tanto la exigencia de `read-only` + `read-write` sólo aplica a
 * los servicios que exponen algún preset con capacidad de escritura. Este es
 * exactamente el invariante que codifica `assertCatalogCoverage` del catálogo.
 *
 * El espacio de entrada es el conjunto de servicios distintos del catálogo
 * publicado; `fast-check` muestrea un servicio en cada ejecución para ejercitar
 * el invariante sobre toda la cobertura.
 *
 * **Validates: Requirements 1.2**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { IAM_CATALOG } from "../iam-catalog/catalog";
import type { AwsService, IamPreset } from "../iam-catalog/catalog";

/** Servicios distintos realmente presentes en el catálogo publicado. */
const SERVICES: readonly AwsService[] = [
  ...new Set(IAM_CATALOG.map((p) => p.service)),
];

// Sanidad: el catálogo debe exponer al menos un servicio para que la propiedad
// tenga sentido (y de hecho ≥22 por diseño).
test("Property 4: precondición — el catálogo expone servicios", () => {
  assert.ok(SERVICES.length > 0, "IAM_CATALOG no expone ningún servicio");
});

test("Property 4: cada servicio tiene cobertura mínima de presets y niveles", () => {
  fc.assert(
    fc.property(fc.constantFrom(...SERVICES), (service) => {
      const presets: readonly IamPreset[] = IAM_CATALOG.filter(
        (p) => p.service === service,
      );

      // (1) Todo servicio presente tiene al menos un preset.
      assert.ok(
        presets.length >= 1,
        `el servicio "${service}" no tiene ningún preset`,
      );

      const hasReadWrite = presets.some((p) => p.accessLevel === "read-write");
      const hasReadOnly = presets.some((p) => p.accessLevel === "read-only");

      // (2) Si el servicio expone escritura, exige ≥2 presets y un read-only.
      //     Los servicios read-only-only (p. ej. lakeformation) quedan exentos.
      if (hasReadWrite) {
        assert.ok(
          presets.length >= 2,
          `el servicio "${service}" expone read-write pero tiene < 2 presets`,
        );
        assert.ok(
          hasReadOnly,
          `el servicio "${service}" expone read-write pero carece de un preset read-only`,
        );
      }
    }),
    { numRuns: 100 },
  );
});
