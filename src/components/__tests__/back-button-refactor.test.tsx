/**
 * Static substitution test for the "back button" refactor.
 *
 * Feature: session-nav-hardening, Task 15.3
 *
 * This is a STATIC / source-contract test: it reads the relevant component
 * source files from disk with `node:fs` and asserts on their text, WITHOUT a
 * DOM or React renderer (consistent with the repo's `tsx --test` runner and the
 * pattern used by `src/lib/__tests__/comparison-explorer.test.ts`). It only
 * inspects files, opens nothing asynchronous and exits cleanly.
 *
 * What it guards:
 *
 *  - R6.3: the six pages/components that previously carried their OWN inline
 *    "volver"/"back" control no longer do so. The single Boton_Volver is now
 *    anchored once in `portal-shell.tsx` (design D4), so each of these files
 *    must be free of inline back-navigation controls (no back-arrow lucide
 *    icons, no hardcoded "Volver …"/"Back to …" labels, and no local
 *    re-introduction of `<BotonVolver/>`).
 *
 *  - R6.4: `finops/comparison-explorer.tsx` — whose breadcrumb navigates
 *    between INTERNAL levels (account → service → resource) rather than between
 *    routes — reuses the single Boton_Volver component with an EXPLICIT
 *    navigation prop instead of an inline control.
 *
 *    NOTE ON THE R6.4 NAVIGATION PROP.
 *    The requirement text (R6.4) phrases the reuse as "con una propiedad de
 *    destino explícita" (an explicit `destination`). During implementation
 *    (task 15.2) the explorer was wired with the component's `onClick` escape
 *    hatch instead of `destination`, because the breadcrumb navigates between
 *    internal levels by LOCAL STATE (drill-down), where there is no route to
 *    push: a `destination`/`router.push` would break the view and eject the
 *    user from the explorer. `BotonVolver` was deliberately given an `onClick`
 *    prop for exactly this case (see the component's JSDoc). This test therefore
 *    accepts EITHER an explicit `destination=` or an explicit `onClick=` as the
 *    "explicit navigation prop" that satisfies R6.4's intent (reusing the single
 *    Boton_Volver for internal-level navigation), matching the correct,
 *    already-shipped implementation.
 *
 * **Validates: Requirements 6.3, 6.4**
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// `npm test` runs from the project root, so resolve sources relative to it.
function readSource(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

/**
 * The six files whose inline "back" control was removed (R6.3), each with the
 * specific inline label the requirements document recorded for it. Absence of
 * these is a regression guard against re-introducing a per-page back control.
 */
const REFACTORED_FILES: Array<{ rel: string; formerLabel: string }> = [
  { rel: "src/components/synthetics/synthetic-dashboard.tsx", formerLabel: "Volver al inicio" },
  { rel: "src/app/create-repo/page.tsx", formerLabel: "Back to Dashboard" },
  { rel: "src/app/user-onboarding/page.tsx", formerLabel: "Back to Menu" },
  { rel: "src/components/infra-request-v2/infra-page-client.tsx", formerLabel: "Volver al portal" },
  { rel: "src/components/cybersecurity-workspace.tsx", formerLabel: "Volver al portal" },
  { rel: "src/app/tickets/page.tsx", formerLabel: "Volver a mis tickets" },
];

describe("back-button refactor (session-nav-hardening, task 15.3)", () => {
  /* =================================================================== */
  /*  R6.3 — the six files carry NO inline "back" control anymore         */
  /* =================================================================== */

  for (const { rel, formerLabel } of REFACTORED_FILES) {
    test(`${rel} has no inline back control (R6.3)`, () => {
      const source = readSource(rel);

      // The specific inline label this file used to render must be gone.
      assert.ok(
        !source.includes(formerLabel),
        `former inline back label "${formerLabel}" must be removed from ${rel}`,
      );

      // No back-arrow lucide icons remain (these were the inline back controls'
      // icons: ArrowLeft / ChevronLeft; cybersecurity used a Home icon as back).
      assert.doesNotMatch(
        source,
        /\bArrowLeft\b/,
        `${rel} must not render an ArrowLeft back icon inline`,
      );
      assert.doesNotMatch(
        source,
        /\bChevronLeft\b/,
        `${rel} must not render a ChevronLeft back icon inline`,
      );

      // Generic hardcoded "back" labels must not linger inline.
      assert.doesNotMatch(
        source,
        /Volver a|Volver al|Back to/,
        `${rel} must not contain a hardcoded "volver/back" label inline`,
      );

      // The single Boton_Volver is anchored ONCE in portal-shell (design D4);
      // these pages must NOT re-introduce it locally (zero duplicates, R6.3).
      assert.doesNotMatch(
        source,
        /BotonVolver/,
        `${rel} must not re-introduce a BotonVolver (it is anchored in portal-shell)`,
      );
    });
  }

  /* =================================================================== */
  /*  R6.4 — comparison-explorer reuses the single Boton_Volver           */
  /* =================================================================== */

  const EXPLORER_REL = "src/components/finops/comparison-explorer.tsx";

  test(`${EXPLORER_REL} imports the single Boton_Volver component (R6.4)`, () => {
    const source = readSource(EXPLORER_REL);
    assert.match(
      source,
      /import\s*\{\s*BotonVolver\s*\}\s*from\s*"@\/components\/navigation\/boton-volver"/,
      "comparison-explorer must import the shared BotonVolver component",
    );
  });

  test(`${EXPLORER_REL} renders <BotonVolver> with an explicit navigation prop (R6.4)`, () => {
    const source = readSource(EXPLORER_REL);

    // It must actually render the component.
    assert.match(
      source,
      /<BotonVolver\b/,
      "comparison-explorer must render <BotonVolver> (reuse the single control)",
    );

    // Extract the <BotonVolver ... /> opening tag and assert it carries an
    // explicit navigation prop. R6.4 asks for internal-level navigation reuse;
    // the shipped implementation uses `onClick={onBack}` (drill-down by local
    // state); an explicit `destination=` would also satisfy the intent.
    const tagMatch = source.match(/<BotonVolver\b[^>]*\/?>/);
    assert.ok(tagMatch, "could not locate the <BotonVolver> tag in comparison-explorer");
    const tag = tagMatch![0];

    const hasOnClick = /\bonClick=\{/.test(tag);
    const hasDestination = /\bdestination=/.test(tag);
    assert.ok(
      hasOnClick || hasDestination,
      `<BotonVolver> in comparison-explorer must carry an explicit navigation prop ` +
        `(onClick for internal-level drill-down, or destination). Found tag: ${tag}`,
    );
  });

  test(`${EXPLORER_REL} keeps no inline back-arrow icon control of its own (R6.4)`, () => {
    const source = readSource(EXPLORER_REL);
    // The breadcrumb back control is the reused BotonVolver, not an inline
    // ArrowLeft/ChevronLeft button.
    assert.doesNotMatch(
      source,
      /\bArrowLeft\b/,
      "comparison-explorer must not render an inline ArrowLeft back control",
    );
    assert.doesNotMatch(
      source,
      /\bChevronLeft\b/,
      "comparison-explorer must not render a ChevronLeft as the back control",
    );
  });
});
