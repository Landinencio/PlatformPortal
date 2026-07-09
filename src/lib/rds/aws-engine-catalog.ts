/**
 * Catalogo_Dinamico — RDS engine catalog resolved dynamically from AWS.
 *
 * Replaces the hand-maintained `src/lib/rds/version-catalog.ts` by describing
 * available RDS engine versions and their DBParameterGroupFamily via
 * `rds:DescribeDBEngineVersions`. The Formulario_V2 and the Generador_RDS both
 * consume this module during the ventana de convivencia; the static catalog
 * remains as a Fallback_Catalogo semilla until the metric declared in the
 * design is green for 7 continuous days (Requirement 10.3).
 *
 * Credentials resolution: IRSA directa desde `portal-inventory-irsa` — no
 * AssumeRole hop is performed here. The policy `PortalRdsCatalogReadOnly`
 * grants read-only access to `rds:DescribeDBEngineVersions`, whose IAM shape
 * does not allow ARN scoping (documented in the design § IAM justification).
 * The AWS SDK v3 client is imported at the top-level so the Next.js
 * `standalone` output packages it correctly (portal-architecture §10 gotcha #5).
 *
 * Caching model:
 *   - Fresh 24h cache via `src/lib/cache.ts` prefix `rds-catalog:` (Req 1.5, 1.6).
 *     A hit inside the TTL window skips the AWS call entirely.
 *   - Module-local `staleStore` retains the last successful response
 *     indefinitely (updated on every AWS success). It powers the
 *     Fallback_Catalogo path when AWS fails or exceeds the 8s timeout after
 *     the fresh cache has expired (Req 1.7). Retention survives beyond the
 *     24h TTL of the fresh cache, so the Formulario_V2 remains usable during
 *     extended AWS outages.
 *
 * Error semantics:
 *   - `engine_not_supported` — engine ∉ `ENABLED_ENGINES` (Req 1.11).
 *   - `catalog_unavailable`  — AWS failed and no prior cache exists (Req 1.8).
 *   - `credentials_unavailable` — IRSA/STS could not be resolved (Req 8.6).
 *     No AssumeRole fallback is attempted and no ARNs, tokens or STS bodies
 *     are logged.
 *
 * The module deliberately whitelists the fields returned to callers to
 * `version`, `family`, `deprecated` and `defaultForEngine` (Req 8.5); every
 * other field of the AWS payload (Engine, MajorEngineVersion,
 * DBEngineVersionArn, ValidUpgradeTarget, SupportedEngineModes, …) is
 * discarded before serialization.
 */

import {
  RDSClient,
  DescribeDBEngineVersionsCommand,
  type DBEngineVersion,
} from "@aws-sdk/client-rds";
import { cached, invalidateCache } from "@/lib/cache";
import { InfraLogger } from "@/lib/logger";

// ─── Public constants ────────────────────────────────────────────────────────

/** Fresh cache TTL: 24h in milliseconds (Req 1.5). */
export const CATALOG_TTL_MS = 86_400_000;

/** Timeout applied to the whole `rds:DescribeDBEngineVersions` invocation (Req 1.7). */
export const AWS_CALL_TIMEOUT_MS = 8_000;

/**
 * Engines the portal is willing to expose. Extending this list is the only
 * required change to add new engines (Req 1.11 explicitly documents this
 * property). No lookup/parse logic depends on the concrete values.
 */
export const ENABLED_ENGINES: ReadonlyArray<string> = ["postgres"] as const;

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Whitelisted shape returned to the caller. Includes the four canonical fields
 * plus the optional `stale`/`staleSince` pair emitted only through the
 * Fallback_Catalogo path (Req 1.7). Fresh responses never carry these two
 * fields, so JSON round-trip serialization to the client omits them.
 */
export interface EngineOption {
  /** Engine version literal returned by AWS, e.g. `"15.4"`. */
  version: string;
  /** Parameter-group family literal (never derived by concatenation) — Req 1.3. */
  family: string;
  /** `true` when AWS marks the version with `Status = "deprecated"` — Req 1.4. */
  deprecated: boolean;
  /** Marks the deterministic default surfaced by the Formulario_V2. */
  defaultForEngine: boolean;
  /** Present only when the response is served from the Fallback_Catalogo. */
  stale?: true;
  /** ISO 8601 UTC timestamp of the last successful response, when `stale = true`. */
  staleSince?: string;
}

export type CatalogErrorCode =
  | "catalog_unavailable"
  | "engine_not_supported"
  | "credentials_unavailable";

export interface CatalogError {
  code: CatalogErrorCode;
  engine?: string;
  region?: string;
}

export type CatalogResult =
  | { ok: true; options: EngineOption[] }
  | { ok: false; error: CatalogError };

// ─── Internal state ──────────────────────────────────────────────────────────

interface CachedCatalog {
  options: EngineOption[];
  cachedAt: number; // epoch ms
}

/**
 * Module-local retention of the last successful response per `(engine, region)`.
 * Updated inside the compute function of `cached()` so it stays in lockstep
 * with the fresh cache but persists beyond its 24h TTL. Feeds the
 * Fallback_Catalogo path in Req 1.7 without requiring changes to `cache.ts`.
 */
const staleStore = new Map<string, CachedCatalog>();

/**
 * Minimal shape of an RDS client this module talks to. The concrete
 * `RDSClient` from `@aws-sdk/client-rds` is structurally compatible; the
 * interface lets test seams substitute a lightweight mock without dragging
 * the full AWS SDK types into tests.
 */
interface RdsCatalogClient {
  send(
    command: DescribeDBEngineVersionsCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ DBEngineVersions?: DBEngineVersion[]; Marker?: string }>;
}

/** Region-scoped RDS client cache. Credentials come from the ambient chain (IRSA). */
let cachedClient: RdsCatalogClient | null = null;
let cachedClientRegion: string | null = null;

// ─── Test seams (not for production use) ─────────────────────────────────────
//
// These hooks let property tests substitute the AWS client and the clock and
// reset the module-local caches. They intentionally live on the module so
// tests do not need to shim `@aws-sdk/client-rds` at the loader level. All
// four helpers are no-ops in production (nothing calls them from application
// code).

let testClientFactory: ((region: string) => RdsCatalogClient) | null = null;
let testClock: (() => number) | null = null;

/**
 * Replace the internal RDS client factory. Pass `null` to restore the real
 * `RDSClient`. The setter also drops the cached client so the next call
 * re-fetches from the factory.
 */
export function __setTestClientFactoryForTests(
  fn: ((region: string) => RdsCatalogClient) | null,
): void {
  testClientFactory = fn;
  cachedClient = null;
  cachedClientRegion = null;
}

/** Override the internal clock (`Date.now()`). Pass `null` to restore. */
export function __setTestClockForTests(fn: (() => number) | null): void {
  testClock = fn;
}

/**
 * Clear both the fresh cache (via `invalidateCache("rds-catalog")`) and the
 * stale store, and drop any cached client. Use at the start of each test
 * iteration to guarantee a clean slate.
 */
export function __resetTestCacheForTests(): void {
  staleStore.clear();
  cachedClient = null;
  cachedClientRegion = null;
  invalidateCache("rds-catalog");
}

/**
 * Clear ONLY the fresh 24h cache while preserving the stale store. Lets the
 * property test drive Req 1.7 (fallback after AWS failure with a prior
 * successful response still retained in the stale store).
 */
export function __expireFreshCacheForTests(): void {
  invalidateCache("rds-catalog");
}

function now(): number {
  return testClock ? testClock() : Date.now();
}

function rdsClientFor(region: string): RdsCatalogClient {
  if (testClientFactory) return testClientFactory(region);
  if (cachedClient && cachedClientRegion === region) return cachedClient;
  cachedClient = new RDSClient({ region });
  cachedClientRegion = region;
  return cachedClient;
}

function cacheKeyFor(engine: string, region: string): string {
  return `rds-catalog:${engine}:${region}`;
}

// ─── Error classification helpers ────────────────────────────────────────────

/**
 * Error names emitted by `@aws-sdk/client-sts` and `@smithy/*` credential
 * providers when IRSA/STS resolution fails. Kept small and specific so a
 * generic AWS API failure never gets misclassified as `credentials_unavailable`.
 */
const CREDENTIALS_ERROR_NAMES: ReadonlySet<string> = new Set([
  "CredentialsProviderError",
  "NoCredentialProviders",
  "ExpiredToken",
  "ExpiredTokenException",
  "InvalidClientTokenId",
  "UnrecognizedClientException",
  "InvalidIdentityToken",
  "InvalidIdentityTokenException",
  "AccessDenied",
  "AccessDeniedException",
  "SignatureDoesNotMatch",
]);

/**
 * `true` when the error signals a credentials/IRSA/STS resolution failure
 * (Req 8.6). Detection is name-based first, message-based as a last resort.
 * We never inspect nested response bodies to avoid accidentally logging
 * tokens or role ARNs downstream.
 */
function isCredentialsError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; Code?: unknown; message?: unknown };
  const name = typeof e.name === "string" ? e.name : "";
  const code = typeof e.Code === "string" ? e.Code : "";
  if (CREDENTIALS_ERROR_NAMES.has(name) || CREDENTIALS_ERROR_NAMES.has(code)) return true;
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (
    message.includes("credentials") &&
    (message.includes("could not") ||
      message.includes("not found") ||
      message.includes("expired") ||
      message.includes("unable to load"))
  ) {
    return true;
  }
  if (message.includes("web identity") && message.includes("token")) return true;
  return false;
}

/** Bounded, non-sensitive label safe to include in logs (Req 8.6). */
function safeErrorName(err: unknown): string {
  if (err && typeof err === "object") {
    const n = (err as { name?: unknown }).name;
    if (typeof n === "string" && n.length > 0 && n.length < 100) return n;
  }
  return "Error";
}

// ─── AWS payload → whitelisted portal shape ──────────────────────────────────

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = Number.isFinite(pa[i]) ? pa[i] : 0;
    const bi = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

/**
 * Whitelist filter (Req 8.5). Keeps only `version`, `family`, `deprecated`
 * and `defaultForEngine`; every other field on `DBEngineVersion` is
 * discarded. Rows without `EngineVersion` or `DBParameterGroupFamily` are
 * dropped rather than surfaced with empty strings.
 *
 * Default selection is deterministic: the highest non-deprecated semver
 * version wins; if every option is deprecated the highest overall wins.
 */
function toEngineOptions(raw: readonly DBEngineVersion[]): EngineOption[] {
  const filtered: EngineOption[] = [];
  for (const v of raw) {
    const version = typeof v.EngineVersion === "string" ? v.EngineVersion : "";
    const family = typeof v.DBParameterGroupFamily === "string" ? v.DBParameterGroupFamily : "";
    if (!version || !family) continue;
    const status = typeof v.Status === "string" ? v.Status.toLowerCase() : "";
    // AWS marks retired versions with Status = "deprecated". Any other value
    // (including "available" and future statuses) surfaces as non-deprecated
    // so the Formulario_V2 does not accidentally hide currently valid entries.
    filtered.push({
      version,
      family,
      deprecated: status === "deprecated",
      defaultForEngine: false,
    });
  }

  const available = filtered.filter((v) => !v.deprecated);
  const pool = available.length > 0 ? available : filtered;
  const sorted = [...pool].sort((a, b) => compareSemver(b.version, a.version));
  const defaultVersion = sorted[0]?.version ?? null;
  if (defaultVersion !== null) {
    for (const opt of filtered) {
      if (opt.version === defaultVersion) {
        opt.defaultForEngine = true;
        break;
      }
    }
  }
  return filtered;
}

// ─── AWS I/O with timeout ────────────────────────────────────────────────────

async function fetchEngineOptionsFromAws(
  engine: string,
  region: string,
): Promise<EngineOption[]> {
  const client = rdsClientFor(region);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AWS_CALL_TIMEOUT_MS);
  try {
    const raw: DBEngineVersion[] = [];
    let marker: string | undefined;
    do {
      const resp = await client.send(
        new DescribeDBEngineVersionsCommand({ Engine: engine, Marker: marker }),
        { abortSignal: controller.signal },
      );
      if (Array.isArray(resp.DBEngineVersions)) raw.push(...resp.DBEngineVersions);
      marker = typeof resp.Marker === "string" && resp.Marker.length > 0 ? resp.Marker : undefined;
    } while (marker);
    return toEngineOptions(raw);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve the whitelisted RDS engine options for `(engine, region)`.
 *
 * Never throws: every failure is captured as a `CatalogResult` with `ok=false`.
 *
 * Outcomes (also emitted in the InfraLogger metadata):
 * - `hit`   — Fresh cache within 24h (Req 1.6). No AWS call.
 * - `miss`  — AWS call succeeded; cache and staleStore updated.
 * - `stale` — AWS failed (error or 8s timeout) but staleStore has a prior
 *             response; result carries `stale: true, staleSince` (Req 1.7).
 * - `error` — Either `engine_not_supported`, `credentials_unavailable`
 *             (Req 8.6) or `catalog_unavailable` when AWS fails without a
 *             prior cache (Req 1.8).
 */
export async function listRdsEngineOptions(
  engine: string,
  region: string,
): Promise<CatalogResult> {
  const startedAt = now();
  const logger = new InfraLogger("aws-engine-catalog", "system");

  // Req 1.11: reject unsupported engines synchronously, without touching AWS.
  if (!ENABLED_ENGINES.includes(engine)) {
    logger.warn("engine not supported", {
      engine,
      region,
      outcome: "error",
      code: "engine_not_supported",
      latencyMs: now() - startedAt,
    });
    return { ok: false, error: { code: "engine_not_supported", engine } };
  }

  const key = cacheKeyFor(engine, region);
  let didFetch = false;
  try {
    const entry = await cached<CachedCatalog>(
      key,
      async () => {
        didFetch = true;
        const options = await fetchEngineOptionsFromAws(engine, region);
        const cachedAt = now();
        // Retain last successful response indefinitely so Req 1.7's stale
        // fallback survives after the 24h fresh TTL expires.
        staleStore.set(key, { options, cachedAt });
        return { options, cachedAt };
      },
      CATALOG_TTL_MS,
    );
    logger.info(didFetch ? "catalog miss" : "catalog hit", {
      engine,
      region,
      outcome: didFetch ? "miss" : "hit",
      latencyMs: now() - startedAt,
    });
    return { ok: true, options: entry.options.map((o) => ({ ...o })) };
  } catch (err) {
    // Req 8.6: credentials failures never fall back to stale cache; the
    // caller must be told the identity chain is broken so it can decide.
    if (isCredentialsError(err)) {
      logger.error("credentials unavailable", {
        engine,
        region,
        outcome: "error",
        code: "credentials_unavailable",
        errorName: safeErrorName(err),
        latencyMs: now() - startedAt,
      });
      return { ok: false, error: { code: "credentials_unavailable" } };
    }

    const priorEntry = staleStore.get(key);
    if (priorEntry) {
      const staleSince = new Date(priorEntry.cachedAt).toISOString();
      logger.warn("catalog stale", {
        engine,
        region,
        outcome: "stale",
        staleSince,
        errorName: safeErrorName(err),
        latencyMs: now() - startedAt,
      });
      return {
        ok: true,
        options: priorEntry.options.map((o) => ({
          ...o,
          stale: true as const,
          staleSince,
        })),
      };
    }

    logger.error("catalog unavailable", {
      engine,
      region,
      outcome: "error",
      code: "catalog_unavailable",
      errorName: safeErrorName(err),
      latencyMs: now() - startedAt,
    });
    return { ok: false, error: { code: "catalog_unavailable", engine, region } };
  }
}
