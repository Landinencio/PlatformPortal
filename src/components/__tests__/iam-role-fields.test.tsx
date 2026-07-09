/**
 * Component tests for the IAM role creation panel.
 *
 * Feature: iam-role-least-privilege, Task 12.2
 *
 * Component under test: src/components/infra-request-v2/iam-role-fields.tsx
 *   `IamRoleFieldsPanel({ team, onChange })` renders a thin form whose permission
 *   options are populated EXCLUSIVELY from the curated IAM catalog
 *   (`buildFormOptions(IAM_CATALOG)`, grouped family → service), with no
 *   hardcoded permission list. Each scopable preset exposes an ARN editor whose
 *   content is validated client-side with the pure `validateScope`, marking
 *   rejected ARNs while keeping the valid ones. It emits, via `onChange`, an
 *   `IamRoleFields & { targetEnvironments }` object plus an overall validity flag.
 *   Defensive branches covered here:
 *     - an empty catalog blocks submission and surfaces an "unavailable" alert
 *       (Requirement 2.6);
 *     - when the team is `Tooling` the target environment is fixed to `tooling`
 *       and presented as non-editable (Requirement 7.4).
 *
 * Approach & infra notes
 * ----------------------
 * The portal's runner is `tsx --test` (node:test) on pure logic — no jsdom/RTL by
 * default. We bootstrap the shared minimal jsdom environment via
 * `../../lib/__tests__/helpers/jsdom-setup` (imported FIRST, before
 * `@testing-library/react`) and run under `tsconfig.test.json` (`jsx: react-jsx`)
 * selected with `TSX_TSCONFIG_PATH`, exactly like `boton-volver.test.tsx`.
 *
 * Module boundaries:
 *   - `useI18n` reads the real i18n context. With no `I18nProvider` mounted,
 *     `t(key, fallback)` returns `fallback || key`, so preset labels degrade to
 *     their stable id and group headers to their Spanish fallback — enough to
 *     assert structure without asserting translated copy.
 *   - The catalog is a module-level import (`IAM_CATALOG`), not a prop, so it
 *     cannot be emptied via props. The empty-catalog guard (Requirement 2.6) is
 *     therefore verified through the exact decidable driver the component uses,
 *     `buildFormOptions([])`, together with an assertion that the guard's alert
 *     is NOT falsely raised for the real (non-empty) catalog.
 *
 * **Validates: Requirements 2.1, 2.6, 3.3, 7.4**
 */

import "../../lib/__tests__/helpers/jsdom-setup";

import test, { afterEach, describe } from "node:test";
import assert from "node:assert/strict";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { IamRoleFieldsPanel } from "@/components/infra-request-v2/iam-role-fields";
import { IAM_CATALOG, buildFormOptions } from "@/lib/iam-catalog/catalog";
import type { IamRoleFields } from "@/lib/infra-prompt-builder";

type Emitted = IamRoleFields & { targetEnvironments: string[] };

/** Renders the panel with an onChange recorder that keeps the last emitted value. */
function renderPanel(team: string) {
  const calls: Array<{ fields: Emitted; valid: boolean }> = [];
  const onChange = (fields: Emitted, valid: boolean) => {
    calls.push({ fields, valid });
  };
  const utils = render(<IamRoleFieldsPanel team={team} onChange={onChange} />);
  const last = () => (calls.length === 0 ? undefined : calls[calls.length - 1]);
  return { ...utils, calls, last };
}

afterEach(() => {
  cleanup();
});

describe("IamRoleFieldsPanel", () => {
  // R2.1: the options are populated exclusively from the catalog — there is one
  // checkbox per catalog form option, matching buildFormOptions(IAM_CATALOG),
  // and NOT the old 6-item hardcoded list.
  test("opciones pobladas desde el catálogo, sin lista hardcodeada (2.1)", () => {
    const { container } = renderPanel("digital");

    const options = buildFormOptions(IAM_CATALOG);

    // Sanity: the catalog is the large curated set, well beyond the 6 legacy
    // checkboxes (S3/SecretsManager/SQS/SNS/EventBridge/RDS).
    assert.ok(
      options.length > 6,
      `el catálogo debe superar las 6 categorías legacy (tiene ${options.length})`,
    );

    // Exactly one preset checkbox is rendered per catalog option (id-derived).
    const presetCheckboxes = container.querySelectorAll('[id^="iam-preset-"]');
    assert.equal(
      presetCheckboxes.length,
      options.length,
      "un checkbox por opción del catálogo (poblado desde buildFormOptions)",
    );

    // Every catalog option id has its corresponding checkbox in the DOM.
    for (const opt of options) {
      assert.ok(
        container.querySelector(`#iam-preset-${CSS_escape(opt.id)}`),
        `falta el checkbox del preset ${opt.id}`,
      );
    }

    // Spot-check a well-known preset is present (proves real catalog wiring).
    assert.ok(
      container.querySelector("#iam-preset-s3-read-only"),
      "el preset s3-read-only del catálogo se renderiza",
    );
  });

  // R3.3 / R3.5: a malformed ARN is flagged while the valid ARNs are kept; the
  // invalid entry blocks submission (validity flips to false) yet the accepted
  // ARN survives in the emitted selection.
  test("ARN inválido se marca conservando los válidos y bloquea el submit (3.3/3.5)", () => {
    const { container, last } = renderPanel("digital");

    // Fill the mandatory fields so the ONLY blocker under test is the ARN.
    fireEvent.change(container.querySelector("#iam-rolename")!, {
      target: { value: "mi-servicio-role" },
    });
    fireEvent.change(container.querySelector("#iam-namespace")!, {
      target: { value: "mi-namespace" },
    });
    fireEvent.click(container.querySelector("#iam-env-dev")!);

    // Select a scopable S3 preset → its ARN editor appears.
    fireEvent.click(container.querySelector("#iam-preset-s3-read-only")!);

    const editor = container.querySelector<HTMLTextAreaElement>("#iam-arn-s3-read-only");
    assert.ok(editor, "el editor de ARNs aparece al seleccionar un preset scopable");

    // Only a valid ARN first: everything is valid, one accepted ARN.
    fireEvent.change(editor!, { target: { value: "arn:aws:s3:::my-bucket" } });

    let snap = last();
    assert.ok(snap, "el panel emite su estado vía onChange");
    assert.equal(snap!.valid, true, "con un ARN válido el formulario es válido");
    assert.ok(
      container.textContent?.includes("1 ARN(s) válidos."),
      "muestra el contador de ARNs válidos",
    );

    // Now add a malformed ARN alongside the valid one.
    fireEvent.change(editor!, {
      target: { value: "arn:aws:s3:::my-bucket\nnot-an-arn" },
    });

    // The malformed ARN is surfaced to the user (rejected feedback), and the
    // valid one is still counted as accepted.
    assert.ok(
      container.textContent?.includes("not-an-arn"),
      "el ARN inválido se muestra marcado",
    );
    assert.ok(
      container.textContent?.includes("1 ARN(s) válidos."),
      "el ARN válido se conserva pese al inválido",
    );

    // Submission is blocked while a rejected ARN is present…
    snap = last();
    assert.equal(snap!.valid, false, "un ARN rechazado bloquea el submit");

    // …but the accepted (valid) ARN is preserved in the emitted selection.
    const s3sel = snap!.fields.presetSelections?.find((s) => s.presetId === "s3-read-only");
    assert.ok(s3sel, "la selección del preset s3-read-only se emite");
    assert.deepEqual(
      s3sel!.resourceArns,
      ["arn:aws:s3:::my-bucket"],
      "solo el ARN válido llega a la selección; el inválido se descarta",
    );
  });

  // R2.6: an empty catalog blocks submission. The catalog is a module import
  // (not injectable via props), so we verify the exact decidable driver the
  // component uses — buildFormOptions([]) is empty (⇒ catalogEmpty ⇒ alert +
  // blocked submit) — and that the guard is NOT falsely raised for the real
  // non-empty catalog.
  test("catálogo vacío bloquea el submit — guarda defensiva (2.6)", () => {
    // The driver of the defensive guard: an empty catalog yields zero options,
    // which is exactly what flips `catalogEmpty` to true in the component.
    assert.equal(
      buildFormOptions([]).length,
      0,
      "un catálogo vacío produce cero opciones (dispara catalogEmpty)",
    );

    // Negative branch: with the real (non-empty) catalog the unavailable-alert
    // guard must NOT trigger, and the form is usable.
    const { container, last } = renderPanel("digital");
    assert.ok(
      buildFormOptions(IAM_CATALOG).length > 0,
      "el catálogo real no está vacío",
    );
    const alert = container.querySelector('[role="alert"]');
    assert.equal(
      alert,
      null,
      "con catálogo real no se muestra el aviso de opciones no disponibles",
    );
    // The panel emitted something and is not hard-blocked by the empty guard.
    assert.ok(last(), "el panel emite estado con el catálogo real");
  });

  // R7.4: for the Tooling team the target environment is fixed to `tooling` and
  // presented as non-editable (no dev/uat/prod checkboxes); other teams keep the
  // editable environment selector.
  test("entorno Tooling fijo y no editable (7.4)", () => {
    const tooling = renderPanel("Tooling");

    // No editable environment checkboxes are rendered for Tooling.
    assert.equal(
      tooling.container.querySelector("#iam-env-dev"),
      null,
      "Tooling no muestra el checkbox de dev (no editable)",
    );
    assert.equal(tooling.container.querySelector("#iam-env-uat"), null);
    assert.equal(tooling.container.querySelector("#iam-env-prod"), null);
    assert.ok(
      tooling.container.textContent?.includes("tooling"),
      "se indica que el entorno es tooling (auto-seleccionado)",
    );

    // The emitted target environment is fixed to exactly ["tooling"].
    const snap = tooling.last();
    assert.ok(snap, "el panel Tooling emite estado");
    assert.deepEqual(
      snap!.fields.targetEnvironments,
      ["tooling"],
      "el entorno destino queda fijado a tooling",
    );

    cleanup();

    // Contrast: a non-Tooling team keeps the editable dev/uat/prod selector.
    const digital = renderPanel("digital");
    assert.ok(
      digital.container.querySelector("#iam-env-dev"),
      "un equipo no-Tooling sí puede editar el entorno (dev visible)",
    );
    assert.ok(digital.container.querySelector("#iam-env-uat"));
    assert.ok(digital.container.querySelector("#iam-env-prod"));
  });
});

/**
 * Minimal CSS.escape shim: preset ids are `[a-z0-9-]+`, safe for id selectors,
 * so we can pass them through unchanged. Kept as a helper to make intent clear.
 */
function CSS_escape(id: string): string {
  return id;
}
