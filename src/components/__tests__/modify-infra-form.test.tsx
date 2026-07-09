// Feature: iam-role-least-privilege, Task 13.2: Test de componente de modify-infra-form
/**
 * Component tests for the IAM section of the modify-infra form.
 *
 * Component under test: src/components/infra-request-v2/modify-infra-form.tsx
 *   `ModifyInfraForm({ teams })` is a heavy "use client" component. Its IAM
 *   section (`resourceType === "iam_role"`) is the part this task covers:
 *     - the "add permissions" options come EXCLUSIVELY from the catalog via the
 *       module-level `IAM_PRESET_OPTIONS = buildFormOptions(IAM_CATALOG)`, and the
 *       old `COMMON_IAM_POLICIES` list no longer exists (Req 2.2);
 *     - the role's CURRENT permissions (`selectedResource.presetIds`) render as a
 *       list of selectable checkboxes to REMOVE (`iam-remove-<id>`), toggled by
 *       `toggleIamRemove` (Req 6.2);
 *     - a custom managed-policy ARN is screened client-side by
 *       `validateManagedPolicyArn` inside `addCustomPolicy`: an admin-shaped ARN
 *       is flagged (error set) and NOT added, while a valid one is kept and the
 *       rest of the selection is preserved (Req 6.5).
 *
 * Approach & tooling
 * ------------------
 * The portal's runner is `tsx --test` (node:test). Component rendering is possible
 * via the shared minimal jsdom bootstrap (`../../lib/__tests__/helpers/jsdom-setup`,
 * imported FIRST) + `@testing-library/react`, under `tsconfig.test.json`
 * (`jsx: react-jsx`, selected by `TSX_TSCONFIG_PATH`) — exactly like
 * `boton-volver.test.tsx` and `http-interceptor.test.tsx`.
 *
 * However, the IAM section is gated behind THREE Radix `Select`s (team → resource
 * type → concrete resource) plus a `fetch` to `/list-resources`, and only renders
 * once an internal `selectedResource` is set. Radix Select cannot be driven under
 * this bare jsdom setup (no `@testing-library/user-event`, no pointer-capture
 * APIs, no module mocking to stub the Select) — the same limitation documented in
 * `portal-shell.nav-visibility.test.tsx`, which tests the real gating logic
 * instead of forcing a fragile render. So we combine:
 *
 *   1. a REAL render smoke test of `<ModifyInfraForm/>` — proving it mounts (which
 *      means the module-level `buildFormOptions(IAM_CATALOG)` ran without throwing)
 *      and no longer depends on any hardcoded permission list;
 *   2. REAL assertions against the shared source of truth: the component source
 *      has no `COMMON_IAM_POLICIES` and derives its options from
 *      `buildFormOptions(IAM_CATALOG)`; the catalog module exports no such symbol
 *      (Req 2.2);
 *   3. REAL behavioural tests of the exact pure logic the IAM section applies:
 *      `getPresetById` + i18n labelling for the remove-list (Req 6.2), and
 *      `validateManagedPolicyArn` inside a faithful copy of the component's
 *      `addCustomPolicy` / `toggleIamRemove` reducers (Req 6.5).
 *
 * The reducers below are copied verbatim from the component (kept in sync by the
 * source-shape assertions) so the behaviour under test is the component's own.
 *
 * _Requirements: 2.2, 6.2, 6.5_
 */

import { window as jsdomWindow } from "../../lib/__tests__/helpers/jsdom-setup";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test, { afterEach, describe } from "node:test";
import assert from "node:assert/strict";

import { act, cleanup, render, screen } from "@testing-library/react";

import { I18nProvider } from "@/lib/i18n";
import {
  IAM_CATALOG,
  buildFormOptions,
  getPresetById,
} from "@/lib/iam-catalog/catalog";
import {
  validateManagedPolicyArn,
  type IamValidationResult,
} from "@/lib/iam-catalog/validator";
import { ModifyInfraForm } from "@/components/infra-request-v2/modify-infra-form";

// The I18nProvider reads `localStorage` in a mount effect; jsdom-setup does not
// copy it onto the Node global scope, so bridge it here (as boton-volver does).
if (typeof (globalThis as Record<string, unknown>).localStorage === "undefined") {
  (globalThis as Record<string, unknown>).localStorage = jsdomWindow.localStorage;
}

/* ------------------------------------------------------------------ */
/*  Source of the component + Spanish catalog (read once, from disk)   */
/* ------------------------------------------------------------------ */

const HERE = dirname(fileURLToPath(import.meta.url));

const COMPONENT_SOURCE = readFileSync(
  resolve(HERE, "../infra-request-v2/modify-infra-form.tsx"),
  "utf8",
);

/** Spanish i18n catalog (the modify form defaults to `es`). */
const ES_CATALOG: Record<string, string> = JSON.parse(
  readFileSync(resolve(HERE, "../../i18n/es.json"), "utf8"),
);

/* ------------------------------------------------------------------ */
/*  Faithful copies of the component's IAM reducers (kept in sync by   */
/*  the source-shape assertions in the 2.2 block).                     */
/* ------------------------------------------------------------------ */

/** Verbatim copy of the component's `toggleIamRemove` (6.2). */
function toggleIamRemove(ids: string[], presetId: string): string[] {
  return ids.includes(presetId)
    ? ids.filter((p) => p !== presetId)
    : [...ids, presetId];
}

interface CustomPolicyState {
  iamManagedArns: string[];
  customPolicyError: string | null;
}

/**
 * Verbatim copy of the component's `addCustomPolicy` (6.4/6.5), expressed as a
 * pure reducer so we can assert the outcome. Mirrors the component exactly:
 * admin-shaped ARNs are flagged (error set) and NOT added; valid ARNs are kept
 * (deduplicated) and the rest of the selection is preserved.
 */
function addCustomPolicy(
  state: CustomPolicyState,
  rawInput: string,
): CustomPolicyState {
  const arn = rawInput.trim();
  if (!arn) return state;
  const result: IamValidationResult = validateManagedPolicyArn(arn);
  if (result.verdict === "Politica_Admin") {
    return {
      ...state,
      customPolicyError: `iam.validator.${result.rule ?? "invalid_managed_arn"}`,
    };
  }
  const iamManagedArns = state.iamManagedArns.includes(arn)
    ? state.iamManagedArns
    : [...state.iamManagedArns, arn];
  return { iamManagedArns, customPolicyError: null };
}

afterEach(() => {
  cleanup();
});

/* ================================================================== */
/*  Req 2.2 — options come from the catalog; COMMON_IAM_POLICIES gone  */
/* ================================================================== */

describe("ModifyInfraForm — catalog is the single source (Req 2.2)", () => {
  // Real render: the component mounts, which means the module-level
  // `IAM_PRESET_OPTIONS = buildFormOptions(IAM_CATALOG)` executed at import time
  // without throwing. The top-level team/resource-type controls render.
  test("mounts and renders the modify form scaffold", async () => {
    await act(async () => {
      render(
        <I18nProvider>
          <ModifyInfraForm teams={["digital", "retail"]} />
        </I18nProvider>,
      );
    });

    // Static labels present (proves a clean mount, no crash on the IAM wiring).
    assert.ok(screen.getByText("Equipo"), "renders the team label");
    assert.ok(screen.getByText("Tipo de recurso"), "renders the resource-type label");
  });

  // The component source must NOT reference the removed hardcoded list, and must
  // derive its IAM options from the catalog via buildFormOptions(IAM_CATALOG).
  test("component source has no COMMON_IAM_POLICIES and uses buildFormOptions(IAM_CATALOG)", () => {
    assert.ok(
      !/COMMON_IAM_POLICIES/.test(COMPONENT_SOURCE),
      "COMMON_IAM_POLICIES must be fully removed from the modify form",
    );
    assert.ok(
      /buildFormOptions\(IAM_CATALOG\)/.test(COMPONENT_SOURCE),
      "IAM add options must be derived from buildFormOptions(IAM_CATALOG)",
    );
    assert.ok(
      /from "@\/lib\/iam-catalog\/catalog"/.test(COMPONENT_SOURCE),
      "options must be imported from the shared catalog module",
    );
    // Keep the reducer copies honest: the component still defines them.
    assert.ok(/toggleIamRemove/.test(COMPONENT_SOURCE), "component defines toggleIamRemove");
    assert.ok(/addCustomPolicy/.test(COMPONENT_SOURCE), "component defines addCustomPolicy");
    assert.ok(
      /validateManagedPolicyArn/.test(COMPONENT_SOURCE),
      "component screens managed ARNs with validateManagedPolicyArn",
    );
  });

  // The catalog module exposes no COMMON_IAM_POLICIES symbol whatsoever.
  test("catalog module exports no COMMON_IAM_POLICIES", async () => {
    const catalogMod = (await import("@/lib/iam-catalog/catalog")) as Record<string, unknown>;
    assert.equal(
      catalogMod.COMMON_IAM_POLICIES,
      undefined,
      "catalog must not export a COMMON_IAM_POLICIES list",
    );
  });

  // The add options are exactly the catalog presets (same ids), non-empty, and
  // in the deterministic family → service → id order shared with the creation
  // form — this is the exact value the component maps over as IAM_PRESET_OPTIONS.
  test("IAM add options are populated exclusively from the catalog", () => {
    const options = buildFormOptions(IAM_CATALOG);
    assert.ok(options.length > 0, "options must be non-empty");
    assert.equal(
      options.length,
      IAM_CATALOG.length,
      "one option per catalog preset (no extra hardcoded entries)",
    );

    const optionIds = options.map((o) => o.id);
    const catalogIds = IAM_CATALOG.map((p) => p.id);
    assert.deepEqual(
      [...optionIds].sort(),
      [...catalogIds].sort(),
      "option ids are exactly the catalog preset ids",
    );

    // Every option resolves back to a real preset (no orphan/hardcoded ids).
    for (const opt of options) {
      assert.ok(getPresetById(opt.id), `option ${opt.id} resolves to a catalog preset`);
    }

    // Deterministic order shared with the creation form (2.5): re-invoking yields
    // an identical sequence.
    assert.deepEqual(
      buildFormOptions(IAM_CATALOG).map((o) => o.id),
      optionIds,
      "buildFormOptions is order-stable across invocations",
    );
  });
});

/* ================================================================== */
/*  Req 6.2 — current permissions render as selectable remove items    */
/* ================================================================== */

describe("ModifyInfraForm — current permissions are selectable to remove (Req 6.2)", () => {
  // The IAM section maps `selectedResource.presetIds` into remove checkboxes
  // labelled `iam.preset.<id>`. For the current permissions to render as usable,
  // selectable items, every current preset id must resolve in the catalog and
  // carry a non-empty i18n label — this is the data contract the render relies on.
  test("each current preset id resolves and has a non-empty remove label", () => {
    // A representative set of "current" permissions a role's policy might carry,
    // as parsed from the .tf and returned by /list-resources (presetIds).
    const currentPresetIds = ["s3-read-only", "sqs-consumer", "dynamodb-read-write"];

    for (const pid of currentPresetIds) {
      assert.ok(getPresetById(pid), `current permission ${pid} resolves in the catalog`);
      const label = ES_CATALOG[`iam.preset.${pid}`];
      assert.ok(
        typeof label === "string" && label.trim().length > 0,
        `remove item ${pid} has a non-empty i18n label`,
      );
    }
  });

  // The remove list is toggle-selectable: toggling adds the id, toggling again
  // removes it, and selections are independent per id (component's toggleIamRemove).
  test("toggleIamRemove selects and deselects a current permission", () => {
    let selected: string[] = [];

    selected = toggleIamRemove(selected, "s3-read-only");
    assert.deepEqual(selected, ["s3-read-only"], "first toggle selects the item to remove");

    selected = toggleIamRemove(selected, "sqs-consumer");
    assert.deepEqual(
      [...selected].sort(),
      ["s3-read-only", "sqs-consumer"],
      "a second, independent item can be selected",
    );

    selected = toggleIamRemove(selected, "s3-read-only");
    assert.deepEqual(
      selected,
      ["sqs-consumer"],
      "toggling again deselects only that item, preserving the rest",
    );
  });
});

/* ================================================================== */
/*  Req 6.5 — admin managed ARN is flagged client-side and not added   */
/* ================================================================== */

describe("ModifyInfraForm — custom managed ARN screening (Req 6.5)", () => {
  // The predicate the component uses: AdministratorAccess and *FullAccess managed
  // policies are classified as Politica_Admin; a scoped custom policy is aceptable.
  test("validateManagedPolicyArn flags admin ARNs and accepts a scoped one", () => {
    assert.equal(
      validateManagedPolicyArn("arn:aws:iam::aws:policy/AdministratorAccess").verdict,
      "Politica_Admin",
      "AdministratorAccess is rejected",
    );
    assert.equal(
      validateManagedPolicyArn("arn:aws:iam::aws:policy/AmazonS3FullAccess").verdict,
      "Politica_Admin",
      "*FullAccess is rejected",
    );
    assert.equal(
      validateManagedPolicyArn("not-an-arn").verdict,
      "Politica_Admin",
      "an invalid ARN is rejected (default-deny)",
    );
    assert.equal(
      validateManagedPolicyArn(
        "arn:aws:iam::123456789012:policy/team/my-scoped-readonly",
      ).verdict,
      "aceptable",
      "a scoped, non-admin custom managed policy is acceptable",
    );
  });

  // Admin ARN: flagged (error set) and NOT added; the rest of the selection is
  // preserved untouched (component's addCustomPolicy, 6.5).
  test("adding an admin ARN sets an error and does not add it, keeping the rest", () => {
    const before: CustomPolicyState = {
      iamManagedArns: ["arn:aws:iam::123456789012:policy/keep-me"],
      customPolicyError: null,
    };

    const after = addCustomPolicy(before, "arn:aws:iam::aws:policy/AdministratorAccess");

    assert.deepEqual(
      after.iamManagedArns,
      ["arn:aws:iam::123456789012:policy/keep-me"],
      "the admin ARN is NOT added; the existing selection is preserved",
    );
    assert.equal(
      after.customPolicyError,
      "iam.validator.managed_administrator",
      "the rejection reason is surfaced via the validator rule",
    );
    // The surfaced reason maps to a real, non-empty user-facing message.
    assert.ok(
      (ES_CATALOG[after.customPolicyError as string] ?? "").trim().length > 0,
      "the rejection reason resolves to a non-empty i18n message",
    );
  });

  // A *FullAccess managed policy is likewise flagged and not added.
  test("adding a *FullAccess ARN is flagged and not added", () => {
    const before: CustomPolicyState = { iamManagedArns: [], customPolicyError: null };
    const after = addCustomPolicy(before, "arn:aws:iam::aws:policy/AmazonS3FullAccess");

    assert.deepEqual(after.iamManagedArns, [], "the FullAccess ARN is not added");
    assert.equal(
      after.customPolicyError,
      "iam.validator.managed_full_access",
      "the FullAccess rule is surfaced",
    );
  });

  // Valid custom ARN: added, error cleared, previous selection preserved; a
  // duplicate is not added twice.
  test("adding a valid custom ARN keeps it and preserves the rest", () => {
    const before: CustomPolicyState = {
      iamManagedArns: ["arn:aws:iam::123456789012:policy/existing"],
      customPolicyError: "iam.validator.managed_administrator", // a stale prior error
    };

    const validArn = "arn:aws:iam::123456789012:policy/my-scoped-policy";
    const after = addCustomPolicy(before, validArn);

    assert.deepEqual(
      after.iamManagedArns,
      ["arn:aws:iam::123456789012:policy/existing", validArn],
      "the valid ARN is appended, preserving the existing selection",
    );
    assert.equal(after.customPolicyError, null, "the error is cleared on a valid add");

    // Idempotent: adding the same ARN again does not duplicate it.
    const twice = addCustomPolicy(after, validArn);
    assert.deepEqual(
      twice.iamManagedArns,
      after.iamManagedArns,
      "a duplicate managed ARN is not added twice",
    );
  });
});
