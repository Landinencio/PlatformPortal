/**
 * Configuration tests for the app-wide Providers wiring.
 *
 * Feature: session-nav-hardening, Task 12.2
 *
 * Component under test: src/components/providers.tsx
 *   `Providers` mounts the whole client provider stack. For the session/nav
 *   hardening feature it must:
 *     - render `<SessionProvider>` with `refetchInterval={300}` and
 *       `refetchOnWindowFocus` (R1.1), and
 *     - mount the ReloginOrchestrator, HttpInterceptor and GuardiaSesion exactly
 *       ONCE inside that provider (R1.8).
 *
 * Approach & infra notes
 * ----------------------
 * The portal's runner is `tsx --test` (node:test) on pure logic — no jsdom/RTL by
 * default. We bootstrap the shared minimal jsdom environment via
 * `../../lib/__tests__/helpers/jsdom-setup` (imported FIRST, before
 * `@testing-library/react`) and run under `tsconfig.test.json` (`jsx: react-jsx`)
 * selected with `TSX_TSCONFIG_PATH`, exactly like the sibling
 * `relogin-orchestrator.test.tsx` / `http-interceptor.test.tsx`.
 *
 * Anti-hang design (a previous attempt hung the suite for hours):
 *   - `SessionProvider` (next-auth/react) is a writable CommonJS export. We
 *     reassign it on the raw `require` module object (same trick the sibling
 *     tests use for `signIn`) to a spy that records its props and just renders
 *     `children`. This NEVER opens the real `refetchInterval` (300 s) timer nor
 *     the `/api/auth/session` fetch, so the process exits on its own.
 *   - `useSession` is likewise reassigned to a controlled stub, so `GuardiaSesion`
 *     and `ActivityTracker` don't hit the network. With `status: "loading"` (and
 *     no `user`) both stay inert; with a near-expiry authenticated session
 *     `GuardiaSesion` shows exactly one warning banner.
 *   - `signIn` is stubbed to a spy so the re-login redirect never navigates.
 *   - `usePathname` / `useSearchParams` are getter-only exports; we feed the real
 *     hooks through Next's `PathnameContext` / `SearchParamsContext`. On the
 *     public route "/" `GuardiaSesion` abstains, so its `setInterval(1000)` is
 *     never created. Where an internal route is needed, `cleanup()` unmounts and
 *     clears the interval so no handle survives the test.
 *
 * Timers stay real for the mount; the only test that drives time uses node:test
 * `mock.timers` enabled AFTER mount (like the sibling tests) to fire the single
 * scheduled `signIn`, proving the interceptor is wired to the orchestrator.
 *
 * **Validates: Requirements 1.1, 1.8**
 */

import { window as jsdomWindow } from "../../lib/__tests__/helpers/jsdom-setup";

import { createRequire } from "node:module";
import { test, afterEach, describe, mock } from "node:test";
import assert from "node:assert/strict";

import { act, cleanup, render, screen } from "@testing-library/react";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { RELOGIN_REDIRECT_DELAY_MS } from "@/components/session/relogin-orchestrator";

// The I18nProvider reads `localStorage` in a mount effect; jsdom-setup does not
// copy it onto the Node global scope, so bridge it here (as the sibling tests do).
if (typeof (globalThis as Record<string, unknown>).localStorage === "undefined") {
  (globalThis as Record<string, unknown>).localStorage = jsdomWindow.localStorage;
}
if (typeof (globalThis as Record<string, unknown>).sessionStorage === "undefined") {
  (globalThis as Record<string, unknown>).sessionStorage = jsdomWindow.sessionStorage;
}

// ---------------------------------------------------------------------------
// Reassign the writable CommonJS `next-auth/react` exports BEFORE importing the
// component under test, so `providers.tsx` (whose esbuild namespace uses live
// getters over this same module object) picks up our stubs.
// ---------------------------------------------------------------------------
const nodeRequire = createRequire(import.meta.url);
const nextAuthReact = nodeRequire("next-auth/react") as {
  SessionProvider: unknown;
  useSession: unknown;
  signIn: unknown;
};

/** Latest props received by the SessionProvider (for the R1.1 assertions). */
let sessionProviderProps: Record<string, unknown> | null = null;

/** Spy SessionProvider: records props, renders children, opens no timers/fetch. */
function SessionProviderSpy(props: { children?: unknown } & Record<string, unknown>) {
  sessionProviderProps = props;
  return (props.children ?? null) as JSX.Element | null;
}
nextAuthReact.SessionProvider = SessionProviderSpy;

/** Controlled session value, tuned per test. */
type SessionStub = { data: unknown; status: string; update: () => Promise<unknown> };
let sessionValue: SessionStub = {
  data: null,
  status: "loading",
  update: async () => null,
};
nextAuthReact.useSession = () => sessionValue;

/** Stub `signIn` so the scheduled re-login redirect never navigates. */
const signInSpy = mock.fn(async () => undefined);
nextAuthReact.signIn = signInSpy;

// Imported AFTER the reassignments above.
import { Providers } from "@/components/providers";

/**
 * The real `window.fetch` before any interceptor patch, restored per test.
 * jsdom 25 ships no `fetch`, so this may be `undefined`; the HttpInterceptor
 * expects a real `window.fetch` (always present in the browser), so each test
 * installs a benign stub before mounting.
 */
const pristineFetch: typeof window.fetch = window.fetch;

/** Installs a benign 200 `window.fetch` so the interceptor has something to wrap. */
function installBenignFetch() {
  window.fetch = mock.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof window.fetch;
}

/** Renders <Providers> under controlled navigation context. */
function renderProviders(pathname: string, search = "") {
  const searchParams = new URLSearchParams(search);
  return render(
    <PathnameContext.Provider value={pathname}>
      <SearchParamsContext.Provider value={searchParams}>
        <Providers>
          <div data-testid="app-child">contenido</div>
        </Providers>
      </SearchParamsContext.Provider>
    </PathnameContext.Provider>
  );
}

/** Lets the lazy i18n JSON import + mount effects settle (real timers). */
async function flushMountEffects() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
  }
}

afterEach(() => {
  cleanup(); // unmount → HttpInterceptor cleanup restores fetch, GuardiaSesion clears its interval
  mock.timers.reset();
  signInSpy.mock.resetCalls();
  sessionProviderProps = null;
  sessionValue = { data: null, status: "loading", update: async () => null };
  window.fetch = pristineFetch;
});

describe("Providers — session/nav hardening wiring", () => {
  // R1.1: the SessionProvider is configured with a 300 s refetch and refetch on
  // window focus, so the session stays fresh across tabs/idle.
  test("configura SessionProvider con refetchInterval=300 y refetchOnWindowFocus (R1.1)", async () => {
    // Public route + loading session: GuardiaSesion abstains (no interval),
    // ActivityTracker no-ops — nothing to keep the process alive.
    installBenignFetch();
    renderProviders("/");
    await flushMountEffects();

    assert.ok(sessionProviderProps, "el SessionProvider se renderiza");
    assert.equal(
      sessionProviderProps?.refetchInterval,
      300,
      "refetchInterval configurado a 300 s"
    );
    assert.equal(
      sessionProviderProps?.refetchOnWindowFocus,
      true,
      "refetchOnWindowFocus habilitado"
    );

    // Sanity: the children the app wraps are actually rendered inside the stack.
    assert.ok(screen.queryByTestId("app-child"), "los children de la app se renderizan");
  });

  // R1.8: GuardiaSesion is mounted exactly once. It is NOT idempotent — a second
  // mount would render a second warning banner — so on a near-expiry session the
  // count of warning banners is a faithful single-mount witness.
  test("monta GuardiaSesion una sola vez (R1.8)", async () => {
    // Authenticated session ~60 s from expiry (inside the 120 s warning window),
    // deliberately WITHOUT `user` so ActivityTracker stays inert (no network).
    sessionValue = {
      data: { expires: new Date(Date.now() + 60_000).toISOString() },
      status: "authenticated",
      update: async () => null,
    };

    installBenignFetch();
    renderProviders("/finops", "tab=costs");
    await flushMountEffects();

    const banners = screen.getAllByRole("alert");
    assert.equal(banners.length, 1, "exactamente un Aviso_Expiracion (GuardiaSesion montada una vez)");

    // HttpInterceptor is mounted alongside it (patched window.fetch exactly once).
    const patched = window.fetch as typeof window.fetch & { __portalPatched?: true };
    assert.equal(patched.__portalPatched, true, "el HttpInterceptor está montado (fetch parcheado)");
    assert.notEqual(patched, pristineFetch, "window.fetch ya no es el original");
  });

  // R1.8: HttpInterceptor + ReloginOrchestrator are mounted and wired together.
  // A 401 flowing through the patched fetch must trigger a single scheduled
  // re-login via the orchestrator, proving both are present and connected.
  test("monta HttpInterceptor y lo enlaza al ReloginOrchestrator (R1.8)", async () => {
    // Underlying fetch returns 401 for /api/*; capture it before mount so the
    // interceptor wraps it as its originalFetch.
    const unauthorized = new Response("{}", { status: 401 });
    window.fetch = mock.fn(async () => unauthorized) as unknown as typeof window.fetch;

    // Public route + loading session → GuardiaSesion abstains (no interval),
    // leaving the scheduled re-login timeout as the only timer in play.
    renderProviders("/");
    await flushMountEffects();

    const patched = window.fetch as typeof window.fetch & { __portalPatched?: true };
    assert.equal(patched.__portalPatched, true, "el HttpInterceptor parchea window.fetch");

    mock.timers.enable({ apis: ["setTimeout"] });

    let returned: Response | undefined;
    await act(async () => {
      returned = await window.fetch("/api/data");
    });
    // Passthrough contract: the original Response comes back untouched (R2.5).
    assert.equal(returned, unauthorized, "devuelve el Response original");
    assert.equal(signInSpy.mock.calls.length, 0, "el re-login está programado, aún no ejecutado");

    // Advancing past the orchestrator delay fires exactly one re-login.
    act(() => {
      mock.timers.tick(RELOGIN_REDIRECT_DELAY_MS);
    });
    assert.equal(
      signInSpy.mock.calls.length,
      1,
      "un 401 dispara un único re-login vía el orquestador montado"
    );
  });
});
