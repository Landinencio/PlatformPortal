// Feature: ai-portal-explorer — Crawler integration test with a REAL browser.
/**
 * OPTIONAL / NON-BLOCKING integration test for src/lib/explorer/crawler.ts.
 *
 * Feature: ai-portal-explorer (task 15.4)
 *
 * This test drives the real Playwright Crawler against a tiny local HTTP server
 * serving a handful of controlled pages, and asserts that a `VisitResult`
 * faithfully populates the technical + functional evidence the Explorer relies
 * on: `httpStatus`, `latencyMs`, `consoleErrors`, `failedRequests`,
 * `domErrorStates`, `dataSignal` and `screenshotRef`.
 *
 * ── Why it is ENVIRONMENT-GATED (skipped by default) ─────────────────────────
 * Playwright + a headless Chromium are NOT available in CI (nor are they a
 * dependency of the repo — they only live in the job image
 * `ops/Dockerfile.portal-explorer`). Running a browser there is neither
 * available nor desirable. So this suite is OPT-IN: it only runs when
 * `EXPLORER_E2E=1` is set in the environment (and Playwright is installed).
 * By default the gate is OFF and node:test reports every case as SKIPPED, so
 * the suite stays green without a browser.
 *
 * If `EXPLORER_E2E=1` is set but Playwright is not installed, the Crawler's
 * dynamic `import("playwright")` throws — that is acceptable for an opt-in
 * integration test.
 *
 * Determinism: the test serves fixed HTML from an in-process server on an
 * ephemeral port, uses a fake SyntheticSession and an injected
 * `screenshotUploader` that returns a canned ref (no S3), and performs a small,
 * bounded number of visits (3). Server and crawler are torn down in `finally`.
 *
 * _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_
 *
 * Run (skips cleanly, no browser needed):
 *   TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *     src/lib/explorer/__tests__/crawler.e2e.test.ts
 *
 * Run for real (requires `npm i -D playwright` + `npx playwright install chromium`):
 *   EXPLORER_E2E=1 TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *     src/lib/explorer/__tests__/crawler.e2e.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { createCrawler } from "../crawler";
import type { SyntheticSession } from "../auth-minter";
import type { Route, Scenario } from "../types";

/** Gate: skip unless explicitly enabled (Playwright + browser only on opt-in). */
const GATE_OFF = process.env.EXPLORER_E2E !== "1";

/* ------------------------------------------------------------------ */
/*  Controlled test pages                                              */
/* ------------------------------------------------------------------ */

/** A clean page with a populated table (rowCount > 0, no errors). */
const CLEAN_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Clean</title></head>
<body>
  <h1>Panel limpio</h1>
  <table><tbody>
    <tr><td>fila 1</td></tr>
    <tr><td>fila 2</td></tr>
    <tr><td>fila 3</td></tr>
  </tbody></table>
</body></html>`;

/**
 * A page that (1) emits a console.error and (2) fires a GET fetch to a 500
 * endpoint, and (3) renders a role="alert" error message. Exercises
 * consoleErrors, failedRequests and domErrorStates capture.
 */
const ERROR_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Error</title></head>
<body>
  <h1>Panel con error</h1>
  <div role="alert">Algo ha fallado al cargar los datos</div>
  <script>
    console.error("explorer-e2e: boom from console");
    fetch("/api/fail").catch(function () {});
  </script>
</body></html>`;

/** An empty-state page: HTTP 200 but "no hay datos". */
const EMPTY_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Empty</title></head>
<body>
  <h1>Panel vacío</h1>
  <p>No hay datos para el periodo seleccionado</p>
</body></html>`;

/** Starts the tiny controlled server on an ephemeral port. */
function startServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/clean")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(CLEAN_HTML);
    } else if (url.startsWith("/error")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ERROR_HTML);
    } else if (url.startsWith("/empty")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(EMPTY_HTML);
    } else if (url.startsWith("/api/fail")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "intentional 500" }));
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

function makeRoute(id: string, path: string): Route {
  return { id, kind: "ui", path, section: "metrics", paramSpec: { dateRange: false } };
}

function makeScenario(route: Route, expectsData: boolean, label: string): Scenario {
  return {
    scenarioId: `scn_${route.id}`,
    route,
    params: {},
    expectsData,
    label,
  };
}

/**
 * Fake SyntheticSession. The local server ignores cookies entirely, so any
 * value works. We use the insecure cookie name because the server is plain HTTP.
 */
const fakeSession: SyntheticSession = {
  role: "admin",
  cookieName: "next-auth.session-token",
  cookieValue: "synthetic-e2e-fake-jwe-value",
  synthetic: true,
};

/* ------------------------------------------------------------------ */
/*  Integration test (gated)                                           */
/* ------------------------------------------------------------------ */

test(
  "Crawler populates VisitResult from a real browser across clean/error/empty pages",
  { skip: GATE_OFF }, // skipped by default; only runs with EXPLORER_E2E=1
  async () => {
    const server = await startServer();

    // Track that the screenshot was captured (a buffer reached the uploader)
    // without touching S3: the injected uploader returns a canned ref.
    let screenshotUploads = 0;
    const crawler = createCrawler({
      baseUrl: server.baseUrl,
      runId: "run_e2e",
      visitTimeoutMs: 15_000,
      screenshotUploader: async (runId, scenarioId, role, buffer) => {
        assert.ok(Buffer.isBuffer(buffer), "uploader must receive a screenshot Buffer");
        assert.ok(buffer.length > 0, "screenshot buffer must be non-empty");
        screenshotUploads += 1;
        return `fake://shots/${runId}/${scenarioId}/${role}.png`;
      },
      // launchBrowser is intentionally NOT injected: this uses real Playwright.
    });

    try {
      // ── Visit 1: clean page ────────────────────────────────────────────
      const cleanRoute = makeRoute("clean-ui", "/clean");
      const cleanVisit = await crawler.visit(
        cleanRoute,
        "admin",
        makeScenario(cleanRoute, true, "clean"),
        fakeSession,
      );

      // Req 5.1: status + latency populated.
      assert.equal(cleanVisit.httpStatus, 200, "clean page returns 200");
      assert.ok(cleanVisit.latencyMs >= 0, "latencyMs must be >= 0");
      assert.equal(cleanVisit.timedOut, false);
      // Technically healthy: no console errors, no failed requests, no DOM errors.
      assert.equal(cleanVisit.consoleErrors.length, 0);
      assert.equal(cleanVisit.failedRequests.length, 0);
      assert.equal(cleanVisit.domErrorStates.length, 0);
      // Req 5.x: data signal extracted from the DOM table (3 rows, not empty).
      assert.ok(cleanVisit.dataSignal, "clean page must yield a dataSignal");
      assert.equal(cleanVisit.dataSignal!.isEmptyState, false);
      assert.equal(cleanVisit.dataSignal!.rowCount, 3, "three table rows detected");
      // Req 5.5: a screenshot was captured and a ref assigned for the UI route.
      assert.ok(cleanVisit.screenshotRef, "clean visit must have a screenshotRef");

      // ── Visit 2: error page (console error + 500 fetch + alert) ─────────
      const errorRoute = makeRoute("error-ui", "/error");
      const errorVisit = await crawler.visit(
        errorRoute,
        "admin",
        makeScenario(errorRoute, true, "error"),
        fakeSession,
      );

      assert.equal(errorVisit.httpStatus, 200, "error page itself returns 200");
      assert.ok(errorVisit.latencyMs >= 0);
      // Req 5.2: the console.error was captured.
      assert.ok(
        errorVisit.consoleErrors.some((e) => e.message.includes("boom from console")),
        "console.error must be captured",
      );
      // Req 5.3: the failing GET to /api/fail (500) was captured.
      assert.ok(
        errorVisit.failedRequests.some(
          (r) => r.url.includes("/api/fail") && r.status === 500,
        ),
        "the 500 request must be captured as a failed request",
      );
      // Req 5.4: the role="alert" message surfaced as a DOM error state.
      assert.ok(
        errorVisit.domErrorStates.some(
          (s) => s.kind === "error-message" && s.detail.includes("fallado"),
        ),
        "the alert message must be captured as a DOM error state",
      );
      assert.ok(errorVisit.screenshotRef, "error visit must have a screenshotRef");

      // ── Visit 3: empty-state page (200 OK but no data) ──────────────────
      const emptyRoute = makeRoute("empty-ui", "/empty");
      const emptyVisit = await crawler.visit(
        emptyRoute,
        "admin",
        makeScenario(emptyRoute, true, "empty"),
        fakeSession,
      );

      assert.equal(emptyVisit.httpStatus, 200, "empty page returns 200");
      assert.ok(emptyVisit.dataSignal, "empty page must yield a dataSignal");
      assert.equal(
        emptyVisit.dataSignal!.isEmptyState,
        true,
        '"no hay datos" must be detected as an empty state',
      );
      assert.ok(emptyVisit.screenshotRef, "empty visit must have a screenshotRef");

      // Req 5.5: the injected uploader was invoked once per UI visit (3).
      assert.equal(screenshotUploads, 3, "screenshotUploader invoked for each UI route");
    } finally {
      await crawler.close();
      await server.close();
    }
  },
);
