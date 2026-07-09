/**
 * Unit tests de invariantes globales del Catálogo_IAM.
 *
 * Feature: iam-role-least-privilege — src/lib/iam-catalog/catalog.ts
 *
 * Cubre (task 1.8):
 *  - Conteos globales como cotas documentadas (>= 40 presets, >= 22 servicios)
 *    y `CATALOG_SCHEMA_VERSION` entero >= 1 (R1.3, R1.4).
 *  - Inmutabilidad del catálogo publicado: la colección y cada preset (incluida
 *    su lista de acciones) están congelados; un intento de mutación no altera el
 *    estado observable (R1.6).
 *  - Caso de catálogo vacío para `buildFormOptions` → lista vacía (R2.6).
 *
 * Tests deterministas por ejemplo (complementan las property tests 1.3–1.7):
 * ejercitan las invariantes exactas sobre el `IAM_CATALOG` real publicado.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  IAM_CATALOG,
  CATALOG_SCHEMA_VERSION,
  buildFormOptions,
} from "../iam-catalog/catalog";
import type { IamPreset } from "../iam-catalog/catalog";

// ─── Conteos globales (cotas documentadas, R1.3) ───

test("IAM_CATALOG publica al menos 40 presets (cota documentada)", () => {
  assert.ok(
    IAM_CATALOG.length >= 40,
    `esperado >= 40 presets, obtenido ${IAM_CATALOG.length}`,
  );
});

test("IAM_CATALOG cubre al menos 22 servicios distintos (cota documentada)", () => {
  const services = new Set(IAM_CATALOG.map((p) => p.service));
  assert.ok(
    services.size >= 22,
    `esperado >= 22 servicios, obtenido ${services.size}`,
  );
});

test("los ids de preset publicados son únicos", () => {
  const ids = IAM_CATALOG.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "hay ids de preset duplicados");
});

// ─── CATALOG_SCHEMA_VERSION entero >= 1 (R1.4) ───

test("CATALOG_SCHEMA_VERSION es un entero >= 1", () => {
  assert.equal(typeof CATALOG_SCHEMA_VERSION, "number");
  assert.ok(
    Number.isInteger(CATALOG_SCHEMA_VERSION),
    `CATALOG_SCHEMA_VERSION debe ser entero, obtenido ${String(CATALOG_SCHEMA_VERSION)}`,
  );
  assert.ok(
    CATALOG_SCHEMA_VERSION >= 1,
    `CATALOG_SCHEMA_VERSION debe ser >= 1, obtenido ${CATALOG_SCHEMA_VERSION}`,
  );
});

// ─── Inmutabilidad (R1.6) ───

test("la colección IAM_CATALOG está congelada", () => {
  assert.ok(Object.isFrozen(IAM_CATALOG), "IAM_CATALOG no está congelado");
});

test("cada preset del catálogo y su lista de acciones están congelados", () => {
  for (const preset of IAM_CATALOG) {
    assert.ok(Object.isFrozen(preset), `preset ${preset.id} no está congelado`);
    assert.ok(
      Object.isFrozen(preset.actions),
      `las acciones del preset ${preset.id} no están congeladas`,
    );
  }
});

test("un intento de mutar la colección no altera el estado", () => {
  const before = IAM_CATALOG.length;
  const firstId = IAM_CATALOG[0]?.id;

  // Mutación sobre la colección congelada: en modo no estricto es un no-op; el
  // cast evita el error de tipos de TS sobre un `readonly` array.
  try {
    (IAM_CATALOG as unknown as IamPreset[]).push(
      IAM_CATALOG[0] as IamPreset,
    );
  } catch {
    // Object.freeze en strict mode lanza al intentar mutar: aceptable.
  }
  try {
    (IAM_CATALOG as unknown as IamPreset[])[0] = {
      ...(IAM_CATALOG[0] as IamPreset),
      id: "tampered",
    };
  } catch {
    // idem
  }

  assert.equal(IAM_CATALOG.length, before, "el tamaño del catálogo cambió");
  assert.equal(IAM_CATALOG[0]?.id, firstId, "el primer preset fue reemplazado");
});

test("un intento de mutar un preset no altera sus campos", () => {
  const preset = IAM_CATALOG[0] as IamPreset;
  const originalId = preset.id;
  const originalActionsLength = preset.actions.length;

  try {
    (preset as { id: string }).id = "tampered";
  } catch {
    // strict mode lanza: aceptable
  }
  try {
    (preset.actions as unknown as string[]).push("iam:*");
  } catch {
    // strict mode lanza: aceptable
  }

  assert.equal(preset.id, originalId, "el id del preset fue mutado");
  assert.equal(
    preset.actions.length,
    originalActionsLength,
    "la lista de acciones del preset fue mutada",
  );
});

// ─── Catálogo vacío para buildFormOptions (R2.6) ───

test("buildFormOptions([]) devuelve una lista vacía", () => {
  const options = buildFormOptions([]);
  assert.ok(Array.isArray(options), "buildFormOptions debe devolver un array");
  assert.equal(options.length, 0, "un catálogo vacío no produce opciones");
});
