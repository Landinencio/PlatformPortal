/**
 * Minimal jsdom environment registration for React component tests run under
 * `tsx --test` (node:test). The portal's default test runner is pure-logic
 * (`tsx --test` + fast-check) with no browser DOM, so React Testing Library has
 * no environment to render into. Importing this module FIRST in a `.test.tsx`
 * file installs a jsdom `window`/`document`/`navigator` on the global scope and
 * flags the React act() environment, so `@testing-library/react` can mount,
 * query and fire DOM events.
 *
 * This is the equivalent of `global-jsdom/register` but without an extra
 * dependency, and scoped so it only runs when a UI test imports it.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

const { window } = dom;

// React 18's createRoot/act path checks this flag to avoid act() warnings/errors.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Copy the jsdom window onto the Node global scope so react-dom and Testing
// Library see a real DOM. Only set globals that are missing to avoid clobbering
// Node built-ins (e.g. its own setTimeout).
const g = globalThis as unknown as Record<string, unknown>;
g.window = window;
g.document = window.document;
g.navigator = window.navigator;

const COPY_KEYS = [
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "Element",
  "Node",
  "Text",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "CustomEvent",
  "getComputedStyle",
  "DocumentFragment",
  "NodeList",
  "DOMParser",
  "requestAnimationFrame",
  "cancelAnimationFrame",
];

for (const key of COPY_KEYS) {
  if (g[key] === undefined && (window as unknown as Record<string, unknown>)[key] !== undefined) {
    g[key] = (window as unknown as Record<string, unknown>)[key];
  }
}

// matchMedia is referenced by some UI libs; provide a no-op stub.
if (typeof (window as unknown as Record<string, unknown>).matchMedia !== "function") {
  (window as unknown as Record<string, unknown>).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

export { window };
