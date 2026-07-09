// Feature: iam-role-least-privilege, Property 3: buildPublishedCatalog descarta lo inválido
/**
 * Property test de que `buildPublishedCatalog` descarta lo inválido.
 *
 * Feature: iam-role-least-privilege
 * Module under test: src/lib/iam-catalog/catalog.ts
 *
 * Property 3: buildPublishedCatalog descarta lo inválido
 *   ∀ lista cruda de presets que mezcle presets válidos, identificadores
 *   duplicados, listas de acciones vacías y acciones del plano de datos RDS,
 *   la colección publicada por `buildPublishedCatalog`:
 *     - NO contiene ningún identificador duplicado (se excluyen TODOS los que
 *       colisionan) (1.9),
 *     - NO contiene ningún preset con lista de acciones vacía (1.9),
 *     - NO contiene ningún preset con acciones del plano de datos RDS (1.7),
 *     - CONSERVA los presets válidos cuyo id no colisiona con ningún otro,
 *   y además es inmutable (colección y presets congelados) (1.6).
 *
 * NOTA de aislamiento: `buildPublishedCatalog` también descarta presets
 * `read-only` con acciones que no sean de nivel List/Read. Para que ese filtro
 * NO interfiera con la propiedad bajo prueba, los presets VÁLIDOS generados usan
 * `accessLevel` `read-write`/`custom-actions` (a los que ese filtro no aplica),
 * de modo que su única característica es ser estructuralmente correctos.
 *
 * **Validates: Requirements 1.9, 1.7**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { buildPublishedCatalog } from "../iam-catalog/catalog";
import type { AccessLevel, IamPreset, ServiceFamily } from "../iam-catalog/catalog";
import { isRdsDataPlaneAction } from "../iam-catalog/action-levels";

/** Acciones del plano de datos RDS que deben provocar exclusión (1.7). */
const RDS_DATAPLANE_ACTIONS = [
  "rds-db:connect",
  "rds-data:ExecuteStatement",
  "rds-data:BatchExecuteStatement",
  "rds:Connect",
  "rds:connect",
] as const;

/** Familias válidas para el campo `family`. */
const FAMILIES: readonly ServiceFamily[] = ["application", "data-analytics"];

/**
 * `accessLevel` de los presets válidos: se excluye deliberadamente `read-only`
 * para aislar la propiedad del filtro de acciones de lectura (ver NOTA arriba).
 */
const NON_READONLY_LEVELS: readonly AccessLevel[] = ["read-write", "custom-actions"];

/**
 * Construye una lista de `count` acciones seguras y distintas (nunca del plano
 * de datos RDS) a partir de una base. La unicidad la garantiza el índice.
 */
function safeActions(base: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `svc-${base}:Action${i}`);
}

/** Construye un `IamPreset` estructuralmente válido (sobrevive al filtrado). */
function validPreset(id: string, level: AccessLevel, family: ServiceFamily, nActions: number): IamPreset {
  return {
    id,
    service: "s3",
    family,
    accessLevel: level,
    labelKey: `iam.preset.${id}`,
    actions: safeActions(id, nActions),
    defaultArnTemplate: "arn:aws:s3:::*",
    scopable: true,
    allowWildcards: true,
  };
}

/**
 * Genera un caso de prueba: cuatro categorías de presets con ids namespaced
 * (prefijos disjuntos, sin colisiones cruzadas) de modo que la ÚNICA razón de
 * exclusión de cada categoría inválida sea su propio defecto:
 *   - `valid-*`: válidos y con id único → deben CONSERVARSE.
 *   - `dup-*`:   por lo demás válidos pero con id repetido → TODOS excluidos.
 *   - `empty-*`: id único pero `actions` vacía → excluidos.
 *   - `rds-*`:   id único pero con una acción del plano de datos RDS → excluidos.
 */
const caseArb = fc.record({
  // Presets válidos únicos.
  valid: fc.array(
    fc.record({
      level: fc.constantFrom(...NON_READONLY_LEVELS),
      family: fc.constantFrom(...FAMILIES),
      nActions: fc.integer({ min: 1, max: 8 }),
    }),
    { minLength: 1, maxLength: 6 },
  ),
  // Grupos de ids duplicados (cada grupo aparece ≥2 veces).
  dupGroups: fc.array(fc.integer({ min: 2, max: 3 }), { minLength: 0, maxLength: 3 }),
  // Cuántos presets con acciones vacías.
  emptyCount: fc.integer({ min: 0, max: 3 }),
  // Cuántos presets con acción RDS data-plane.
  rdsCount: fc.integer({ min: 0, max: 3 }),
});

test("Property 3: buildPublishedCatalog conserva los válidos y descarta lo inválido", () => {
  fc.assert(
    fc.property(caseArb, (spec) => {
      const raw: IamPreset[] = [];

      // Categoría válida (ids únicos → deben sobrevivir).
      const validIds: string[] = [];
      spec.valid.forEach((v, i) => {
        const id = `valid-${i}`;
        validIds.push(id);
        raw.push(validPreset(id, v.level, v.family, v.nActions));
      });

      // Ids duplicados (todos deben excluirse).
      const dupIds: string[] = [];
      spec.dupGroups.forEach((size, g) => {
        const id = `dup-${g}`;
        dupIds.push(id);
        for (let k = 0; k < size; k++) {
          // Cada réplica es por lo demás válida: la única razón de exclusión
          // es la colisión de identificador.
          raw.push(validPreset(id, "read-write", "application", 3));
        }
      });

      // Presets con acciones vacías (id único, excluidos por `actions` vacía).
      const emptyIds: string[] = [];
      for (let k = 0; k < spec.emptyCount; k++) {
        const id = `empty-${k}`;
        emptyIds.push(id);
        raw.push({
          id,
          service: "s3",
          family: "application",
          accessLevel: "read-write",
          labelKey: `iam.preset.${id}`,
          actions: [],
          defaultArnTemplate: "arn:aws:s3:::*",
          scopable: true,
          allowWildcards: false,
        });
      }

      // Presets con acción del plano de datos RDS (id único, excluidos por 1.7).
      const rdsIds: string[] = [];
      for (let k = 0; k < spec.rdsCount; k++) {
        const id = `rds-${k}`;
        rdsIds.push(id);
        const rdsAction = RDS_DATAPLANE_ACTIONS[k % RDS_DATAPLANE_ACTIONS.length];
        raw.push({
          id,
          service: "s3",
          family: "application",
          accessLevel: "read-write",
          labelKey: `iam.preset.${id}`,
          // Mezcla de acciones seguras + una RDS → debe excluirse el preset entero.
          actions: [...safeActions(id, 2), rdsAction],
          defaultArnTemplate: "arn:aws:s3:::*",
          scopable: true,
          allowWildcards: false,
        });
      }

      const published = buildPublishedCatalog(raw);
      const publishedIds = published.map((p) => p.id);
      const publishedIdSet = new Set(publishedIds);

      // (1) Sin identificadores duplicados en la colección publicada.
      assert.equal(
        publishedIdSet.size,
        publishedIds.length,
        `hay ids duplicados en la colección publicada: ${JSON.stringify(publishedIds)}`,
      );

      // (2) Ningún id duplicado del crudo aparece publicado.
      for (const id of dupIds) {
        assert.ok(!publishedIdSet.has(id), `el id duplicado "${id}" no debería publicarse`);
      }

      // (3) Ningún preset con acciones vacías aparece publicado.
      for (const id of emptyIds) {
        assert.ok(!publishedIdSet.has(id), `el preset vacío "${id}" no debería publicarse`);
      }
      for (const p of published) {
        assert.ok(p.actions.length > 0, `preset publicado "${p.id}" con acciones vacías`);
      }

      // (4) Ningún preset con acción del plano de datos RDS aparece publicado.
      for (const id of rdsIds) {
        assert.ok(!publishedIdSet.has(id), `el preset RDS "${id}" no debería publicarse`);
      }
      for (const p of published) {
        assert.ok(
          !p.actions.some((a) => isRdsDataPlaneAction(a)),
          `preset publicado "${p.id}" contiene una acción del plano de datos RDS`,
        );
      }

      // (5) Se conservan EXACTAMENTE los válidos no colisionantes.
      assert.deepEqual(
        [...publishedIdSet].sort(),
        [...validIds].sort(),
        "la colección publicada debe contener exactamente los presets válidos únicos",
      );

      // (6) Inmutabilidad: colección y presets (con sus acciones) congelados (1.6).
      assert.ok(Object.isFrozen(published), "la colección publicada debe estar congelada");
      for (const p of published) {
        assert.ok(Object.isFrozen(p), `el preset "${p.id}" debe estar congelado`);
        assert.ok(Object.isFrozen(p.actions), `las acciones de "${p.id}" deben estar congeladas`);
      }
    }),
    { numRuns: 100 },
  );
});
