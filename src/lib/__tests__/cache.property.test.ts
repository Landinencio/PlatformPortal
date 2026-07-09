/**
 * Property-based tests for cache selective invalidation.
 *
 * Feature: dora-metrics-production-readiness
 * Property 10: Invalidación Selectiva de Caché por Prefijo
 *
 * **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  invalidateCache,
  setCacheEntry,
  hasCacheEntry,
  getCacheKeys,
  cacheKey,
  CACHE_PREFIXES,
} from "../cache";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Generate a prefix from the standard set */
const prefixArb = fc.constantFrom(
  CACHE_PREFIXES.dora,
  CACHE_PREFIXES.sonar,
  CACHE_PREFIXES.k8s,
  CACHE_PREFIXES.correlation,
  CACHE_PREFIXES.executive
);

/** Generate a cache key suffix (simulates filter params portion) */
const suffixArb = fc.stringMatching(/^[a-z0-9_=-]{1,20}$/).filter((s) => s.length >= 1);

/** Generate a full cache key with a given prefix */
function fullKeyArb(prefix: fc.Arbitrary<string>): fc.Arbitrary<string> {
  return fc.tuple(prefix, suffixArb).map(([p, s]) => `${p}:${s}`);
}

/** Generate a set of cache entries: array of {key, prefix} */
const cacheEntriesArb = fc.array(
  fc.tuple(prefixArb, suffixArb).map(([prefix, suffix]) => ({
    key: `${prefix}:${suffix}`,
    prefix,
  })),
  { minLength: 1, maxLength: 40 }
);

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Clear all cache entries before each property run */
function resetCache(): void {
  invalidateCache(); // no argument = clear all
}

/* ------------------------------------------------------------------ */
/*  Property 10: Selective Cache Invalidation by Prefix                */
/*  **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5**         */
/* ------------------------------------------------------------------ */

test("Property 10: invalidating a prefix removes all and only entries with that prefix", () => {
  fc.assert(
    fc.property(cacheEntriesArb, prefixArb, (entries, targetPrefix) => {
      resetCache();

      // Populate cache with all entries
      for (const entry of entries) {
        setCacheEntry(entry.key, `value-for-${entry.key}`);
      }

      // Invalidate the target prefix
      invalidateCache(targetPrefix);

      // Verify: all entries with the target prefix are removed
      for (const entry of entries) {
        if (entry.prefix === targetPrefix) {
          assert.equal(
            hasCacheEntry(entry.key),
            false,
            `Entry "${entry.key}" with prefix "${targetPrefix}" should be removed after invalidation`
          );
        }
      }

      // Verify: all entries with OTHER prefixes remain intact
      for (const entry of entries) {
        if (entry.prefix !== targetPrefix) {
          assert.equal(
            hasCacheEntry(entry.key),
            true,
            `Entry "${entry.key}" with prefix "${entry.prefix}" should remain after invalidating "${targetPrefix}"`
          );
        }
      }
    }),
    { numRuns: 200 }
  );
});

test("Property 10: invalidating a prefix does not affect entries from other prefixes", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(prefixArb, suffixArb),
        { minLength: 2, maxLength: 30 }
      ),
      prefixArb,
      (pairs, targetPrefix) => {
        resetCache();

        // Populate cache
        const allKeys = pairs.map(([p, s]) => ({ key: `${p}:${s}`, prefix: p }));
        for (const { key } of allKeys) {
          setCacheEntry(key, "test-value");
        }

        // Count entries per prefix before invalidation
        const otherEntries = allKeys.filter((e) => e.prefix !== targetPrefix);
        const otherKeysBefore = new Set(otherEntries.map((e) => e.key));

        // Invalidate target prefix
        invalidateCache(targetPrefix);

        // All other entries should still exist
        for (const key of otherKeysBefore) {
          assert.equal(
            hasCacheEntry(key),
            true,
            `Entry "${key}" should remain intact after invalidating "${targetPrefix}"`
          );
        }
      }
    ),
    { numRuns: 200 }
  );
});

test("Property 10: after invalidation, the remaining cache keys have no entries matching the invalidated prefix", () => {
  fc.assert(
    fc.property(cacheEntriesArb, prefixArb, (entries, targetPrefix) => {
      resetCache();

      // Populate cache
      for (const entry of entries) {
        setCacheEntry(entry.key, "data");
      }

      // Invalidate
      invalidateCache(targetPrefix);

      // Check remaining keys
      const remainingKeys = getCacheKeys();
      for (const key of remainingKeys) {
        assert.ok(
          !(key === targetPrefix || key.startsWith(`${targetPrefix}:`)),
          `Remaining key "${key}" should not match invalidated prefix "${targetPrefix}"`
        );
      }
    }),
    { numRuns: 200 }
  );
});

test("Property 10: invalidating a prefix that has no entries is a no-op (other entries unaffected)", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(
          fc.constantFrom(CACHE_PREFIXES.dora, CACHE_PREFIXES.sonar),
          suffixArb
        ),
        { minLength: 1, maxLength: 20 }
      ),
      (pairs) => {
        resetCache();

        // Only populate with dora and sonar entries
        const keys: string[] = [];
        for (const [prefix, suffix] of pairs) {
          const key = `${prefix}:${suffix}`;
          setCacheEntry(key, "value");
          keys.push(key);
        }

        const sizeBefore = getCacheKeys().length;

        // Invalidate a prefix that has no entries (k8s)
        invalidateCache(CACHE_PREFIXES.k8s);

        // All entries should remain
        const sizeAfter = getCacheKeys().length;
        assert.equal(
          sizeAfter,
          sizeBefore,
          "Invalidating a prefix with no entries should not change cache size"
        );

        for (const key of keys) {
          assert.equal(
            hasCacheEntry(key),
            true,
            `Entry "${key}" should remain after invalidating unused prefix`
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 10: cacheKey function produces keys that start with the given prefix", () => {
  fc.assert(
    fc.property(
      prefixArb,
      fc.dictionary(
        fc.stringMatching(/^[a-z]{1,8}$/),
        fc.oneof(fc.string(), fc.integer(), fc.boolean())
      ),
      (prefix, params) => {
        const key = cacheKey(prefix, params);
        assert.ok(
          key.startsWith(`${prefix}:`),
          `cacheKey("${prefix}", ...) should produce a key starting with "${prefix}:", got "${key}"`
        );
      }
    ),
    { numRuns: 100 }
  );
});
