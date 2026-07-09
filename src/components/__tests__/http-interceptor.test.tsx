/**
 * Example tests for the HttpInterceptor global fetch monkey-patch.
 *
 * Feature: session-nav-hardening, Task 8.2
 *
 * Component under test: src/components/session/http-interceptor.tsx
 *   `HttpInterceptor(): null` replaces `window.fetch` ONCE (idempotent marker
 *   `__portalPatched`) with a wrapper that, after each same-origin `/api/*`
 *   response (excluding `/api/auth/*`), classifies via the pure core
 *   `http-interceptor-core.ts`:
 *     - 401 -> `triggerRelogin("http-401")` (single-flight re-login)   (R2.2)
 *     - 403 -> non-blocking `toast(..., { durationMs: 5000 })`, no redirect (R2.3)
 *     - other -> passthrough (same Response, body untouched)           (R2.5/R2.7)
 *   Network rejections propagate unwrapped with no side effects        (R2.8).
 *
 * Approach & infra notes
 * ----------------------
 * The portal's runner is `tsx --test` (node:test) on pure logic — no jsdom/RTL by
 * default. We bootstrap the shared minimal jsdom environment via
 * `../../lib/__tests__/helpers/jsdom-setup` (imported FIRST, before
 * `@testing-library/react`) and run under `tsconfig.test.json` (`jsx: react-jsx`)
 * selected with `TSX_TSCONFIG_PATH`, exactly like `relogin-orchestrator.test.tsx`
 * and `toast-duration.test.tsx`.
 *
 * The interceptor needs a `triggerRelogin` observer. `ReloginContext` is NOT
 * exported from `relogin-orchestrator.tsx`, so we mount the REAL
 * `ReloginOrchestrator` and observe its single downstream effect: on a re-login
 * it schedules `signIn(undefined, { callbackUrl })`. We spy on that `signIn` the
 * same way the orchestrator test does (reassign the writable CommonJS export on
 * the raw `require` module object), so a scheduled `signIn` proves `triggerRelogin`
 * fired — and its absence proves it did NOT.
 *
 * Module boundaries:
 *   - `originalFetch`: we assign a `mock.fn` to `window.fetch` BEFORE mounting, so
 *     the interceptor captures it as the underlying fetch. It returns a `Response`
 *     with the desired status, or rejects (network case).
 *   - `usePathname` / `useSearchParams` (next/navigation) are getter-only exports;
 *     we feed the real hooks via Next's `PathnameContext` / `SearchParamsContext`
 *     providers so the captured `callbackUrl` is deterministic.
 *   - `useToast` uses the real `ToastProvider` (we assert the 403 notice renders).
 *   - `useI18n` uses the real `I18nProvider` (default locale `es`), so the 403
 *     toast shows the Spanish `http.forbidden` copy.
 *
 * Timers: the re-login redirect and the toast auto-close use the global
 * `setTimeout`, driven with node:test `mock.timers` (enabled AFTER mount and after
 * the lazy i18n catalog has loaded, so neither React's mount nor the JSON import is
 * disturbed). `Date.now()` stays real for the 5000 ms dedupe window.
 *
 * **Validates: Requirements 2.2, 2.3, 2.8**
 */

import { window as jsdomWindow } from "../../lib/__tests__/helpers/jsdom-setup";

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { test, afterEach, describe, mock } from "node:test";
import assert from "node:assert/strict";

import { act, cleanup, render, screen } from "@testing-library/react";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { ToastProvider } from "@/components/ui/toast";
import { I18nProvider } from "@/lib/i18n";
import {
  ReloginOrchestrator,
  RELOGIN_REDIRECT_DELAY_MS,
} from "@/components/session/relogin-orchestrator";
import { HttpInterceptor } from "@/components/session/http-interceptor";

// The I18nProvider reads `localStorage` in a mount effect; jsdom-setup does not
// copy it onto the Node global scope, so bridge it here (as boton-volver does).
if (typeof (globalThis as Record<string, unknown>).localStorage === "undefined") {
  (globalThis as Record<string, unknown>).localStorage = jsdomWindow.localStorage;
}

// Spy on the writable CommonJS `signIn` export shared with the orchestrator: a
// scheduled `signIn` is the observable proof that `triggerRelogin` fired.
const nodeRequire = createRequire(import.meta.url);
const nextAuthReact = nodeRequire("next-auth/react") as { signIn: unknown };
const signInSpy = mock.fn(async () => undefined);
nextAuthReact.signIn = signInSpy;

const FORBIDDEN_TEXT = loadEsCatalog()["http.forbidden"];

/** Reads the Spanish catalog from disk (avoids JSON-import interop quirks). */
function loadEsCatalog(): Record<string, string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(resolve(here, "../../i18n/es.json"), "utf8");
  return JSON.parse(raw) as Record<string, string>;
}

/** The real `window.fetch` before any patching, restored between tests. */
const pristineFetch: typeof window.fetch = window.fetch;

/** Builds an `originalFetch` stub that resolves to a Response of `status`. */
function fetchReturning(response: Response) {
  return mock.fn(async () => response);
}

/**
 * Mounts the interceptor inside the real orchestrator + providers, with a
 * controlled Ruta_Previa. `window.fetch` must already be the stubbed
 * `originalFetch` so the effect captures it.
 */
function renderInterceptor(pathname = "/finops", search = "tab=costs") {
  const searchParams = new URLSearchParams(search);
  return render(
    <I18nProvider>
      <ToastProvider>
        <PathnameContext.Provider value={pathname}>
          <SearchParamsContext.Provider value={searchParams}>
            <ReloginOrchestrator>
              <HttpInterceptor />
            </ReloginOrchestrator>
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </ToastProvider>
    </I18nProvider>
  );
}

/** Flush the lazy i18n JSON import (real timers) before faking timers. */
async function flushI18n() {
  // The I18nProvider resolves `import("@/i18n/es.json")` then setState; give it
  // several real-timer cycles so `t` is the Spanish catalog by the time the
  // interceptor renders the 403 toast. Must run BEFORE enabling fake timers.
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

function lastCallbackUrl(): string | undefined {
  const calls = signInSpy.mock.calls;
  if (calls.length === 0) return undefined;
  const args = calls[calls.length - 1].arguments as [unknown, { callbackUrl?: string }?];
  return args[1]?.callbackUrl;
}

afterEach(() => {
  cleanup(); // unmount → interceptor cleanup restores the captured originalFetch
  mock.timers.reset();
  signInSpy.mock.resetCalls();
  // Fully detach any lingering wrapper so the next test starts pristine.
  window.fetch = pristineFetch;
});

describe("HttpInterceptor", () => {
  // R2.2: a 401 on /api/* triggers the single-flight re-login (observed as a
  // scheduled signIn), and the returned Response is the original object.
  test("401 en /api/* dispara el re-login (triggerRelogin) (R2.2)", async () => {
    const original = new Response("{}", { status: 401 });
    window.fetch = fetchReturning(original);
    renderInterceptor("/finops", "tab=costs");
    await flushI18n();

    mock.timers.enable({ apis: ["setTimeout"] });

    let returned: Response | undefined;
    await act(async () => {
      returned = await window.fetch("/api/data");
    });

    // The interceptor never consumes/alters the body: same object back (R2.5).
    assert.equal(returned, original, "devuelve el mismo Response original");
    assert.equal(signInSpy.mock.calls.length, 0, "el signIn está programado, aún no ejecutado");

    // The re-login redirect is scheduled; advancing the timer fires signIn once.
    act(() => {
      mock.timers.tick(RELOGIN_REDIRECT_DELAY_MS);
    });
    assert.equal(signInSpy.mock.calls.length, 1, "un 401 dispara exactamente un re-login");
    assert.equal(
      lastCallbackUrl(),
      "/finops?tab=costs",
      "el callbackUrl es la Ruta_Previa interna capturada"
    );
  });

  // R2.3: a 403 on /api/* shows a non-blocking toast for >= 5000 ms and does NOT
  // redirect (no signIn ever scheduled).
  test("403 en /api/* muestra toast >= 5000 ms sin redirigir (R2.3)", async () => {
    const original = new Response("{}", { status: 403 });
    window.fetch = fetchReturning(original);
    renderInterceptor("/tickets", "");
    await flushI18n();

    mock.timers.enable({ apis: ["setTimeout"] });

    let returned: Response | undefined;
    await act(async () => {
      returned = await window.fetch("/api/protected");
    });

    assert.equal(returned, original, "el 403 también devuelve el Response original intacto");
    // The forbidden notice is visible with the Spanish i18n copy.
    assert.ok(
      screen.queryByText(FORBIDDEN_TEXT),
      `el aviso de 403 (${JSON.stringify(FORBIDDEN_TEXT)}) es visible`
    );

    // It must persist past the default 4000 ms window (durationMs: 5000).
    act(() => {
      mock.timers.tick(4999);
    });
    assert.ok(screen.queryByText(FORBIDDEN_TEXT), "sigue visible a los 4999 ms");
    act(() => {
      mock.timers.tick(1);
    });
    assert.equal(screen.queryByText(FORBIDDEN_TEXT), null, "desaparece justo a los 5000 ms");

    // R2.3: a 403 never triggers a re-login redirect, even after ample time.
    act(() => {
      mock.timers.tick(10_000);
    });
    assert.equal(signInSpy.mock.calls.length, 0, "un 403 no redirige a login");
  });

  // R2.8: a network rejection (no HTTP response) propagates unwrapped and causes
  // NO side effects (no toast, no re-login).
  test("rechazo de red se propaga sin efectos (R2.8)", async () => {
    const netError = new Error("network down");
    window.fetch = mock.fn(async () => {
      throw netError;
    });
    renderInterceptor("/finops", "tab=costs");
    await flushI18n();

    mock.timers.enable({ apis: ["setTimeout"] });

    await act(async () => {
      await assert.rejects(
        () => window.fetch("/api/data"),
        (err: unknown) => err === netError,
        "el error de red se propaga sin envolver"
      );
    });

    act(() => {
      mock.timers.tick(10_000);
    });
    assert.equal(signInSpy.mock.calls.length, 0, "un fallo de red no dispara re-login");
    assert.equal(
      screen.queryByText(FORBIDDEN_TEXT),
      null,
      "un fallo de red no muestra el aviso de 403"
    );
  });

  // R2.1: installation is idempotent — mounting a second interceptor does NOT
  // re-wrap `window.fetch`; the same patched function stays in place.
  test("instalación idempotente: no anida wrappers (R2.1)", async () => {
    const original = new Response("{}", { status: 200 });
    window.fetch = fetchReturning(original);

    // First mount patches window.fetch exactly once (effects flush inside render's
    // internal act). We intentionally do NOT flush the lazy i18n load here: a
    // changing `t` would legitimately re-run the effect (cleanup + re-patch),
    // which is orthogonal to the "no nested wrappers on a second mount" invariant.
    renderInterceptor("/finops", "tab=costs");

    const patched = window.fetch as typeof window.fetch & { __portalPatched?: true };
    assert.equal(patched.__portalPatched, true, "el primer montaje instala el wrapper");
    assert.notEqual(patched, original, "window.fetch ya no es el originalFetch");

    // Second, independent mount must find the marker and skip re-wrapping, so the
    // very same wrapper reference stays installed (no nesting).
    renderInterceptor("/tickets", "");
    assert.equal(
      window.fetch,
      patched,
      "un segundo montaje no vuelve a envolver window.fetch"
    );

    // A single delegated call reaches the underlying originalFetch and returns its
    // Response untouched.
    let returned: Response | undefined;
    await act(async () => {
      returned = await window.fetch("/api/data");
    });
    assert.equal(returned, original, "el wrapper único devuelve el Response del originalFetch");
  });
});
