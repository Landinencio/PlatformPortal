// Feature: iam-role-least-privilege, Property 2: read-only sólo contiene acciones de lectura
/**
 * Property test de que los presets `read-only` sólo contienen acciones de lectura.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/catalog.ts (IAM_CATALOG)
 *                    + src/lib/iam-catalog/action-levels.ts (isReadOnlyAction)
 *
 * Property 2: read-only sólo contiene acciones de lectura
 *   ∀ Preset_IAM publicado con `accessLevel === "read-only"` y ∀ acción de su
 *   lista, `isReadOnlyAction(acción)` es true (la acción se clasifica como
 *   nivel AWS List o Read, nunca Write, Permissions management ni Tagging).
 *
 * El espacio de entrada es el conjunto de presets read-only del catálogo
 * publicado; `fast-check` muestrea un preset y una de sus acciones en cada
 * ejecución para ejercitar el invariante sobre toda la colección.
 *
 * **Validates: Requirements 1.5**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { isReadOnlyAction } from "../iam-catalog/action-levels";
import { IAM_CATALOG } from "../iam-catalog/catalog";
import type { IamPreset } from "../iam-catalog/catalog";

/** Presets read-only reales del catálogo publicado. */
const READ_ONLY_PRESETS: readonly IamPreset[] = IAM_CATALOG.filter(
  (p) => p.accessLevel === "read-only",
);

// Sanidad: el catálogo debe exponer al menos un preset read-only para que la
// propiedad tenga sentido.
test("Property 2: precondición — el catálogo expone presets read-only", () => {
  assert.ok(READ_ONLY_PRESETS.length > 0, "no hay presets read-only en IAM_CATALOG");
});

test("Property 2: toda acción de un preset read-only es de lectura (List/Read)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: READ_ONLY_PRESETS.length - 1 }).map((i) => READ_ONLY_PRESETS[i]),
      (preset) => {
        for (const action of preset.actions) {
          assert.equal(
            isReadOnlyAction(action),
            true,
            `preset read-only "${preset.id}" contiene una acción no de lectura: "${action}"`,
          );
        }
      },
    ),
    { numRuns: 100 },
  );
});
