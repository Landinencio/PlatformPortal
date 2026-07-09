/**
 * AI Portal Explorer — test-support polyfill for the Fetch API globals.
 *
 * Feature: ai-portal-explorer
 *
 * Importing `next/server` (for `NextResponse`, used by `requireInternalAuth` and
 * by the `POST /api/explorer/run` route handler) evaluates Next's request spec
 * extension, which references `Request`/`Response`/`Headers`/`fetch` as globals
 * at module-load time. In Node 16 (the runtime of these tests — see
 * `web-streams-polyfill.ts`) those Fetch API globals do NOT exist yet (they are
 * global from Node 18). This module installs them from the implementation Next
 * already vendors (`@edge-runtime/primitives`) so the `import` of `next/server`
 * does not throw `Request is not defined`.
 *
 * Must be imported BEFORE any module that loads `next/server`. ES imports are
 * evaluated in order, so place it as the FIRST import of the test (together with
 * the web-streams polyfill, which the AWS SDK needs).
 *
 * On Node 18+ the assignments are skipped (the globals already exist), so this
 * file is harmless across runtimes.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const g = globalThis as unknown as Record<string, unknown>;

if (
  typeof g.Request === "undefined" ||
  typeof g.Response === "undefined" ||
  typeof g.Headers === "undefined" ||
  typeof g.fetch === "undefined"
) {
  // Next vendors a complete Fetch API implementation under this path.
  const primitives = require("next/dist/compiled/@edge-runtime/primitives");
  if (typeof g.Request === "undefined") g.Request = primitives.Request;
  if (typeof g.Response === "undefined") g.Response = primitives.Response;
  if (typeof g.Headers === "undefined") g.Headers = primitives.Headers;
  if (typeof g.fetch === "undefined") g.fetch = primitives.fetch;
}
