/**
 * Example/unit tests for the toast auto-close duration.
 *
 * Feature: session-nav-hardening, Task 7.2
 *
 * Component under test: src/components/ui/toast.tsx
 *   `ToastProvider` exposes `toast(type, message, opts?: { durationMs?: number })`.
 *   The auto-close timer uses `opts.durationMs ?? 4000` (default 4000 ms). Task 7.1
 *   extended the signature; this test pins the timing contract that R2.3 relies on
 *   (the 403 notice must stay visible >= 5000 ms).
 *
 * Approach & infra notes
 * ----------------------
 * The portal's runner is `tsx --test` (node:test) on pure logic — no jsdom/RTL by
 * default. We bootstrap the shared minimal jsdom environment via
 * `../../lib/__tests__/helpers/jsdom-setup` (imported FIRST, before
 * `@testing-library/react`) and run under `tsconfig.test.json` (`jsx: react-jsx`)
 * selected with `TSX_TSCONFIG_PATH`, exactly like `dora-author-scope-ui.test.tsx`.
 *
 * Timers: the provider schedules the auto-close with the global `setTimeout`, so we
 * drive time deterministically with node:test `mock.timers` (only the `setTimeout`
 * api). Fake timers are enabled AFTER `render` so React's mount/flush is untouched,
 * and each `tick` is wrapped in `act()` because the timer callback triggers a React
 * state update (removing the toast).
 *
 * **Validates: Requirements 2.3**
 */

import "../../lib/__tests__/helpers/jsdom-setup";

import test, { afterEach, describe, mock } from "node:test";
import assert from "node:assert/strict";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ToastProvider, useToast } from "@/components/ui/toast";

const MESSAGE = "sesión a punto de caducar";

/** Minimal harness: a button that fires a toast with the given options. */
function ToastTrigger({ durationMs }: { durationMs?: number }) {
  const { toast } = useToast();
  return (
    <button
      onClick={() =>
        toast("warning", MESSAGE, durationMs === undefined ? undefined : { durationMs })
      }
    >
      fire
    </button>
  );
}

afterEach(() => {
  cleanup();
  mock.timers.reset();
});

describe("toast auto-close duration", () => {
  // R2.3 baseline: retro-compatible default of 4000 ms when no options are passed.
  test("con opciones por defecto el toast desaparece tras 4000 ms", () => {
    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>
    );

    // Enable fake timers AFTER mount so React's initial render is unaffected.
    mock.timers.enable({ apis: ["setTimeout"] });

    fireEvent.click(screen.getByText("fire"));
    assert.ok(screen.queryByText(MESSAGE), "el toast es visible tras dispararse");

    act(() => {
      mock.timers.tick(3999);
    });
    assert.ok(screen.queryByText(MESSAGE), "sigue visible a los 3999 ms");

    act(() => {
      mock.timers.tick(1);
    });
    assert.equal(
      screen.queryByText(MESSAGE),
      null,
      "desaparece justo al alcanzar los 4000 ms"
    );
  });

  // R2.3: durationMs override keeps the toast visible for >= 5000 ms (403 notice).
  test("con durationMs 5000 el toast se mantiene visible >= 5000 ms", () => {
    render(
      <ToastProvider>
        <ToastTrigger durationMs={5000} />
      </ToastProvider>
    );

    mock.timers.enable({ apis: ["setTimeout"] });

    fireEvent.click(screen.getByText("fire"));
    assert.ok(screen.queryByText(MESSAGE), "el toast es visible tras dispararse");

    // Past the 4000 ms default: a durationMs toast must NOT have closed yet.
    act(() => {
      mock.timers.tick(4000);
    });
    assert.ok(
      screen.queryByText(MESSAGE),
      "sigue visible superado el default de 4000 ms"
    );

    act(() => {
      mock.timers.tick(999);
    });
    assert.ok(screen.queryByText(MESSAGE), "sigue visible a los 4999 ms");

    act(() => {
      mock.timers.tick(1);
    });
    assert.equal(
      screen.queryByText(MESSAGE),
      null,
      "desaparece justo al alcanzar los 5000 ms"
    );
  });
});
