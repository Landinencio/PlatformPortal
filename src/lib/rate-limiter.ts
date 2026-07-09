/**
 * In-memory sliding window rate limiter.
 *
 * Tracks request timestamps per key and enforces a maximum number of
 * requests within a rolling time window. Entries are lazily cleaned
 * on access — no background timers or external dependencies.
 *
 * Designed for single-pod deployment; state is lost on restart (acceptable).
 */

export interface RateLimiterConfig {
  maxRequests: number; // default: 10
  windowMs: number; // default: 3600000 (1 hour)
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxRequests: 10,
  windowMs: 3_600_000, // 1 hour
};

export class RateLimiter {
  private readonly config: RateLimiterConfig;
  private readonly store: Map<string, number[]> = new Map();

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check whether a request from `key` is allowed under the rate limit.
   *
   * If allowed, the current timestamp is recorded and remaining quota is
   * returned. If rejected, `retryAfterSeconds` indicates how long until
   * the oldest request in the window expires.
   */
  check(key: string): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    // Get existing timestamps and lazily expire old ones
    const timestamps = (this.store.get(key) ?? []).filter(
      (ts) => ts > windowStart
    );

    if (timestamps.length < this.config.maxRequests) {
      // Allowed — record this request
      timestamps.push(now);
      this.store.set(key, timestamps);

      return {
        allowed: true,
        remaining: this.config.maxRequests - timestamps.length,
      };
    }

    // Rejected — calculate retry delay from the oldest timestamp in window
    const oldestTimestamp = timestamps[0];
    const retryAfterMs = oldestTimestamp + this.config.windowMs - now;
    const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);

    // Store the cleaned timestamps (no new entry added)
    this.store.set(key, timestamps);

    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
    };
  }

  /**
   * Reset all tracked timestamps for a given key.
   */
  reset(key: string): void {
    this.store.delete(key);
  }
}
