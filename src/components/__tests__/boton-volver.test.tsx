/**
 * Component tests for the BotonVolver "back" control.
 *
 * Feature: session-nav-hardening, Task 10.2
 *
 * Component under test: src/components/navigation/boton-volver.tsx
 *   `BotonVolver({ destination?, className? })` renders a single `<Button
 *   variant="ghost">` with exactly one `<ArrowLeft/>` icon and an i18n label.
 *   Its `onClick` delegates to the pure `resolveBackTarget(destination)`:
 *     - explicit internal destination      -> router.push(destination)   (R5.6)
 *     - present-but-invalid destination     -> router.push("/")           (R5.8)
 *     - no destination + internal history   -> router.back()              (R6.5)
 *     - no destination + no history         -> router.push("/")           (R6.6)
 *   The label comes from i18n `common.back` with a total Spanish fallback
 *   (R5.3/R7.2/R7.3) and is exposed as the button's accessible name (R5.4).
 *
 * Approach & infra notes
 * ----------------------
 * The portal's runner is `tsx --test` (node:test) on pure logic — no jsdom/RTL by
 * default. We bootstrap the shared minimal jsdom environment via
 * `../../lib/__tests__/helpers/jsdom-setup` (imported FIRST, before
 * `@testing-library/react`) and run under `tsconfig.test.json` (`jsx: react-jsx`)
 * selected with `TSX_TSCONFIG_PATH`, exactly like `relogin-orchestrator.test.tsx`.
 *
 * Module boundaries:
 *   - `useRouter` (next/navigation) is a getter-only export that cannot be
 *     reassigned. Following the same pattern the orchestrator test uses for
 *     `PathnameContext`, we feed the real `useRouter` hook a fake router by
 *     wrapping the tree in Next's `AppRouterContext` provider, so `push`/`back`
 *     are spies we can assert on without any real navigation.
 *   - `useI18n` reads the real i18n context. For the label text test we mount the
 *     real `I18nProvider` (default locale `es`, which lazily loads `es.json` where
 *     `common.back` = "Volver"); for the navigation tests we mount no provider, so
 *     the label degrades — totally and safely — to the key, proving the control is
 *     never rendered with an empty accessible name.
 *   - `window.history.length` is a prototype getter in jsdom; we shadow it with an
 *     own property to simulate "has internal history" (R6.5) vs "no history"
 *     (R6.6), and clean the shadow up after each test.
 *
 * **Validates: Requirements 5.2, 5.3, 5.4, 6.5, 6.6, 7.2, 7.3**
 */

import { window as jsdomWindow } from "../../lib/__tests__/helpers/jsdom-setup";

import test, { afterEach, describe, mock } from "node:test";
import assert from "node:assert/strict";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { I18nProvider } from "@/lib/i18n";
import { BotonVolver } from "@/components/navigation/boton-volver";

// The I18nProvider reads `localStorage` in a mount effect to restore the locale.
// jsdom-setup does not copy it onto the Node global scope, so bridge it here.
if (typeof (globalThis as Record<string, unknown>).localStorage === "undefined") {
  (globalThis as Record<string, unknown>).localStorage = jsdomWindow.localStorage;
}

/** Fake AppRouterInstance whose navigation methods are spies. */
function makeRouter() {
  return {
    push: mock.fn(async () => undefined),
    replace: mock.fn(async () => undefined),
    back: mock.fn(() => undefined),
    forward: mock.fn(() => undefined),
    refresh: mock.fn(() => undefined),
    prefetch: mock.fn(async () => undefined),
  };
}

type FakeRouter = ReturnType<typeof makeRouter>;

/** Mounts the BotonVolver with an injected fake router (no i18n provider). */
function renderBoton(
  props: { destination?: string; className?: string },
  router: FakeRouter
) {
  return render(
    <AppRouterContext.Provider value={router as never}>
      <BotonVolver {...props} />
    </AppRouterContext.Provider>
  );
}

/** Shadow `window.history.length` (a prototype getter) with a fixed value. */
function setHistoryLength(length: number) {
  Object.defineProperty(window.history, "length", {
    configurable: true,
    get: () => length,
  });
}

afterEach(() => {
  cleanup();
  // Remove any own-property shadow so `history.length` reverts to jsdom's default.
  if (Object.prototype.hasOwnProperty.call(window.history, "length")) {
    // @ts-expect-error deleting the shadow restores the prototype getter.
    delete window.history.length;
  }
});

describe("BotonVolver", () => {
  // R5.2: the control renders exactly one ArrowLeft icon (single, unambiguous).
  test("renderiza exactamente un icono ArrowLeft (R5.2)", () => {
    const router = makeRouter();
    const { container } = renderBoton({}, router);

    const svgs = container.querySelectorAll("svg");
    assert.equal(svgs.length, 1, "debe haber un único icono (ArrowLeft)");
    // lucide marks its icons with the `lucide-arrow-left` class.
    assert.ok(
      svgs[0].classList.contains("lucide-arrow-left"),
      "el icono es ArrowLeft"
    );
  });

  // R5.4: it is a native <button> (keyboard-operable via Enter/Space by the user
  // agent), has a non-empty accessible name, is focusable, and a click activates
  // navigation.
  test("es un button accesible, enfocable y activable por click (R5.4)", () => {
    const router = makeRouter();
    setHistoryLength(3);
    renderBoton({}, router);

    const button = screen.getByRole("button");
    assert.equal(button.tagName, "BUTTON", "es un elemento <button> nativo");
    const accessibleName = button.getAttribute("aria-label") ?? button.textContent ?? "";
    assert.ok(accessibleName.trim().length > 0, "tiene nombre accesible no vacío");

    // Native buttons are keyboard-operable (Enter/Space) by default; verify the
    // control can receive focus, then that activation navigates.
    act(() => {
      button.focus();
    });
    assert.equal(document.activeElement, button, "el botón es enfocable por teclado");

    fireEvent.click(button);
    assert.equal(router.back.mock.calls.length, 1, "el click activa la navegación");
  });

  // R5.3 / R7.2 / R7.3: the visible label + accessible name come from the i18n
  // key `common.back`, which resolves to the Spanish "Volver" under the default
  // locale.
  test("la etiqueta procede de i18n common.back → 'Volver' (R5.3/R7.2/R7.3)", async () => {
    const router = makeRouter();
    await act(async () => {
      render(
        <I18nProvider>
          <AppRouterContext.Provider value={router as never}>
            <BotonVolver />
          </AppRouterContext.Provider>
        </I18nProvider>
      );
    });

    // The provider lazily imports es.json; findByRole retries until the label
    // becomes the resolved translation.
    const button = await screen.findByRole("button", { name: "Volver" });
    assert.equal(button.getAttribute("aria-label"), "Volver");
    assert.ok(button.textContent?.includes("Volver"), "el texto visible es 'Volver'");
  });

  // R7.x totality: with no i18n context the label degrades safely to the key,
  // never an empty accessible name.
  test("sin contexto i18n el nombre accesible sigue siendo no vacío (fallback total)", () => {
    const router = makeRouter();
    renderBoton({}, router);

    const button = screen.getByRole("button");
    const accessibleName = button.getAttribute("aria-label") ?? "";
    assert.ok(accessibleName.trim().length > 0, "el fallback nunca deja el botón sin nombre");
  });

  // R6.5: no destination + internal history present → router.back().
  test("sin destino y con historial interno usa router.back (R6.5)", () => {
    const router = makeRouter();
    setHistoryLength(4);
    renderBoton({}, router);

    fireEvent.click(screen.getByRole("button"));

    assert.equal(router.back.mock.calls.length, 1, "usa el historial (router.back)");
    assert.equal(router.push.mock.calls.length, 0, "no navega a la home");
  });

  // R6.6: no destination + no internal history → router.push("/").
  test("sin destino y sin historial cae a router.push('/') (R6.6)", () => {
    const router = makeRouter();
    setHistoryLength(1);
    renderBoton({}, router);

    fireEvent.click(screen.getByRole("button"));

    assert.equal(router.back.mock.calls.length, 0, "no intenta el historial");
    assert.equal(router.push.mock.calls.length, 1, "cae a la home");
    assert.deepEqual(router.push.mock.calls[0].arguments, ["/"]);
  });

  // R5.6: an explicit valid internal destination → router.push(destination).
  test("con destino interno explícito navega a ese destino (R5.6)", () => {
    const router = makeRouter();
    setHistoryLength(5); // history is irrelevant when an explicit destination is set
    renderBoton({ destination: "/finops" }, router);

    fireEvent.click(screen.getByRole("button"));

    assert.equal(router.push.mock.calls.length, 1);
    assert.deepEqual(router.push.mock.calls[0].arguments, ["/finops"]);
    assert.equal(router.back.mock.calls.length, 0, "un destino explícito no usa el historial");
  });

  // R5.8: a present-but-invalid destination degrades safely to "/" (never external).
  test("con destino inválido degrada a router.push('/') (R5.8)", () => {
    const router = makeRouter();
    for (const bad of ["http://evil.com", "//evil.com", "/\\evil"]) {
      const localRouter = makeRouter();
      const { unmount } = renderBoton({ destination: bad }, localRouter);
      fireEvent.click(screen.getByRole("button"));
      assert.equal(localRouter.push.mock.calls.length, 1, `destino inválido ${bad}`);
      assert.deepEqual(
        localRouter.push.mock.calls[0].arguments,
        ["/"],
        `destino externo/ inválido ${bad} degrada a '/'`
      );
      unmount();
    }
    void router;
  });
});
