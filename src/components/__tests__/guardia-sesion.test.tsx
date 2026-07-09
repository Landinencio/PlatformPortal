/**
 * Example tests for the GuardiaSesion non-blocking session-expiry guard.
 *
 * Feature: session-nav-hardening, Task 9.2
 *
 * Component under test: src/components/session/guardia-sesion.tsx
 *   `GuardiaSesion(): JSX.Element | null` is mounted ONCE inside the
 *   `SessionProvider` (next to `ReloginOrchestrator` + `HttpInterceptor`). Every
 *   1000 ms it evaluates the live session against the pure `session-expiry`
 *   helpers and, on a Pagina_Interna:
 *     - shows/updates a non-blocking `Aviso_Expiracion` (role="alert" + countdown
 *       + "Continuar") while within the Umbral_Aviso, hiding it otherwise
 *       (R1.3 / R1.4);
 *     - on `status === "unauthenticated"` fires `triggerRelogin("guard")` (R1.2);
 *     - on "Continuar" revalidates with `Promise.race([update(), timeout(10000)])`
 *       (R1.5): a valid session in time hides the notice, a failure/timeout/invalid
 *       session fires `triggerRelogin("guard-refresh-failed")` and informs (R1.6);
 *   On the Ruta_Publica "/" it fully abstains: never warns, never redirects (R1.7).
 *
 * Approach & infra notes
 * ----------------------
 * The portal's runner is `tsx --test` (node:test) on pure logic — no jsdom/RTL by
 * default. We bootstrap the shared minimal jsdom environment via
 * `../../lib/__tests__/helpers/jsdom-setup` (imported FIRST, before
 * `@testing-library/react`) and run under `tsconfig.test.json` (`jsx: react-jsx`)
 * selected with `TSX_TSCONFIG_PATH`, exactly like `http-interceptor.test.tsx`.
 *
 * Module boundaries (no `mock.module` on this repo's Node 20 runtime):
 *   - `useSession` and `signIn` (next-auth/react) are writable CommonJS named
 *     exports. We reassign them on the raw `require` module object shared with the
 *     component: `useSession` -> a fn returning a mutable `sessionState`
 *     (`{ data, status, update }`) we control per test; `signIn` -> a `mock.fn`
 *     spy. The component reads both live at call-time. This avoids mounting a real
 *     `SessionProvider` (which would hit the network) and lets us drive
 *     `update()` resolve / reject / never-resolve deterministically.
 *   - The guard reaches re-login only via the REAL `ReloginOrchestrator`
 *     (its context is not exported), whose single observable downstream effect is
 *     scheduling `signIn(undefined, { callbackUrl })`. A scheduled `signIn` is our
 *     proof that `triggerRelogin` fired (and its absence proves it did NOT).
 *   - `usePathname` / `useSearchParams` (next/navigation) are getter-only exports;
 *     we feed the real hooks via Next's `PathnameContext` / `SearchParamsContext`
 *     providers so the guard/orchestrator see the exact route we set.
 *   - `useToast` uses the real `ToastProvider`; `useI18n` has no provider, so
 *     `t(key, fallback)` returns the component's Spanish fallback copy.
 *
 * Timers (anti-hang, critical): the guard creates a `setInterval(1000)` in a mount
 * effect and, on "Continuar", a `setTimeout(10000)` inside `Promise.race`. We
 * enable node:test `mock.timers` for `setInterval` + `setTimeout` + `Date` BEFORE
 * `render`, so BOTH are virtual and no real handle is ever left open (a real
 * interval/timeout is exactly what would hang `tsx --test`). `Date` is faked from a
 * fixed `START` so the Umbral_Aviso is crossed by advancing virtual time rather
 * than real time. `afterEach` unmounts (cleanup -> clearInterval) and resets the
 * timers, so every test starts pristine with zero live handles.
 *
 * **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 1.7**
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
  RELOGIN_REDIRECT_DELAY_MS,
} from "@/components/session/relogin-orchestrator";
import { GuardiaSesion } from "@/components/session/guardia-sesion";

// ---------------------------------------------------------------------------
// next-auth/react boundary: reassign the writable CommonJS exports on the raw
// module object shared with the component.
// ---------------------------------------------------------------------------
const nodeRequire = createRequire(import.meta.url);
const nextAuthReact = nodeRequire("next-auth/react") as {
  signIn: unknown;
  useSession: unknown;
};

const signInSpy = mock.fn(async () => undefined);
nextAuthReact.signIn = signInSpy;

/** Shape returned by our `useSession` mock; mutated per test. */
type SessionShape = {
  data: { expires?: string } | null;
  status: "authenticated" | "unauthenticated" | "loading";
  update: (...args: unknown[]) => Promise<unknown>;
};

let sessionState: SessionShape;
nextAuthReact.useSession = () => sessionState;

// ---------------------------------------------------------------------------
// Fixed virtual clock. `expires` ISO strings are built with the REAL Date via an
// explicit epoch (argument-form construction is not affected by the Date mock),
// so parsing stays correct while `Date.now()` is driven to `START`.
// ---------------------------------------------------------------------------
const START = Date.UTC(2027, 5, 1, 12, 0, 0);
const iso = (offsetMs: number) => new Date(START + offsetMs).toISOString();

/** The immediate re-login toast copy comes from the orchestrator i18n fallback. */
const CONTINUE_LABEL = "Continuar";

/** Mounts the guard inside the real orchestrator + providers on a given route. */
function renderGuardia(pathname: string, search = "") {
  const searchParams = new URLSearchParams(search);
  return render(
    <ToastProvider>
      <PathnameContext.Provider value={pathname}>
        <SearchParamsContext.Provider value={searchParams}>
          <ReloginOrchestrator>
            <GuardiaSesion />
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
  cleanup(); // unmount -> guard effect cleanup clears the (fake) setInterval
  mock.timers.reset(); // drop any pending fake setInterval/setTimeout, restore Date
  signInSpy.mock.resetCalls();
});

describe("GuardiaSesion", () => {
  // R1.3 / R1.4: the warning is absent while beyond the Umbral_Aviso and appears
  // within one 1000 ms tick of crossing it on a Pagina_Interna.
  test("muestra el aviso ≤1s al cruzar el Umbral_Aviso (R1.3/R1.4)", () => {
    // Session expires 200 s out: beyond the 120 s Umbral_Aviso at mount.
    const expires = iso(200_000);
    sessionState = { data: { expires }, status: "authenticated", update: mock.fn() };

    mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: START });
    renderGuardia("/finops", "tab=costs");

    // Beyond the threshold: no Aviso_Expiracion yet.
    assert.equal(screen.queryByRole("alert"), null, "sin aviso mientras falta > 120 s");

    // Advance virtual time to within the threshold (110 s remaining). The 1000 ms
    // interval fires and the countdown banner appears (<= 1 s after crossing).
    act(() => {
      mock.timers.tick(90_000);
    });

    const banner = screen.queryByRole("alert");
    assert.ok(banner, "el aviso aparece al cruzar el Umbral_Aviso");
    assert.ok(
      screen.queryByText(CONTINUE_LABEL),
      "el aviso incluye el botón Continuar"
    );
    // No redirect happened just from warning (guard only warns here).
    assert.equal(signInSpy.mock.calls.length, 0, "avisar no dispara re-login");
  });

  // R1.7: on the Ruta_Publica "/" the guard abstains completely — no warning and
  // no re-login, even when the session is unauthenticated.
  test("se abstiene por completo en la Ruta_Publica '/' (R1.7)", () => {
    sessionState = { data: null, status: "unauthenticated", update: mock.fn() };

    mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: START });
    renderGuardia("/", "foo=bar");

    assert.equal(screen.queryByRole("alert"), null, "sin aviso en la home");

    // Advance well past any threshold/timeout: still nothing must happen.
    act(() => {
      mock.timers.tick(60_000);
    });
    assert.equal(screen.queryByRole("alert"), null, "sigue sin aviso en la home");
    assert.equal(
      signInSpy.mock.calls.length,
      0,
      "en '/' un estado unauthenticated NO dispara re-login"
    );
  });

  // R1.5: "Continuar" -> update() resolves with a still-valid session in time ->
  // the notice is hidden and NO re-login is triggered.
  test("Continuar con update() válido a tiempo oculta el aviso (R1.5)", async () => {
    const expires = iso(90_000); // within the 120 s threshold at mount
    const refreshed = { expires: iso(3_600_000) }; // 1 h out
    const update = mock.fn(async () => {
      // Mirror next-auth: a successful refresh updates the live session too.
      sessionState.data = refreshed;
      return refreshed;
    });
    sessionState = { data: { expires }, status: "authenticated", update };

    mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: START });
    renderGuardia("/finops", "tab=costs");

    // Within threshold at mount: the banner is shown immediately.
    assert.ok(screen.queryByRole("alert"), "el aviso está visible al montar");

    await act(async () => {
      fireEvent.click(screen.getByText(CONTINUE_LABEL));
    });

    assert.equal(update.mock.calls.length, 1, "Continuar revalida con update()");
    assert.equal(
      screen.queryByRole("alert"),
      null,
      "sesión válida a tiempo → el aviso se oculta"
    );
    assert.equal(signInSpy.mock.calls.length, 0, "una revalidación correcta NO redirige");
  });

  // R1.6: "Continuar" -> update() never resolves -> the 10 000 ms race timeout
  // wins -> re-login is triggered (observed as a scheduled signIn).
  test("Continuar con update() que no responde (timeout) dispara re-login (R1.6)", async () => {
    const expires = iso(90_000);
    // A promise that never settles: only the race timeout can resolve the race.
    const update = mock.fn(() => new Promise<unknown>(() => {}));
    sessionState = { data: { expires }, status: "authenticated", update };

    mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: START });
    renderGuardia("/tickets");

    assert.ok(screen.queryByRole("alert"), "el aviso está visible al montar");

    // Click starts the race; update() stays pending.
    await act(async () => {
      fireEvent.click(screen.getByText(CONTINUE_LABEL));
    });
    assert.equal(signInSpy.mock.calls.length, 0, "aún no hay redirección: la carrera sigue");

    // Advance the virtual clock 10 000 ms: the race timeout resolves and the guard
    // fires triggerRelogin("guard-refresh-failed").
    await act(async () => {
      mock.timers.tick(10_000);
    });
    // The orchestrator schedules signIn after RELOGIN_REDIRECT_DELAY_MS.
    act(() => {
      mock.timers.tick(RELOGIN_REDIRECT_DELAY_MS);
    });

    assert.equal(signInSpy.mock.calls.length, 1, "el timeout de revalidación dispara re-login");
    assert.equal(lastCallbackUrl(), "/tickets", "el callbackUrl es la Ruta_Previa interna");
  });

  // R1.6: "Continuar" -> update() rejects -> re-login is triggered.
  test("Continuar con update() que falla dispara re-login (R1.6)", async () => {
    const expires = iso(90_000);
    const update = mock.fn(async () => {
      throw new Error("refresh failed");
    });
    sessionState = { data: { expires }, status: "authenticated", update };

    mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: START });
    renderGuardia("/finops", "tab=costs");

    assert.ok(screen.queryByRole("alert"), "el aviso está visible al montar");

    await act(async () => {
      fireEvent.click(screen.getByText(CONTINUE_LABEL));
    });
    act(() => {
      mock.timers.tick(RELOGIN_REDIRECT_DELAY_MS);
    });

    assert.equal(signInSpy.mock.calls.length, 1, "un update() fallido dispara re-login");
    assert.equal(lastCallbackUrl(), "/finops?tab=costs", "callbackUrl = Ruta_Previa interna");
  });

  // R1.2: status "unauthenticated" on a Pagina_Interna fires triggerRelogin("guard")
  // without showing a countdown banner.
  test("status unauthenticated en Pagina_Interna dispara re-login (R1.2)", () => {
    sessionState = { data: null, status: "unauthenticated", update: mock.fn() };

    mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: START });
    renderGuardia("/finops", "tab=costs");

    // No countdown banner for an already-unauthenticated session.
    assert.equal(screen.queryByRole("alert"), null, "sin banner de cuenta atrás");

    // The mount evaluation triggers re-login; advancing fires the scheduled signIn.
    act(() => {
      mock.timers.tick(RELOGIN_REDIRECT_DELAY_MS);
    });
    assert.equal(signInSpy.mock.calls.length, 1, "unauthenticated → un único re-login");
    assert.equal(lastCallbackUrl(), "/finops?tab=costs", "callbackUrl = Ruta_Previa interna");
  });
});
