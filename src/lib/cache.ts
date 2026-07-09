/**
 * Simple in-memory cache with TTL expiration.
 *
 * Designed for single-pod deployments where Redis is overkill.
 * Caches expensive DB queries (DORA dashboard, SonarQube, etc.)
 * to avoid redundant computation when the executive dashboard
 * fires 5 parallel API calls that all hit the same underlying query.
 *
 * Default TTL: 5 minutes (snapshots are daily, so data is not volatile).
 */

/**
 * Standard cache key prefixes for selective invalidation.
 *
 * Each prefix corresponds to a data domain. After a snapshot phase completes,
 * only the relevant prefix is invalidated so unrelated cached data remains warm.
 *
 * - `dora`        — DORA metrics (deployment frequency, lead time, CFR, recovery time)
 * - `sonar`       — SonarQube quality metrics (coverage, bugs, code smells)
 * - `k8s`         — Kubernetes workload metrics from Prometheus/Grafana
 * - `correlation` — Deployment correlation data (GitLab ↔ ArgoCD mapping)
 * - `executive`   — Aggregated executive summary responses
 */
export const CACHE_PREFIXES = {
  /** DORA metrics: deployment frequency, lead time, CFR, pipeline recovery time */
  dora: "dora",
  /** SonarQube quality metrics: coverage, bugs, vulnerabilities, code smells */
  sonar: "sonar",
  /** Kubernetes workload metrics from Prometheus/Grafana */
  k8s: "k8s",
  /** Deployment correlation: GitLab pipeline ↔ ArgoCD sync mapping */
  correlation: "correlation",
  /** Aggregated executive summary (combines multiple data domains) */
  executive: "executive",
} as const;

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 200;

const store = new Map<string, CacheEntry<unknown>>();

/**
 * Build a deterministic cache key from a prefix and filter params.
 */
export function cacheKey(prefix: string, params: Record<string, unknown>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => {
      const v = params[k];
      if (Array.isArray(v)) return `${k}=${[...v].sort().join(",")}`;
      return `${k}=${v}`;
    })
    .join("&");
  return `${prefix}:${sorted}`;
}

/**
 * Get a cached value, or compute it if missing/expired.
 */
export async function cached<T>(
  key: string,
  compute: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<T> {
  const now = Date.now();
  const existing = store.get(key) as CacheEntry<T> | undefined;

  if (existing && existing.expiresAt > now) {
    return existing.value;
  }

  const value = await compute();

  // Evict oldest entries if we're at capacity
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }

  store.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

/**
 * Invalidate a specific cache entry or all entries matching a prefix.
 */
export function invalidateCache(keyOrPrefix?: string): void {
  if (!keyOrPrefix) {
    store.clear();
    return;
  }

  for (const key of store.keys()) {
    if (key === keyOrPrefix || key.startsWith(`${keyOrPrefix}:`)) {
      store.delete(key);
    }
  }
}

/**
 * Get cache stats for debugging.
 */
export function cacheStats(): { size: number; maxEntries: number; defaultTtlMs: number } {
  return { size: store.size, maxEntries: MAX_ENTRIES, defaultTtlMs: DEFAULT_TTL_MS };
}

/**
 * Set a cache entry directly (useful for testing and pre-warming).
 */
export function setCacheEntry(key: string, value: unknown, ttlMs: number = DEFAULT_TTL_MS): void {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/**
 * Check if a cache entry exists and is not expired.
 */
export function hasCacheEntry(key: string): boolean {
  const entry = store.get(key);
  if (!entry) return false;
  return entry.expiresAt > Date.now();
}

/**
 * Get all current cache keys (for testing/debugging).
 */
export function getCacheKeys(): string[] {
  return Array.from(store.keys());
}
