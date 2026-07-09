/**
 * i18n key parity tests for the dora-author-scoping feature — Task 7.2.
 *
 * Feature: dora-author-scoping, Task 7.2 "Test de paridad de claves i18n".
 *
 * Task 7.1 added 21 `metrics.dora.*` keys (ScopeBanner, DeploymentLevelBadge,
 * DoraEmptyState, AttributionCoverageNotice) to the 4 flat catalog files
 * `src/i18n/{es,en,fr,pt}.json` (lazy-loaded by `src/lib/i18n.tsx`).
 *
 * This test verifies that those new keys exist in ALL 4 languages with
 * IDENTICAL key sets — no missing keys, no orphans.
 *
 * Scoping decision:
 *   A full-catalog parity check would be stronger, but the catalogs are NOT
 *   currently at full parity (verified): vs es.json, en.json is missing 2 keys
 *   and pt.json / fr.json are each missing 46 keys. That drift is PRE-EXISTING
 *   and unrelated to this feature. To avoid failing on that pre-existing drift,
 *   the parity assertion is scoped to the `metrics.dora.*` keys this feature
 *   added (Requirement 7.1 of the task: "que las nuevas claves existen en los 4
 *   idiomas con conjuntos de claves idénticos"). A full-catalog parity guard is
 *   left as separate technical debt.
 *
 * Conventions: `node:test` + `node:assert/strict`, run with `tsx` (no network).
 *
 * _Requirements: 2.3, 2.4, 5.1, 5.2, 5.3, 5.5, 6.5, 7.5, 7.6_
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const LOCALES = ["es", "en", "pt", "fr"] as const;
type Locale = (typeof LOCALES)[number];

const DORA_PREFIX = "metrics.dora.";

/** The 21 keys task 7.1 added under the `metrics.dora.` prefix. */
const EXPECTED_DORA_KEYS = [
  "metrics.dora.scope.title",
  "metrics.dora.scope.team",
  "metrics.dora.scope.project",
  "metrics.dora.scope.authors",
  "metrics.dora.scope.allTeams",
  "metrics.dora.scope.allProjects",
  "metrics.dora.scope.allTeamsProjects",
  "metrics.dora.scope.noAuthorFilter",
  "metrics.dora.scope.moreAuthors",
  "metrics.dora.deploymentLevel.label",
  "metrics.dora.deploymentLevel.tooltip",
  "metrics.dora.emptyState.title",
  "metrics.dora.emptyState.authors",
  "metrics.dora.emptyState.deployments",
  "metrics.dora.emptyState.changes",
  "metrics.dora.emptyState.description",
  "metrics.dora.notAvailable",
  "metrics.dora.coverageNotice.warning",
  "metrics.dora.coverageNotice.coverage",
  "metrics.dora.coverageNotice.note",
  "metrics.dora.coverageNotice.unavailable",
] as const;

const __dirname = dirname(fileURLToPath(import.meta.url));
const I18N_DIR = resolve(__dirname, "../../i18n");

function loadCatalog(locale: Locale): Record<string, string> {
  const raw = readFileSync(resolve(I18N_DIR, `${locale}.json`), "utf8");
  const parsed = JSON.parse(raw) as Record<string, string>;
  return parsed;
}

const catalogs: Record<Locale, Record<string, string>> = {
  es: loadCatalog("es"),
  en: loadCatalog("en"),
  pt: loadCatalog("pt"),
  fr: loadCatalog("fr"),
};

function doraKeysOf(locale: Locale): Set<string> {
  return new Set(Object.keys(catalogs[locale]).filter((k) => k.startsWith(DORA_PREFIX)));
}

test("all 4 catalogs load and are non-empty flat objects", () => {
  for (const locale of LOCALES) {
    const cat = catalogs[locale];
    assert.equal(typeof cat, "object");
    assert.ok(Object.keys(cat).length > 0, `${locale}.json should have keys`);
  }
});

test("metrics.dora.* keys have full key-set parity across es/en/pt/fr (no missing, no orphans)", () => {
  const reference = doraKeysOf("es");

  // Sanity: the es catalog actually carries the new feature keys.
  assert.ok(reference.size > 0, "es.json should contain metrics.dora.* keys");

  for (const locale of LOCALES) {
    const keys = doraKeysOf(locale);

    const missing = [...reference].filter((k) => !keys.has(k)).sort();
    const orphans = [...keys].filter((k) => !reference.has(k)).sort();

    assert.deepEqual(
      missing,
      [],
      `${locale}.json is MISSING metrics.dora.* keys present in es.json: ${missing.join(", ")}`
    );
    assert.deepEqual(
      orphans,
      [],
      `${locale}.json has ORPHAN metrics.dora.* keys not present in es.json: ${orphans.join(", ")}`
    );
    assert.equal(
      keys.size,
      reference.size,
      `${locale}.json should have the same number of metrics.dora.* keys as es.json`
    );
  }
});

test("the 21 dora-author-scoping keys exist in all 4 languages with non-empty values", () => {
  // Guard against the expected-set itself drifting from the catalog.
  assert.equal(
    EXPECTED_DORA_KEYS.length,
    21,
    "expected exactly 21 metrics.dora.* keys for this feature"
  );

  const referenceKeys = doraKeysOf("es");
  assert.deepEqual(
    [...referenceKeys].sort(),
    [...EXPECTED_DORA_KEYS].sort(),
    "es.json metrics.dora.* keys should match the documented 21-key set"
  );

  for (const locale of LOCALES) {
    const cat = catalogs[locale];
    for (const key of EXPECTED_DORA_KEYS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(cat, key),
        `${locale}.json is missing required key "${key}"`
      );
      const value = cat[key];
      assert.equal(typeof value, "string", `${locale}.json "${key}" should be a string`);
      assert.ok(value.trim().length > 0, `${locale}.json "${key}" should be non-empty`);
    }
  }
});
