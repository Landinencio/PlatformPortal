/**
 * Component tests for the single BotonVolver anchor in the PortalShell.
 *
 * Feature: session-nav-hardening, Task 14.2
 *
 * Component under test: src/components/portal-shell.tsx
 *   Per design decision D4, the `BotonVolver` is anchored EXACTLY ONCE in the
 *   page header area that `PortalShell` renders (next to `PageHeader`), in an
 *   identical position across every Pagina_Interna (R6.1 / R6.7). Because
 *   `PortalShell` is never rendered on the Ruta_Publica "/" (the
 *   `ConditionalShell` gate keeps `STANDALONE_PATHS = ["/"]` out of the shell),
 *   the home page shows ZERO back buttons (R6.2). We exercise both the shell
 *   directly and through its real `ConditionalShell` gate.
 *
 * Approach & infra notes
 * ----------------------
 * The portal's runner is `tsx --test` (node:test) on pure logic — no jsdom/RTL by
 * default. We bootstrap the shared minimal jsdom environment via
 * `../../lib/__tests__/helpers/jsdom-setup` (imported FIRST, before
 * `@testing-library/react`) and run under `tsconfig.test.json` (`jsx: react-jsx`)
 * selected with `TSX_TSCONFIG_PATH`, exactly like `boton-volver.test.tsx`.
 *
 * Module boundaries (no `mock.module` on this repo's Node 20 runtime):
 *   - `useSession` / `signOut` (next-auth/react) are writable CommonJS named
 *     exports. We reassign `useSession` on the raw `require` module object shared
 *     with the components to a fn returning a fixed authenticated session, so the
 *     shell renders without mounting a real `SessionProvider` (which would hit the
 *     network). `signOut` is only invoked on click, never in these tests.
 *   - `usePathname` / `useSearchParams` (next/navigation) are getter-only exports;
 *     we feed the real hooks the exact route via Next's `PathnameContext` /
 *     `SearchParamsContext` providers. `useRouter` is fed a fake router through the
 *     `AppRouterContext` provider (same pattern as `boton-volver.test.tsx`), so the
 *     shell's `<Link>`s and the BotonVolver resolve without real navigation.
 *   - `useI18n` reads its default context (no provider): `t(key, fallback)` returns
 *     the fallback/ key synchronously, so the BotonVolver label degrades — totally
 *     and safely — to the shared Spanish "Volver". No async locale load, no open
 *     handles.
 *
 * Anti-hang guarantees (a prior spec attempt hung `npm test` for hours):
 *   - The shell's children (`NotificationBell`, `DataFreshness`, `StaleDataBanner`)
 *     fetch on mount AND install `setInterval` pollers. We (a) stub `globalThis.fetch`
 *     with a resolved, side-effect-free response so there is zero real network I/O,
 *     and (b) enable node:test `mock.timers` for `setInterval`/`setTimeout` BEFORE
 *     render so no real timer handle is ever created. `afterEach` unmounts
 *     (`cleanup` -> effect cleanup -> clearInterval) and resets the fake timers, so
 *     every test leaves zero live handles and the process exits on its own.
 *
 * BotonVolver detection: the BotonVolver is the only control in the shell that
 * renders lucide's `ArrowLeft` icon (marked with the `lucide-arrow-left` class);
 * counting `svg.lucide-arrow-left` therefore counts BotonVolver instances exactly.
 *
 * **Validates: Requirements 6.1, 6.2, 6.7**
 */

import "../../lib/__tests__/helpers/jsdom-setup";
import { window as jsdomWindow } from "../../lib/__tests__/helpers/jsdom-setup";

import { createRequire } from "node:module";
import test, { after, afterEach, before, describe, mock } from "node:test";
import assert from "node:assert/strict";

import { cleanup, render } from "@testing-library/react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { PortalShell } from "@/components/portal-shell";
import { ConditionalShell } from "@/components/conditional-shell";

// ---------------------------------------------------------------------------
// Bridge browser globals the shell's children rely on but the minimal
// jsdom-setup does not install: `next/link`'s `useIntersection` reads
// `self.requestIdleCallback`, and `ThemeToggle` reads `localStorage` in a mount
// effect. Without these the children throw in the passive-effect commit phase
// and fail the render. `requestIdleCallback` is stubbed onto (virtual) setTimeout
// so no real handle is ever created under `mock.timers`.
// ---------------------------------------------------------------------------
{
  const g = globalThis as Record<string, unknown>;
  if (typeof g.self === "undefined") g.self = g;
  if (typeof g.localStorage === "undefined") g.localStorage = jsdomWindow.localStorage;
  if (typeof g.requestIdleCallback === "undefined") {
    g.requestIdleCallback = (cb: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void) =>
      setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 0);
    g.cancelIdleCallback = (id: number) => clearTimeout(id);
  }
}

// ---------------------------------------------------------------------------
// next-auth/react boundary: reassign the writable CommonJS export shared with
// the shell. A fixed authenticated admin session lets PortalShell render every
// nav item without a real SessionProvider.
// ---------------------------------------------------------------------------
const nodeRequire = createRequire(import.meta.url);
const nextAuthReact = nodeRequire("next-auth/react") as { useSession: unknown };

type SessionShape = {
  data: { user: { appRole: string; name: string } } | null;
  status: "authenticated" | "unauthenticated" | "loading";
};

let sessionState: SessionShape = {
  data: { user: { appRole: "admin", name: "Test User" } },
  status: "authenticated",
};
nextAuthReact.useSession = () => sessionState;

// ---------------------------------------------------------------------------
// Side-effect-free fetch stub so the shell's polling children never touch the
// network. Every endpoint they call tolerates this shape.
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
before(() => {
  (globalThis as Record<string, unknown>).fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      count: 0,
      unreadCount: 0,
      notifications: [],
      meta: { latestSnapshot: null },
    }),
  }));
});

/** Fake AppRouterInstance whose navigation methods are inert spies. */
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

/** Wraps a subtree in the router/pathname/search providers for a given route. */
function withProviders(pathname: string, node: React.ReactNode) {
  const router = makeRouter();
  return (
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value={pathname}>
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          {node}
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

/** Count of BotonVolver instances in the rendered tree (one ArrowLeft each). */
function countBackButtons(container: HTMLElement): number {
  return container.querySelectorAll("svg.lucide-arrow-left").length;
}

const CHILD_MARKER = "page-content-marker";

afterEach(() => {
  cleanup(); // unmount -> children effect cleanup clears the (fake) setInterval pollers
  mock.timers.reset(); // drop any pending fake timers
  sessionState = {
    data: { user: { appRole: "admin", name: "Test User" } },
    status: "authenticated",
  };
});

// Restore the real fetch once the whole file is done.
after(() => {
  (globalThis as Record<string, unknown>).fetch = originalFetch;
});

describe("PortalShell — anclaje del BotonVolver", () => {
  // R6.1: a Pagina_Interna rendered inside PortalShell shows exactly one
  // BotonVolver.
  test("renderiza exactamente un BotonVolver en una Pagina_Interna (R6.1)", () => {
    mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

    const { container } = render(
      withProviders(
        "/finops",
        <PortalShell>
          <div data-testid={CHILD_MARKER}>contenido</div>
        </PortalShell>
      )
    );

    assert.equal(
      countBackButtons(container),
      1,
      "debe haber exactamente un BotonVolver en la Pagina_Interna"
    );
  });

  // R6.7: the single BotonVolver is anchored in the page header area, in a
  // verifiable position relative to the page content — it precedes the page
  // content in document order, identically for every Pagina_Interna.
  test("ancla el BotonVolver antes del contenido de página, en posición fija (R6.7)", () => {
    mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

    const { container, getByTestId } = render(
      withProviders(
        "/tickets",
        <PortalShell>
          <div data-testid={CHILD_MARKER}>contenido</div>
        </PortalShell>
      )
    );

    const backIcon = container.querySelector("svg.lucide-arrow-left");
    assert.ok(backIcon, "el BotonVolver está presente");

    const marker = getByTestId(CHILD_MARKER);
    // The anchor sits above the page content: the marker FOLLOWS the back button.
    const relation = backIcon!.compareDocumentPosition(marker);
    assert.ok(
      relation & Node.DOCUMENT_POSITION_FOLLOWING,
      "el BotonVolver se ancla por encima del contenido de la página"
    );
  });

  // R6.7 (consistency): the anchor is identical across different Pagina_Interna
  // routes — always exactly one, always above the content.
  test("la posición del BotonVolver es idéntica en distintas Pagina_Interna (R6.7)", () => {
    for (const route of ["/finops", "/metrics", "/create-repo", "/admin"]) {
      mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
      const { container, getByTestId, unmount } = render(
        withProviders(
          route,
          <PortalShell>
            <div data-testid={CHILD_MARKER}>contenido</div>
          </PortalShell>
        )
      );

      assert.equal(countBackButtons(container), 1, `un único BotonVolver en ${route}`);
      const backIcon = container.querySelector("svg.lucide-arrow-left")!;
      const marker = getByTestId(CHILD_MARKER);
      assert.ok(
        backIcon.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING,
        `el BotonVolver precede al contenido en ${route}`
      );
      unmount();
      mock.timers.reset();
    }
  });
});

describe("ConditionalShell — presencia del BotonVolver por ruta", () => {
  // R6.1: through the real gate, an authenticated Pagina_Interna renders the
  // PortalShell and therefore exactly one BotonVolver.
  test("una Pagina_Interna autenticada monta el PortalShell con un BotonVolver (R6.1)", () => {
    mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    sessionState = {
      data: { user: { appRole: "admin", name: "Test User" } },
      status: "authenticated",
    };

    const { container, getByTestId } = render(
      withProviders(
        "/finops",
        <ConditionalShell>
          <div data-testid={CHILD_MARKER}>contenido</div>
        </ConditionalShell>
      )
    );

    // The gate rendered the shell (content is present) with a single back button.
    assert.ok(getByTestId(CHILD_MARKER), "el contenido de la Pagina_Interna se renderiza");
    assert.equal(
      countBackButtons(container),
      1,
      "la Pagina_Interna presenta exactamente un BotonVolver"
    );
  });

  // R6.2: on the Ruta_Publica "/", the gate keeps the page out of the PortalShell,
  // so the home shows ZERO back buttons.
  test("la Ruta_Publica '/' presenta cero BotonVolver (R6.2)", () => {
    mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    sessionState = {
      data: { user: { appRole: "admin", name: "Test User" } },
      status: "authenticated",
    };

    const { container, getByTestId } = render(
      withProviders(
        "/",
        <ConditionalShell>
          <div data-testid={CHILD_MARKER}>home</div>
        </ConditionalShell>
      )
    );

    // Home renders its own standalone layout (children only), never the shell.
    assert.ok(getByTestId(CHILD_MARKER), "la home renderiza su propio layout");
    assert.equal(
      countBackButtons(container),
      0,
      "la home ('/') no presenta ningún BotonVolver"
    );
  });
});
