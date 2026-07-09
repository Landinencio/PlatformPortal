/**
 * Property-based test for the presence of the `common.back` i18n key.
 *
 * Feature: session-nav-hardening, Task 1.4.
 *
 * The BotonVolver label (Frente B) resolves via `resolveLabelWithSpanishFallback`
 * which needs `common.back` to carry visible text in every locale so the button
 * is never rendered empty (R7.1, R7.7). This test guards that invariant across
 * the four flat catalogs `src/i18n/{es,en,pt,fr}.json` (lazy-loaded by
 * `src/lib/i18n.tsx`), reusing the canonical `hasVisibleText` predicate.
 *
 * Conventions: `node:test` + `node:assert/strict`, `fast-check` at { numRuns: 100 },
 * run with `tsx` (no network).
 *
 * **Validates: Requirements 7.1, 7.7**
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as fc from "fast-check";

import { hasVisibleText } from "../i18n/label-fallback";

const LOCALES = ["es", "en", "pt", "fr"] as const;
type Locale = (typeof LOCALES)[number];

const BACK_KEY = "common.back";

const __dirname = dirname(fileURLToPath(import.meta.url));
const I18N_DIR = resolve(__dirname, "../../i18n");

function loadCatalog(locale: Locale): Record<string, string> {
  const raw = readFileSync(resolve(I18N_DIR, `${locale}.json`), "utf8");
  return JSON.parse(raw) as Record<string, string>;
}

const catalogs: Record<Locale, Record<string, string>> = {
  es: loadCatalog("es"),
  en: loadCatalog("en"),
  pt: loadCatalog("pt"),
  fr: loadCatalog("fr"),
};

/* ------------------------------------------------------------------ */
/*  Property 11: The `common.back` key is present and has visible text */
/*  in the four locales.                                               */
/*  **Validates: Requirements 7.1, 7.7**                               */
/* ------------------------------------------------------------------ */

// Feature: session-nav-hardening, Property 11: La clave common.back está presente y con texto visible en los cuatro locales
test("Property 11: common.back is present with visible text in every locale", () => {
  fc.assert(
    fc.property(fc.constantFrom<Locale>(...LOCALES), (locale) => {
      const value = catalogs[locale][BACK_KEY];
      assert.ok(
        hasVisibleText(value),
        `Locale "${locale}" must define ${BACK_KEY} with visible text, got: ${JSON.stringify(value)}`,
      );
    }),
    { numRuns: 100 },
  );
});
