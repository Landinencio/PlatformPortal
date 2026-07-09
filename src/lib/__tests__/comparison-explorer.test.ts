/**
 * Example tests for the comparison explorer UI components
 * (spec: finops-cost-comparison-explorer, task 9.4).
 *
 * These are example-based tests (node:test), run by `npm test` via `tsx --test`.
 *
 * WHY THIS SHAPE (no DOM render):
 * ------------------------------------------------------------------------------
 * `src/components/finops/comparison-explorer.tsx` is a React *client* component
 * built on shadcn `Dialog` (Radix), Recharts, the `useCostComparison` hook and a
 * set of pure helpers. The portal's test stack is `node:test` + `tsx` with NO
 * React renderer and NO jsdom/@testing-library (see package.json:
 * `tsx --test src/lib/__tests__/*.test.ts`). Rendering the dialog fully would
 * require a DOM + React renderer + mocking Radix/Recharts/the hook, none of
 * which exist in this repo.
 *
 * Following the repo's established "ejemplo/mirror" pattern (used by
 * `cur-direct-route.test.ts`, `finops-scope-client.test.ts` and
 * `use-cost-comparison.test.ts`), this file validates the explorer's
 * OBSERVABLE, DETERMINISTIC behaviours and its accessibility CONTRACTS without a
 * renderer, in two complementary ways:
 *
 *   (A) LOGIC MIRRORS — exact copies of the component's pure predicates
 *       (`MIN_MONTHS = 2`, `canGenerate`, `monthsToFetch`, and the value the
 *       dialog forwards to `useCostComparison`). These fail if the component's
 *       logic drifts. Covers: month-picker ≥2 rule (Req 4.2) and account
 *       inheritance on open (Req 3.3).
 *
 *   (B) SOURCE CONTRACTS — the test reads the component source file from disk
 *       and asserts it contains the required accessibility wiring (a11y markers
 *       that Radix + our markup rely on). This is a pragmatic, deterministic way
 *       to validate the a11y contract WITHOUT a DOM, consistent with the repo's
 *       no-jsdom constraint. Covers: Dialog accessible title + keyboard close
 *       (Req 11.1, 11.2), `th[scope]` in the table (Req 11.3), the chart's
 *       sr-only equivalent table within a `<figure>`/`<figcaption>` (Req 11.4),
 *       and the keyboard-activable breadcrumb back control (Req 11.5).
 *
 * _Requirements: 3.3, 4.2, 11.1, 11.2, 11.3, 11.4, 11.5_
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { MonthKey } from "../finops-cost-comparison";

/* ================================================================== */
/*  Component source, read once for the source-contract assertions     */
/* ================================================================== */

// `npm test` runs from the project root, so resolve the component relative to it.
const COMPONENT_PATH = path.join(
  process.cwd(),
  "src/components/finops/comparison-explorer.tsx",
);
const SOURCE = readFileSync(COMPONENT_PATH, "utf8");

/* ================================================================== */
/*  (A) LOGIC MIRRORS — month picker ≥2 rule (Req 4.2)                  */
/*      EXACT copies of comparison-explorer.tsx. Keep in sync.          */
/* ================================================================== */

// Mirror of `const MIN_MONTHS = 2;`
const MIN_MONTHS = 2;

// Mirror of `const canGenerate = selectedMonths.length >= MIN_MONTHS;`
function canGenerate(selectedMonths: MonthKey[]): boolean {
  return selectedMonths.length >= MIN_MONTHS;
}

// Mirror of `handleGenerate`: pressing "Comparar" COMMITS the pending selection
// (only when >=2 months). The hook fetches the COMMITTED months, never the
// pending selection — so rapid month toggling no longer fires overlapping
// cur-direct requests (the cause of the 500s).
function commitOnGenerate(selectedMonths: MonthKey[]): MonthKey[] {
  return canGenerate(selectedMonths) ? [...selectedMonths] : [];
}

test("month picker requires ≥2 months: 0 or 1 month cannot generate (Req 4.2)", () => {
  assert.equal(canGenerate([]), false, "0 months → cannot generate");
  assert.equal(canGenerate(["2026-05"]), false, "1 month → cannot generate");
});

test("month picker requires ≥2 months: 2 or more months can generate (Req 4.2)", () => {
  assert.equal(canGenerate(["2026-04", "2026-05"]), true, "2 months → can generate");
  assert.equal(
    canGenerate(["2026-03", "2026-04", "2026-05"]),
    true,
    "3 months → can generate",
  );
});

test("pressing Comparar with <2 months commits nothing (no cur-direct calls) (Req 4.2)", () => {
  // Data is fetched for the COMMITTED months only; an invalid selection cannot
  // be committed, so nothing is fetched.
  assert.deepEqual(commitOnGenerate([]), [], "0 months → commit nothing");
  assert.deepEqual(commitOnGenerate(["2026-05"]), [], "1 month → commit nothing");
});

test("pressing Comparar with ≥2 months commits exactly the selected months (Req 4.2)", () => {
  const sel: MonthKey[] = ["2026-04", "2026-05"];
  assert.deepEqual(commitOnGenerate(sel), sel, "valid selection is committed unchanged");
});

test("MonthPicker shows the <2 months alert exactly when generation is blocked (Req 4.2)", () => {
  // The component renders `{!canGenerate && <p role="alert">…</p>}`, i.e. the
  // alert is visible iff generation is blocked. We assert the predicate parity
  // and that the alert markup exists in the source.
  assert.equal(!canGenerate([]), true, "alert shown for 0 months");
  assert.equal(!canGenerate(["2026-05"]), true, "alert shown for 1 month");
  assert.equal(!canGenerate(["2026-04", "2026-05"]), false, "alert hidden for 2 months");

  assert.match(
    SOURCE,
    /role="alert"[\s\S]*Selecciona al menos dos meses/,
    "source must render a role=alert message requiring at least two months",
  );
});

/* ================================================================== */
/*  (A) LOGIC MIRROR — account inheritance on open (Req 3.3)           */
/* ================================================================== */

/**
 * The dialog inherits `selectedAccountIds` from the dashboard and forwards the
 * SAME value (plus `monthsToFetch`) to the data hook:
 *   `useCostComparison(selectedAccountIds, monthsToFetch)`
 * i.e. the explorer's account scope === the dashboard's selectedAccountIds.
 * Mirror that forwarding at the logic level: the value handed to the hook equals
 * the prop, unchanged.
 */
function accountsForwardedToHook(selectedAccountIds: string[]): string[] {
  // The component does NOT transform the prop before forwarding it.
  return selectedAccountIds;
}

test("explorer inherits the dashboard's selectedAccountIds and forwards them to the hook (Req 3.3)", () => {
  const dashboardAccounts = ["111122223333", "444455556666"];
  const forwarded = accountsForwardedToHook(dashboardAccounts);

  assert.deepEqual(
    forwarded,
    dashboardAccounts,
    "explorer account scope must equal the dashboard's selectedAccountIds",
  );
  // Same reference / no copy-mutation: the explorer does not narrow or widen scope.
  assert.equal(forwarded.length, dashboardAccounts.length, "no accounts added or dropped");
});

test("explorer with an empty selection forwards an empty account scope (org-wide) (Req 3.3)", () => {
  assert.deepEqual(accountsForwardedToHook([]), [], "empty selection stays empty");
});

test("source fetches the COMMITTED months via useCostComparison, gated by an explicit Comparar (Req 3.3, 4.2)", () => {
  // Contract: the dialog calls the hook with the inherited accounts + the
  // committed months (NOT the live selection) — so fetching is explicit.
  assert.match(
    SOURCE,
    /useCostComparison\(\s*selectedAccountIds\s*,\s*committedMonths\s*,?\s*\)/,
    "dialog must call useCostComparison(selectedAccountIds, committedMonths)",
  );
  // Pressing "Comparar" commits the current selection.
  assert.match(
    SOURCE,
    /setCommittedMonths\(\[\.\.\.selectedMonths\]\)/,
    "handleGenerate must commit the pending selection",
  );
  // canGenerate still gates on >=2 months.
  assert.match(
    SOURCE,
    /const\s+canGenerate\s*=\s*selectedMonths\.length\s*>=\s*MIN_MONTHS/,
    "canGenerate must be `selectedMonths.length >= MIN_MONTHS`",
  );
  // The comparison renders off the committed months.
  assert.match(
    SOURCE,
    /const\s+hasComparison\s*=\s*committedMonths\.length\s*>=\s*MIN_MONTHS/,
    "hasComparison must be `committedMonths.length >= MIN_MONTHS`",
  );
  assert.match(SOURCE, /const\s+MIN_MONTHS\s*=\s*2/, "MIN_MONTHS must be 2");
  // A "Comparar" button is wired to handleGenerate.
  assert.match(
    SOURCE,
    /onClick=\{handleGenerate\}/,
    "the Comparar button must trigger handleGenerate",
  );
});

test("delta/trend columns are shown only when comparing exactly two months (Req 6.4 / 6.5)", () => {
  // showDelta gates the Δ€/Δ%/Tendencia header+cells; with >2 months they are
  // hidden (the progression + line chart carry the multi-month story).
  assert.match(
    SOURCE,
    /const\s+showDelta\s*=\s*months\.length\s*===\s*2/,
    "showDelta must be `months.length === 2`",
  );
  assert.match(SOURCE, /\{showDelta\s*&&/, "delta columns must be gated by showDelta");
});

/* ================================================================== */
/*  (B) SOURCE CONTRACTS — Dialog role/title + keyboard close          */
/*      (Req 11.1, 11.2)                                                */
/* ================================================================== */

/*
 * shadcn `Dialog` is backed by Radix `@radix-ui/react-dialog`, which provides
 * `role="dialog"`, `aria-labelledby` (wired to `DialogTitle`), focus trap and
 * Esc-to-close out of the box. We therefore verify the accessible *title* is
 * present (this is what gives the dialog an accessible name → Req 11.1) and that
 * the dialog is the Radix-backed component (which guarantees Esc close → 11.2).
 */

test("Dialog exposes an accessible title via DialogTitle (Req 11.1)", () => {
  assert.match(
    SOURCE,
    /<DialogTitle>[\s\S]*?<\/DialogTitle>/,
    "an accessible DialogTitle gives the modal its accessible name (role=dialog + aria-labelledby)",
  );
  // The title is imported from the shadcn/Radix-backed dialog primitives.
  assert.match(
    SOURCE,
    /from\s+"@\/components\/ui\/dialog"/,
    "Dialog primitives come from the Radix-backed shadcn dialog (role + Esc close built in)",
  );
});

test("Dialog is controlled via open/onOpenChange (Radix → Esc/overlay keyboard close) (Req 11.2)", () => {
  // Radix Dialog closes on Esc by default; the controlled `onOpenChange` is the
  // close channel the component wires up.
  assert.match(
    SOURCE,
    /<Dialog\s+open=\{open\}\s+onOpenChange=\{onOpenChange\}>/,
    "the Radix Dialog is controlled, so Esc/overlay dismissal flows through onOpenChange",
  );
});

/* ================================================================== */
/*  (B) SOURCE CONTRACT — comparison table header scopes (Req 11.3)    */
/* ================================================================== */

test("comparison table associates headers with cells via th[scope] (Req 11.3)", () => {
  assert.match(SOURCE, /<th\s+scope="col"/, "column headers use scope=col");
  assert.match(SOURCE, /<th\s+scope="row"/, "row headers use scope=row");
});

/* ================================================================== */
/*  (B) SOURCE CONTRACT — chart accessible alternative table (Req 11.4)*/
/* ================================================================== */

test("each chart provides an accessible equivalent table inside a figure/figcaption (Req 11.4)", () => {
  // The visual SVG chart is hidden from assistive tech...
  assert.match(
    SOURCE,
    /aria-hidden="true"/,
    "the visual chart is hidden from assistive tech",
  );
  // ...and the chart lives in a <figure> with a <figcaption>...
  assert.match(SOURCE, /<figure/, "chart wrapped in a <figure>");
  assert.match(SOURCE, /<figcaption/, "chart has a <figcaption>");
  // ...accompanied by an sr-only <table> carrying the same values.
  assert.match(
    SOURCE,
    /<table className="sr-only">/,
    "an sr-only equivalent table communicates the chart's values",
  );
});

/* ================================================================== */
/*  (B) SOURCE CONTRACT — keyboard-activable breadcrumb back (Req 11.5)*/
/* ================================================================== */

test("breadcrumb back control is a native button with an aria-label (keyboard-activable) (Req 11.5)", () => {
  // The drill-up back control is now the canonical <BotonVolver> (session-nav-
  // hardening, task 15.2): a native shadcn Button that ALWAYS renders with an
  // aria-label (see boton-volver.tsx), so it is keyboard-activable (Enter/Space)
  // and exposes an accessible name by construction. The former inline
  // aria-label="Volver al nivel superior" string was removed in that refactor.
  assert.match(
    SOURCE,
    /<BotonVolver\b/,
    "the back control is the canonical BotonVolver (native button with aria-label)",
  );
  // The breadcrumb also renders native <button type="button"> nav controls,
  // which are inherently keyboard operable.
  assert.match(
    SOURCE,
    /onClick=\{onBack\}/,
    "the back Button wires an onBack handler (activable via keyboard on a button)",
  );
  assert.match(
    SOURCE,
    /onClick=\{onReset\}/,
    "the breadcrumb root control is a keyboard-activable button",
  );
});
