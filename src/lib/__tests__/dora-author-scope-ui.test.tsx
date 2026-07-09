/**
 * Example/render + accessibility tests for the DORA author-scoping UI components.
 *
 * Feature: dora-author-scoping, Task 6.3
 *
 * Components under test (src/components/metrics/shared/):
 *   - ScopeBanner               (5.1, 5.2, 5.3, 5.4, 5.5)
 *   - DeploymentLevelBadge      (2.3, 2.4, 9.4)
 *   - DoraEmptyState            (6.5)
 *   - AttributionCoverageNotice (7.5, 7.6)
 *
 * Approach & infra notes
 * ----------------------
 * The portal's test runner is `tsx --test` (node:test) on pure logic — there is no
 * jsdom/React Testing Library set up. These are the first React component tests, so this
 * file bootstraps a minimal jsdom environment via `./helpers/jsdom-setup` (imported FIRST,
 * before `@testing-library/react`) and runs under a test-only tsconfig
 * (`tsconfig.test.json`, `jsx: react-jsx`) selected with `TSX_TSCONFIG_PATH` in the npm
 * `test` script. Testing Library (not a static `renderToStaticMarkup`) is required because
 * the tooltip in `DeploymentLevelBadge` (Req 2.4) only renders on hover/focus DOM events.
 *
 * The components call `useI18n()`, whose default context (no provider) returns the supplied
 * fallback string — which is the Spanish copy the spec mandates ("Sin filtro de autor",
 * "Todos los equipos y proyectos", "Nivel despliegue/pipeline", ...). We therefore render
 * the bare components and assert on testids + roles, and on the specific texts the spec
 * calls out.
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 2.3, 2.4, 6.5, 7.5, 7.6, 9.4**
 */

import "./helpers/jsdom-setup";

import test, { afterEach, describe } from "node:test";
import assert from "node:assert/strict";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import {
  ScopeBanner,
  DeploymentLevelBadge,
  DoraEmptyState,
  AttributionCoverageNotice,
} from "@/components/metrics/shared";

afterEach(() => {
  cleanup();
});

function authors(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    key: `author-${i}`,
    name: `Autor ${i}`,
  }));
}

describe("ScopeBanner", () => {
  // Req 5.1 — siempre muestra las 3 dimensiones (equipo, proyecto, autores)
  test("muestra siempre las tres dimensiones de alcance", () => {
    render(
      <ScopeBanner
        teams={["oms"]}
        projects={[{ id: 1, name: "core-api" }]}
        authors={[{ key: "a-0", name: "Ada Lovelace" }]}
      />
    );

    const banner = screen.getByTestId("dora-scope-banner");
    assert.ok(banner, "el banner debe estar presente");
    assert.ok(within(banner).getByTestId("dora-scope-team"), "dimensión equipo");
    assert.ok(within(banner).getByTestId("dora-scope-project"), "dimensión proyecto");
    assert.ok(within(banner).getByTestId("dora-scope-authors"), "dimensión autores");

    assert.match(within(banner).getByTestId("dora-scope-team").textContent ?? "", /oms/);
    assert.match(within(banner).getByTestId("dora-scope-project").textContent ?? "", /core-api/);
    assert.match(within(banner).getByTestId("dora-scope-authors").textContent ?? "", /Ada Lovelace/);
  });

  // Req 5.2 — trunca a 5 nombres + "+N más"
  test("trunca a 5 autores y muestra el indicador +N más", () => {
    render(<ScopeBanner teams={[]} projects={[]} authors={authors(8)} />);

    const more = screen.getByTestId("dora-scope-authors-more");
    assert.equal(more.textContent?.trim(), "+3 más", "8 autores con máximo 5 ⇒ +3 más");

    const authorsCell = screen.getByTestId("dora-scope-authors").textContent ?? "";
    // Los 5 primeros nombres visibles, el 6º no.
    assert.match(authorsCell, /Autor 0/);
    assert.match(authorsCell, /Autor 4/);
    assert.doesNotMatch(authorsCell, /Autor 5/);
  });

  test("respeta un maxAuthorsShown personalizado", () => {
    render(<ScopeBanner teams={[]} projects={[]} authors={authors(4)} maxAuthorsShown={2} />);
    assert.equal(screen.getByTestId("dora-scope-authors-more").textContent?.trim(), "+2 más");
  });

  // Req 5.3 — sin filtro de autor lo indica explícitamente
  test("indica 'Sin filtro de autor' cuando authors está vacío", () => {
    render(<ScopeBanner teams={["oms"]} projects={[]} authors={[]} />);

    const authorsCell = screen.getByTestId("dora-scope-authors").textContent ?? "";
    assert.match(authorsCell, /Sin filtro de autor/);
    // No debe aparecer el indicador "+N más" sin autores.
    assert.equal(screen.queryByTestId("dora-scope-authors-more"), null);
  });

  // Req 5.5 — sin equipo ni proyecto ni autores ⇒ "Todos los equipos y proyectos"
  test("indica 'Todos los equipos y proyectos' cuando no hay ningún filtro", () => {
    render(<ScopeBanner teams={[]} projects={[]} authors={[]} />);

    const banner = screen.getByTestId("dora-scope-banner");
    assert.match(banner.textContent ?? "", /Todos los equipos y proyectos/);
  });

  // Req 5.4 — reactividad: al cambiar el filtro el banner refleja el nuevo alcance
  test("se re-renderiza al cambiar el filtro de autor (estado React, sin recarga)", () => {
    const { rerender } = render(
      <ScopeBanner teams={["oms"]} projects={[]} authors={[]} />
    );

    assert.match(
      screen.getByTestId("dora-scope-authors").textContent ?? "",
      /Sin filtro de autor/
    );

    rerender(
      <ScopeBanner
        teams={["oms"]}
        projects={[]}
        authors={[{ key: "a-0", name: "Grace Hopper" }]}
      />
    );

    const updated = screen.getByTestId("dora-scope-authors").textContent ?? "";
    assert.match(updated, /Grace Hopper/);
    assert.doesNotMatch(updated, /Sin filtro de autor/);
  });
});

describe("DeploymentLevelBadge", () => {
  // Req 2.3 + 9.4 — presente con filtro de autor, ausente sin filtro
  test("se renderiza para CFR y Recovery cuando visible=true", () => {
    const { rerender } = render(<DeploymentLevelBadge metric="cfr" visible={true} />);
    assert.ok(
      screen.getByTestId("dora-deployment-level-cfr"),
      "badge CFR presente bajo filtro"
    );
    assert.match(
      screen.getByTestId("dora-deployment-level-cfr").textContent ?? "",
      /Nivel despliegue\/pipeline/
    );

    rerender(<DeploymentLevelBadge metric="recovery" visible={true} />);
    assert.ok(
      screen.getByTestId("dora-deployment-level-recovery"),
      "badge Recovery presente bajo filtro"
    );
  });

  // Req 9.4 — sin filtro de autor no muestra etiquetas ni tooltips (regresión cero)
  test("no renderiza nada cuando visible=false (filtro de autor vacío)", () => {
    const { container } = render(<DeploymentLevelBadge metric="cfr" visible={false} />);
    assert.equal(container.firstChild, null, "no debe renderizar nada");
    assert.equal(screen.queryByTestId("dora-deployment-level-cfr"), null);
    assert.equal(screen.queryByRole("tooltip"), null);
  });

  // Req 2.4 — tooltip accesible en hover y en foco, con role="tooltip"/aria-describedby persistente
  test("muestra un tooltip accesible en hover y lo mantiene visible", () => {
    render(<DeploymentLevelBadge metric="cfr" visible={true} />);

    // El trigger expone aria-describedby de forma permanente.
    const trigger = screen.getByRole("button");
    const describedBy = trigger.getAttribute("aria-describedby");
    assert.ok(describedBy, "el trigger debe declarar aria-describedby");

    // Antes del hover no hay tooltip en el DOM.
    assert.equal(screen.queryByRole("tooltip"), null);

    fireEvent.mouseEnter(trigger);
    const tooltip = screen.getByRole("tooltip");
    assert.equal(
      tooltip.getAttribute("id"),
      describedBy,
      "el id del tooltip debe coincidir con aria-describedby del trigger"
    );
    assert.match(
      tooltip.textContent ?? "",
      /no responsabiliza a una persona/,
      "el tooltip explica que la métrica no responsabiliza a una persona"
    );

    // Persistente mientras dura el hover: sigue presente en una segunda consulta.
    assert.ok(screen.getByRole("tooltip"), "el tooltip permanece visible durante el hover");

    fireEvent.mouseLeave(trigger);
    assert.equal(screen.queryByRole("tooltip"), null, "se oculta al salir el puntero");
  });

  test("muestra el tooltip también con el foco de teclado y lo oculta al perder el foco", () => {
    render(<DeploymentLevelBadge metric="recovery" visible={true} />);
    const trigger = screen.getByRole("button");

    assert.equal(screen.queryByRole("tooltip"), null);
    fireEvent.focus(trigger);
    assert.ok(screen.getByRole("tooltip"), "el tooltip aparece al recibir foco de teclado");

    fireEvent.blur(trigger);
    assert.equal(screen.queryByRole("tooltip"), null, "se oculta al perder el foco");
  });
});

describe("DoraEmptyState", () => {
  // Req 6.5 — estado vacío honesto, distinto de error y de carga
  test("identifica autores, indica 0 despliegues/cambios y es un status (no error)", () => {
    render(
      <DoraEmptyState
        authors={[
          { key: "a-0", name: "Ada Lovelace" },
          { key: "a-1", name: "Grace Hopper" },
        ]}
      />
    );

    const empty = screen.getByTestId("dora-empty-state");
    // role="status" ⇒ distinto de un estado de error (role="alert") y de carga (skeleton).
    assert.equal(empty.getAttribute("role"), "status");
    assert.equal(screen.queryByRole("alert"), null, "no debe ser un estado de error");

    const names = screen.getByTestId("dora-empty-state-authors").textContent ?? "";
    assert.match(names, /Ada Lovelace/);
    assert.match(names, /Grace Hopper/);

    // 0 despliegues y 0 cambios atribuibles (valores por defecto del estado vacío).
    assert.match(empty.textContent ?? "", /0 despliegues atribuibles/);
    assert.match(empty.textContent ?? "", /0 cambios atribuibles/);
  });
});

describe("AttributionCoverageNotice", () => {
  // Req 7.5 — aviso visible cuando coverage < threshold + Req 7.6 nota deployment_changes
  test("muestra el aviso best-effort cuando la cobertura está por debajo del umbral", () => {
    render(<AttributionCoverageNotice coverage={42.5} threshold={80} />);

    const warning = screen.getByTestId("dora-coverage-warning");
    assert.equal(warning.getAttribute("role"), "alert", "el aviso es un alert accesible");
    assert.match(warning.textContent ?? "", /best-effort/);
    assert.match(warning.textContent ?? "", /42\.5%/, "incluye el porcentaje de cobertura");

    // Req 7.6 — nota permanente sobre el origen de la atribución.
    const note = screen.getByTestId("dora-coverage-note");
    assert.match(note.textContent ?? "", /deployment_changes/);
  });

  test("no muestra el aviso cuando la cobertura alcanza el umbral, pero sí la nota", () => {
    render(<AttributionCoverageNotice coverage={92.3} threshold={80} />);
    assert.equal(screen.queryByTestId("dora-coverage-warning"), null);
    assert.match(
      screen.getByTestId("dora-coverage-note").textContent ?? "",
      /deployment_changes/
    );
  });

  // Req 7.x — coverage null ⇒ "no disponible" (distinto de 0, sin evaluar umbral)
  test("trata coverage null como 'no disponible' (distinto de 0) y no muestra aviso", () => {
    render(<AttributionCoverageNotice coverage={null} threshold={80} />);

    assert.equal(screen.queryByTestId("dora-coverage-warning"), null, "null no dispara el aviso de umbral");
    assert.ok(
      screen.getByTestId("dora-coverage-unavailable"),
      "indica explícitamente que la cobertura no está disponible"
    );
    assert.match(
      screen.getByTestId("dora-coverage-unavailable").textContent ?? "",
      /no disponible/
    );
  });
});
