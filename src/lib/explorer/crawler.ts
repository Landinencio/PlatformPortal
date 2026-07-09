/**
 * AI Portal Explorer — Crawler (Playwright headless).
 *
 * Feature: ai-portal-explorer
 *
 * Visita cada Route bajo una Synthetic_Session y captura evidencia técnica y
 * funcional, de forma ESTRICTAMENTE de solo lectura:
 *
 *  - Interceptación de red a nivel de transporte: `page.route('**\/*')` aborta
 *    cualquier petición cuyo método no sea GET/HEAD. Es la barrera innegociable
 *    de solo lectura (Req 1.5, 1.6); cada petición pasa por `evaluateInteraction`
 *    del Safety_Guard.
 *  - Captura de `consoleErrors`, `failedRequests` (requestfailed + respuestas
 *    4xx/5xx), `domErrorStates` (best-effort), `latencyMs`, `httpStatus` de la
 *    respuesta principal y un `Screenshot` (Req 5.1–5.5).
 *  - Extracción best-effort de `DataSignal` desde el DOM (UI) o el JSON (API)
 *    para alimentar las heurísticas funcionales.
 *  - Lectura de formularios SIN envío (Req 1.7): el Crawler nunca hace submit;
 *    el guard de transporte además bloquea cualquier POST/PUT/PATCH/DELETE.
 *  - Timeout por-visita configurable: al superarlo marca `timedOut = true`
 *    (la Anomaly `timeout` la produce `detectTimeoutAnomaly` aguas abajo, Req 10.6).
 *
 * ── Dependencia de Playwright ────────────────────────────────────────────────
 * Playwright NO es una dependencia del repositorio: es un runtime de navegador
 * pesado que solo necesita la imagen del job (`ops/Dockerfile.portal-explorer`,
 * tarea 15.3). Para que el resto del Explorer (módulos puros + sus tests)
 * compile y se ejecute sin navegador, este módulo:
 *   1. Importa Playwright mediante un `import()` dinámico con un especificador
 *      en variable, de modo que TypeScript no intente resolver el módulo en
 *      tiempo de compilación (no rompe `get_diagnostics`/`tsc`).
 *   2. Define interfaces estructurales mínimas (`Pw*`) para los objetos de
 *      Playwright que usa, sin importar sus tipos.
 *   3. Acepta un `launchBrowser` inyectable, de modo que los tests puedan
 *      proveer un navegador falso sin Playwright instalado.
 *
 * Nota: esto contradice deliberadamente la regla general de "imports top-level"
 * del AWS SDK (Next standalone), porque el Crawler NO corre dentro del bundle de
 * Next sino dentro de la imagen del job, que sí trae Chromium/Playwright.
 *
 * _Requirements: 1.5, 1.6, 1.7, 5.1, 5.2, 5.3, 5.4, 5.5, 10.6_
 */

import type { AppRole } from "@/lib/rbac";
import type { SyntheticSession } from "./auth-minter";
import { evaluateInteraction, isSafeMethod } from "./safety-guard";
import type {
  ConsoleError,
  DataSignal,
  DomErrorState,
  FailedRequest,
  Route,
  Scenario,
  VisitResult,
} from "./types";

/** Timeout por-visita por defecto (ms). Configurable por `CrawlerConfig`. */
export const DEFAULT_VISIT_TIMEOUT_MS = 30_000;

// ─── Interfaces estructurales mínimas de Playwright ──────────────────────────
// No importamos los tipos de `playwright`; describimos solo lo que usamos para
// que el módulo compile aunque el paquete no esté instalado.

interface PwRequest {
  method(): string;
  url(): string;
}

interface PwResponse {
  status(): number;
  url(): string;
  request(): PwRequest;
  text(): Promise<string>;
}

interface PwConsoleMessage {
  type(): string;
  text(): string;
}

interface PwRoute {
  request(): PwRequest;
  continue(): Promise<void>;
  abort(): Promise<void>;
}

interface PwPage {
  on(event: "console", handler: (msg: PwConsoleMessage) => void): void;
  on(event: "pageerror", handler: (err: Error) => void): void;
  on(event: "requestfailed", handler: (req: PwRequest) => void): void;
  on(event: "response", handler: (resp: PwResponse) => void): void;
  route(pattern: string, handler: (route: PwRoute) => void | Promise<void>): Promise<void>;
  goto(url: string, opts?: Record<string, unknown>): Promise<PwResponse | null>;
  waitForLoadState(state?: string, opts?: Record<string, unknown>): Promise<void>;
  screenshot(opts?: Record<string, unknown>): Promise<Buffer>;
  evaluate<T>(fn: string): Promise<T>;
  close(): Promise<void>;
}

interface PwCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "Strict" | "None";
}

interface PwContext {
  addCookies(cookies: PwCookie[]): Promise<void>;
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}

interface PwBrowser {
  newContext(opts?: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}

/** Lanza (o provee) un navegador. Inyectable para test sin Playwright. */
export type BrowserLauncher = () => Promise<PwBrowser>;

/**
 * Sube un Screenshot a almacenamiento externo (S3) y devuelve su referencia
 * (p.ej. `s3://...`). Inyectable; si no se provee, el Screenshot no se persiste
 * y `screenshotRef` queda a `null` (Req 5.5: la referencia se asocia cuando hay
 * almacenamiento disponible).
 */
export type ScreenshotUploader = (
  runId: string,
  scenarioId: string,
  role: AppRole,
  screenshot: Buffer,
) => Promise<string>;

/** Configuración del Crawler para un Exploration_Run. */
export interface CrawlerConfig {
  /** Base URL del Target_Environment (portal-dev). */
  baseUrl: string;
  /** Identificador del Exploration_Run en curso. */
  runId: string;
  /** Timeout por-visita (ms). Por defecto {@link DEFAULT_VISIT_TIMEOUT_MS}. */
  visitTimeoutMs?: number;
  /** Subidor de Screenshots inyectable (caller sube a S3). */
  screenshotUploader?: ScreenshotUploader;
  /** Lanzador de navegador inyectable (test/override). Por defecto Playwright. */
  launchBrowser?: BrowserLauncher;
}

/** Crawler reutilizable por el orquestador: lanza el navegador una vez. */
export interface Crawler {
  /** Visita un Scenario con un Role, devolviendo un Visit_Result. */
  visit(
    route: Route,
    role: AppRole,
    scenario: Scenario,
    session: SyntheticSession,
  ): Promise<VisitResult>;
  /** Cierra el navegador y libera recursos. Idempotente. */
  close(): Promise<void>;
}

/**
 * Lanzador por defecto: importa Playwright dinámicamente (especificador en
 * variable para no romper la compilación si el paquete no está instalado) y
 * lanza Chromium headless. Solo se ejecuta dentro de la imagen del job.
 */
async function defaultLaunchBrowser(): Promise<PwBrowser> {
  // El especificador en variable evita que TypeScript resuelva el módulo en
  // tiempo de compilación (Playwright solo existe en la imagen del job).
  const moduleName = "playwright";
  const mod = (await import(/* webpackIgnore: true */ moduleName)) as unknown as {
    chromium: { launch(opts?: Record<string, unknown>): Promise<PwBrowser> };
  };
  return mod.chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

/** True si el error parece un timeout de navegación de Playwright. */
function isTimeoutError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string }).name ?? "";
  const message = (err as { message?: string }).message ?? "";
  return name === "TimeoutError" || /timeout/i.test(message);
}

/** Construye la URL absoluta de un Scenario (path + params como query string). */
function buildVisitUrl(baseUrl: string, route: Route, params: Record<string, string>): string {
  const target = new URL(route.path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }
  return target.toString();
}

/**
 * Cookie de Playwright para la Synthetic_Session. Las cookies con prefijo
 * `__Secure-` exigen `secure: true`; lo derivamos del host (https en portal-dev).
 */
function buildSessionCookie(session: SyntheticSession, baseUrl: string): PwCookie {
  const host = new URL(baseUrl).hostname;
  const secure = session.cookieName.startsWith("__Secure-") || new URL(baseUrl).protocol === "https:";
  return {
    name: session.cookieName,
    value: session.cookieValue,
    domain: host,
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "Lax",
  };
}

/**
 * Script in-browser (string) que extrae una señal de datos best-effort del DOM
 * para rutas de UI. Se pasa como string a `page.evaluate` para no depender del
 * bundling del navegador. Devuelve un subconjunto serializable de DataSignal.
 */
const DOM_DATA_SIGNAL_SCRIPT = `(() => {
  const body = document.body;
  const text = body ? (body.innerText || "") : "";
  const lower = text.toLowerCase();
  const emptyPatterns = [
    "no hay datos", "sin datos", "no data", "no results", "sin resultados",
    "ningún resultado", "no se encontraron", "nada que mostrar", "empty"
  ];
  const isEmptyState = emptyPatterns.some((p) => lower.includes(p));

  let rowCount = null;
  const rows = document.querySelectorAll("table tbody tr");
  if (rows.length > 0) {
    rowCount = rows.length;
  } else {
    const items = document.querySelectorAll('[role="row"], [role="listitem"]');
    if (items.length > 0) rowCount = items.length;
  }

  let pagination = null;
  const controls = Array.from(document.querySelectorAll("button, a"));
  const next = controls.find((el) => {
    const label = ((el.textContent || "") + " " + (el.getAttribute("aria-label") || "")).toLowerCase();
    return /next|siguiente|›|»/.test(label);
  });
  if (next) {
    const disabled = next.hasAttribute("disabled") || next.getAttribute("aria-disabled") === "true";
    pagination = { pageIndex: 0, hasNextControl: !disabled, pageItemSignature: "" };
  }

  return { isEmptyState, rowCount, pagination, bodyLength: text.trim().length };
})()`;

/**
 * Script in-browser (string) que detecta DOM_Error_States best-effort:
 * páginas en blanco y mensajes de error (`role="alert"`). El empty-state NO se
 * clasifica aquí como error (lo decide `detectEmptyStateAnomaly` según el
 * Scenario), para no marcar como error toda página legítimamente vacía.
 */
const DOM_ERROR_STATES_SCRIPT = `(() => {
  const states = [];
  const body = document.body;
  const text = body ? (body.innerText || "").trim() : "";
  if (text.length === 0) {
    states.push({ kind: "blank-page", detail: "el cuerpo del documento está vacío" });
  }
  const alerts = document.querySelectorAll('[role="alert"]');
  alerts.forEach((el) => {
    const detail = (el.textContent || "").trim();
    if (detail) states.push({ kind: "error-message", detail: detail.slice(0, 200) });
  });
  return states;
})()`;

/** Patrones de texto que indican acceso denegado (RBAC) en una página de UI. */
const DENIED_TEXT = /(acceso denegado|no autorizado|unauthorized|forbidden|403|sin permisos|no tienes permiso)/i;

/** Extrae una DataSignal best-effort del cuerpo JSON de una respuesta API. */
function extractApiDataSignal(body: string): DataSignal {
  const totals: Record<string, number> = {};
  let rowCount: number | null = null;
  let isEmptyState = false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Respuesta no-JSON: empty-state si el cuerpo está vacío.
    return { isEmptyState: body.trim().length === 0, rowCount: null, timeSeries: null, pagination: null, totals };
  }

  if (Array.isArray(parsed)) {
    rowCount = parsed.length;
    isEmptyState = parsed.length === 0;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    // Busca el primer array bajo claves habituales para el rowCount.
    for (const key of ["data", "items", "rows", "results", "monitors", "events", "records"]) {
      const value = obj[key];
      if (Array.isArray(value)) {
        rowCount = value.length;
        isEmptyState = value.length === 0;
        break;
      }
    }
    // Totales nombrados de primer nivel (KPIs numéricos).
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        totals[key] = value;
      }
    }
  }

  return { isEmptyState, rowCount, timeSeries: null, pagination: null, totals };
}

/** Determina el acceso observado a partir del status y el contenido. (Req 3.2) */
function determineAccess(
  httpStatus: number | null,
  domText: string | null,
): "granted" | "denied" {
  if (httpStatus === 401 || httpStatus === 403) return "denied";
  if (domText && DENIED_TEXT.test(domText)) return "denied";
  return "granted";
}

/**
 * Crea un Crawler reutilizable. El navegador se lanza de forma perezosa en la
 * primera Visit y se reutiliza para todas; cada Visit usa su propio contexto
 * (cookies aisladas por Role) que se cierra al terminar.
 */
export function createCrawler(config: CrawlerConfig): Crawler {
  const launch = config.launchBrowser ?? defaultLaunchBrowser;
  const visitTimeoutMs = config.visitTimeoutMs ?? DEFAULT_VISIT_TIMEOUT_MS;
  let browser: PwBrowser | null = null;

  async function ensureBrowser(): Promise<PwBrowser> {
    if (!browser) {
      browser = await launch();
    }
    return browser;
  }

  async function visit(
    route: Route,
    role: AppRole,
    scenario: Scenario,
    session: SyntheticSession,
  ): Promise<VisitResult> {
    const consoleErrors: ConsoleError[] = [];
    const failedRequests: FailedRequest[] = [];
    const domErrorStates: DomErrorState[] = [];
    const abortedRequests = new Set<PwRequest>();

    const result: VisitResult = {
      runId: config.runId,
      scenarioId: scenario.scenarioId,
      route,
      role,
      params: scenario.params,
      httpStatus: null,
      latencyMs: 0,
      timedOut: false,
      consoleErrors,
      failedRequests,
      domErrorStates,
      dataSignal: null,
      screenshotRef: null,
      accessObserved: "granted",
    };

    const url = buildVisitUrl(config.baseUrl, route, scenario.params);
    const isApi = route.kind === "api";

    const pwBrowser = await ensureBrowser();
    const context = await pwBrowser.newContext({ ignoreHTTPSErrors: true });
    let page: PwPage | null = null;

    try {
      // Adjunta la Synthetic_Session del Role activo (Req 2.3).
      await context.addCookies([buildSessionCookie(session, config.baseUrl)]);
      page = await context.newPage();

      // ── Barrera de solo lectura a nivel de transporte (Req 1.5, 1.6) ──────
      // Cada petición pasa por evaluateInteraction; solo GET/HEAD continúa,
      // el resto se aborta antes de salir a la red.
      await page.route("**/*", async (pwRoute) => {
        const request = pwRoute.request();
        const method = request.method();
        const decision = evaluateInteraction({ kind: "http", httpMethod: method });
        if (decision.allowed && isSafeMethod(method)) {
          await pwRoute.continue();
        } else {
          abortedRequests.add(request);
          await pwRoute.abort();
        }
      });

      // ── Captura de evidencia técnica (Req 5.2, 5.3) ───────────────────────
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push({ message: msg.text() });
      });
      page.on("pageerror", (err) => {
        domErrorStates.push({
          kind: "render-exception",
          detail: String(err?.message ?? err).slice(0, 300),
        });
      });
      page.on("requestfailed", (req) => {
        // Ignora las peticiones que abortamos nosotros por seguridad: no son
        // fallos reales del portal.
        if (abortedRequests.has(req)) return;
        failedRequests.push({ url: req.url(), method: req.method(), status: null });
      });
      page.on("response", (resp) => {
        const status = resp.status();
        if (status >= 400) {
          failedRequests.push({ url: resp.url(), method: resp.request().method(), status });
        }
      });

      // ── Navegación con timeout por-visita (Req 5.1, 10.6) ─────────────────
      const start = Date.now();
      let response: PwResponse | null = null;
      try {
        response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: visitTimeoutMs,
        });
        // Espera best-effort a estabilizar la red; un timeout aquí no marca la
        // Visit como timeout (la carga principal ya respondió).
        const elapsed = Date.now() - start;
        const remaining = Math.max(500, visitTimeoutMs - elapsed);
        try {
          await page.waitForLoadState("networkidle", { timeout: remaining });
        } catch {
          /* networkidle no alcanzado: continuamos con lo capturado */
        }
      } catch (err) {
        if (isTimeoutError(err)) {
          result.timedOut = true;
        } else {
          // Fallo de navegación no-timeout (p.ej. error de red): se registra
          // como estado de error del DOM y se continúa capturando evidencia.
          domErrorStates.push({
            kind: "render-exception",
            detail: `fallo de navegación: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
          });
        }
      }
      result.latencyMs = Date.now() - start;
      result.httpStatus = response ? response.status() : null;

      // ── Extracción de DataSignal + DOM error states ───────────────────────
      if (isApi) {
        // Rutas API: la señal de datos se extrae del cuerpo JSON; sin screenshot.
        let body = "";
        if (response) {
          try {
            body = await response.text();
          } catch {
            body = "";
          }
        }
        result.dataSignal = extractApiDataSignal(body);
        result.accessObserved = determineAccess(result.httpStatus, body);
      } else {
        // Rutas UI: señal de datos + DOM error states best-effort desde el DOM.
        let domText: string | null = null;
        try {
          const dom = await page.evaluate<{
            isEmptyState: boolean;
            rowCount: number | null;
            pagination: DataSignal["pagination"];
            bodyLength: number;
          }>(DOM_DATA_SIGNAL_SCRIPT);
          result.dataSignal = {
            isEmptyState: dom.isEmptyState,
            rowCount: dom.rowCount,
            timeSeries: null,
            pagination: dom.pagination,
            totals: {},
          };
        } catch {
          /* página no evaluable: dataSignal queda null */
        }
        try {
          const states = await page.evaluate<DomErrorState[]>(DOM_ERROR_STATES_SCRIPT);
          for (const state of states) domErrorStates.push(state);
        } catch {
          /* DOM no evaluable */
        }
        try {
          domText = await page.evaluate<string>(
            "(() => (document.body ? document.body.innerText : ''))()",
          );
        } catch {
          domText = null;
        }
        result.accessObserved = determineAccess(result.httpStatus, domText);

        // ── Screenshot (Req 5.5) ────────────────────────────────────────────
        try {
          const buffer = await page.screenshot({ fullPage: true });
          if (config.screenshotUploader) {
            result.screenshotRef = await config.screenshotUploader(
              config.runId,
              scenario.scenarioId,
              role,
              buffer,
            );
          }
        } catch {
          /* el screenshot es best-effort: un fallo no invalida la Visit */
        }
      }
    } finally {
      if (page) {
        try {
          await page.close();
        } catch {
          /* noop */
        }
      }
      try {
        await context.close();
      } catch {
        /* noop */
      }
    }

    return result;
  }

  async function close(): Promise<void> {
    if (browser) {
      const current = browser;
      browser = null;
      try {
        await current.close();
      } catch {
        /* noop */
      }
    }
  }

  return { visit, close };
}
