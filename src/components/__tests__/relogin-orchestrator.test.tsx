/**
 * Example tests for the ReloginOrchestrator single-flight re-login flow.
 *
 * Feature: session-nav-hardening, Task 6.2
 *
 * Component under test: src/components/session/relogin-orchestrator.tsx
 *   `ReloginOrchestrator` mounts the shared single-flight context and exposes
 *   `useReloginOrchestrator().triggerRelogin(source)`. On the first trigger of a
 *   5000 ms window it: (1) shows an immediate "session expired, redirecting"
 *   toast (R4.6, <= 500 ms) and (2) schedules `signIn(undefined, { callbackUrl })`
 *   after `RELOGIN_REDIRECT_DELAY_MS` (R4.6, <= 3000 ms). The captured
 *   `callbackUrl` is the internal Ruta_Previa for an internal page (R4.4/R4.6),
 *   "/" for the public home (R4.5), and duplicate triggers inside the window
 *   collapse into a single `signIn` (R4.7).
 *
 * Approach & infra notes
 * ----------------------
 * The portal's runner is `tsx --test` (node:test) on pure logic — no jsdom/RTL by
 * default. We bootstrap the shared minimal jsdom environment via
 * `../../lib/__tests__/helpers/jsdom-setup` (imported FIRST, before
 * `@testing-library/react`) and run under `tsconfig.test.json` (`jsx: react-jsx`)
 * selected with `TSX_TSCONFIG_PATH`, exactly like `toast-duration.test.tsx`.
 *
 * Module boundaries (no `mock.module` on this repo's Node 20 runtime):
 *   - `signIn` (next-auth/react) is a CommonJS writable named export
 *     (`exports.signIn = signIn`). We reassign it on the raw `require` module
 *     object to a `mock.fn` spy; the component reads it live at call-time, so the
 *     spy captures the `callbackUrl` without touching the network.
 *   - `usePathname` / `useSearchParams` (next/navigation) are getter-only exports
 *     that cannot be reassigned. Instead we feed the real hooks by wrapping the
 *     tree in Next's `PathnameContext` / `SearchParamsContext` providers, so the
 *     orchestrator captures the exact Ruta_Previa we set.
 *   - `useToast` uses the real `ToastProvider` (we assert the message renders).
 *   - `useI18n` has no provider, so `t(key, fallback)` returns the Spanish
 *     fallback copy the component supplies.
 *
 * Timers: the redirect is scheduled with the global `setTimeout`, driven
 * deterministically with node:test `mock.timers` (only the `setTimeout` api,
 * enabled AFTER `render` so React's mount is untouched, exactly like
 * `toast-duration.test.tsx`). `Date.now()` stays real so the 5000 ms dedupe
 * window correctly covers two synchronous clicks.
 *
 * **Validates: Requirements 4.5, 4.6, 4.7**
 */

import "../../lib/__tests__/helpers/jsdom-setup";

import { createRequire } from "node:module";
import test, { afterEach, describe, mock } from "node:test";
import assert from "node:assert/strict";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { ToastProvider } from "@/components/ui/toast";
import {
  ReloginOrchestrator,
  useReloginOrchestrator,
  RELOGIN_REDIRECT_DELAY_MS,
  type ReloginSource,
} from "@/components/session/relogin-orchestrator";

// Reassign the writable CommonJS `signIn` export to a spy on the raw module
// object shared with the component (see infra notes).
const nodeRequire = createRequire(import.meta.url);
const nextAuthReact = nodeRequire("next-auth/react") as { signIn: unknown };
const signInSpy = mock.fn(async () => undefined);
nextAuthReact.signIn = signInSpy;

// The immediate toast copy comes from the component's i18n fallback (no provider).
const REDIRECT_MESSAGE = "Sesión caducada, redirigiendo…";

/** Child that exposes the orchestrator trigger via a clickable button. */
function Trigger({ source = "http-401" as ReloginSource }: { source?: ReloginSource }) {
  const { triggerRelogin } = useReloginOrchestrator();
  return <button onClick={() => triggerRelogin(source)}>trigger</button>;
}

/** Mounts the orchestrator with a controlled pathname + search string. */
function renderOrchestrator(pathname: string, search = "") {
  const searchParams = new URLSearchParams(search);
  return render(
    <ToastProvider>
      <PathnameContext.Provider value={pathname}>
        <SearchParamsContext.Provider value={searchParams}>
          <ReloginOrchestrator>
            <Trigger />
          </ReloginOrchestrator>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </ToastProvider>
  );
}

/** Latest `callbackUrl` passed to `signIn(undefined, { callbackUrl })`. */
function lastCallbackUrl(): string | undefined {
  const calls = signInSpy.mock.calls;
  if (calls.length === 0) return undefined;
  const args = calls[calls.length - 1].arguments as [unknown, { callbackUrl?: string }?];
  return args[1]?.callbackUrl;
}

afterEach(() => {
  cleanup();
  mock.timers.reset();
  signInSpy.mock.resetCalls();
});

describe("ReloginOrchestrator", () => {
  // R4.6: the redirect delay must leave the redirect within 3000 ms of the message.
  test("RELOGIN_REDIRECT_DELAY_MS respeta el tope de 3000 ms (R4.6)", () => {
    assert.ok(
      RELOGIN_REDIRECT_DELAY_MS <= 3000,
      `el retraso de redirección (${RELOGIN_REDIRECT_DELAY_MS} ms) debe ser <= 3000 ms`
    );
  });

  // R4.4 / R4.6: internal page → message immediately, signIn scheduled with the
  // captured internal Ruta_Previa (pathname + search) as callbackUrl.
  test("ruta interna: muestra el mensaje de inmediato y redirige con callbackUrl = Ruta_Previa", () => {
    renderOrchestrator("/finops", "tab=costs");

    mock.timers.enable({ apis: ["setTimeout"] });

    fireEvent.click(screen.getByText("trigger"));

    // R4.6: el mensaje es visible de inmediato (<= 500 ms), antes de la redirección.
    assert.ok(
      screen.queryByText(REDIRECT_MESSAGE),
      "el mensaje de re-login aparece de inmediato"
    );
    // La redirección aún no ha ocurrido (está programada, no ejecutada).
    assert.equal(signInSpy.mock.calls.length, 0, "signIn no se llama antes del retraso");

    act(() => {
      mock.timers.tick(RELOGIN_REDIRECT_DELAY_MS);
    });

    assert.equal(signInSpy.mock.calls.length, 1, "signIn se llama una vez tras el retraso");
    assert.equal(
      lastCallbackUrl(),
      "/finops?tab=costs",
      "callbackUrl = pathname + search de la Ruta_Previa interna"
    );
  });

  // R4.6: internal page without query string keeps just the pathname.
  test("ruta interna sin query: callbackUrl es solo el pathname", () => {
    renderOrchestrator("/tickets");

    mock.timers.enable({ apis: ["setTimeout"] });
    fireEvent.click(screen.getByText("trigger"));

    act(() => {
      mock.timers.tick(RELOGIN_REDIRECT_DELAY_MS);
    });

    assert.equal(signInSpy.mock.calls.length, 1);
    assert.equal(lastCallbackUrl(), "/tickets");
  });

  // R4.5: on the public home "/" the callbackUrl must be "/", never the home
  // with leftover query, and never an external destination.
  test("ruta pública '/': callbackUrl es '/' (R4.5)", () => {
    renderOrchestrator("/", "foo=bar");

    mock.timers.enable({ apis: ["setTimeout"] });
    fireEvent.click(screen.getByText("trigger"));

    act(() => {
      mock.timers.tick(RELOGIN_REDIRECT_DELAY_MS);
    });

    assert.equal(signInSpy.mock.calls.length, 1);
    assert.equal(lastCallbackUrl(), "/", "en la home el callbackUrl es '/'");
  });

  // R4.7: duplicate triggers inside the 5000 ms window collapse into a single
  // redirect, regardless of source.
  test("disparos duplicados dentro de 5000 ms producen un único signIn (R4.7)", () => {
    renderOrchestrator("/finops", "tab=costs");

    mock.timers.enable({ apis: ["setTimeout"] });

    const button = screen.getByText("trigger");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    act(() => {
      mock.timers.tick(RELOGIN_REDIRECT_DELAY_MS);
    });

    assert.equal(
      signInSpy.mock.calls.length,
      1,
      "múltiples disparos en la ventana de dedupe → una sola redirección"
    );
    assert.equal(lastCallbackUrl(), "/finops?tab=costs");
  });
});
