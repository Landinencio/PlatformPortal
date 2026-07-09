// Feature: ai-portal-explorer, Property 8: El inventario de rutas no contiene duplicados y su construcción es idempotente
/**
 * Property-based test for the Route_Discovery inventory.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/route-discovery.ts
 *
 * Property 8: El inventario de rutas no contiene duplicados y su construcción
 * es idempotente.
 *
 *   1. SIN DUPLICADOS: el inventario construido por `buildRouteInventory` no
 *      contiene dos Routes con el mismo `Route.id`.
 *
 *   2. addRouteIfAbsent IDEMPOTENTE: añadir una Route ya presente (por id) deja
 *      el inventario sin cambios (mismo conjunto de ids, misma longitud);
 *      añadir una Route nueva añade exactamente una entrada. Sobre una
 *      secuencia arbitraria de adiciones, el conjunto de ids resultante es la
 *      unión de los ids de partida + los candidatos, y la longitud final es
 *      igual al número de ids distintos.
 *
 *   3. buildRouteInventory DETERMINISTA/IDEMPOTENTE: llamarlo dos veces produce
 *      el mismo conjunto de Routes (mismos ids); y realimentar su salida a
 *      través de `addRouteIfAbsent` no añade nada.
 *
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/route-discovery.prop08.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  buildRouteInventory,
  addRouteIfAbsent,
  buildRouteId,
} from "../route-discovery";
import type { PortalSection } from "@/lib/rbac";
import type { Route } from "../types";

const BASE_URL = "https://portal.today.dev.tooling.dp.iskaypet.com";

/* ------------------------------------------------------------------ */
/*  Arbitraries                                                        */
/* ------------------------------------------------------------------ */

const SECTIONS: readonly PortalSection[] = [
  "home",
  "metrics",
  "finops",
  "create-infra",
  "access-management",
  "incidents",
  "requests",
  "sonarqube",
  "synthetics",
  "infra-requests",
  "kiro-analytics",
  "admin",
] as const;

/**
 * Arbitrary Route whose `id` is ALWAYS derived from kind+path via the canonical
 * `buildRouteId` (mirroring how route-discovery builds every Route). This keeps
 * the dedupe semantics honest: two routes collide iff they share kind+path.
 *
 * The path is drawn from a small pool so the generator naturally produces
 * collisions (same kind+path → same id) as well as distinct routes.
 */
const arbRoute: fc.Arbitrary<Route> = fc
  .record({
    kind: fc.constantFrom<"ui" | "api">("ui", "api"),
    path: fc.constantFrom(
      "/",
      "/metrics",
      "/finops",
      "/admin",
      "/api/health",
      "/api/metrics/dora-core",
      "/api/finops/accounts",
      "/synthetics",
    ),
    section: fc.constantFrom(...SECTIONS),
  })
  .map(({ kind, path, section }) => ({
    id: buildRouteId(kind, path),
    kind,
    path,
    section,
  }));

const arbRouteList: fc.Arbitrary<Route[]> = fc.array(arbRoute, { maxLength: 20 });

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function idSet(routes: Route[]): Set<string> {
  return new Set(routes.map((r) => r.id));
}

function hasNoDuplicateIds(routes: Route[]): boolean {
  return idSet(routes).size === routes.length;
}

/** Fold a sequence of candidates through addRouteIfAbsent. */
function foldAdd(start: Route[], candidates: Route[]): Route[] {
  let inv = start;
  for (const c of candidates) inv = addRouteIfAbsent(inv, c);
  return inv;
}

/* ------------------------------------------------------------------ */
/*  Property 8.1 — addRouteIfAbsent: union semantics, no duplicates    */
/* ------------------------------------------------------------------ */

test("Property 8: addRouteIfAbsent yields the id-union and length === distinct ids", () => {
  fc.assert(
    fc.property(arbRouteList, arbRouteList, (start, candidates) => {
      // Precondition sanity: a starting inventory may contain duplicates from
      // the generator, so first normalize it the way the module would.
      const seeded = foldAdd([], start);
      assert.ok(hasNoDuplicateIds(seeded), "seeded inventory must be duplicate-free");

      const result = foldAdd(seeded, candidates);

      // No duplicates ever.
      assert.ok(hasNoDuplicateIds(result), "result must contain no duplicate ids");

      // The id-set is exactly the union of the seeded ids and candidate ids.
      const expectedUnion = new Set<string>([
        ...idSet(seeded),
        ...idSet(candidates),
      ]);
      assert.deepEqual(idSet(result), expectedUnion);

      // Length equals the number of distinct ids.
      assert.equal(result.length, expectedUnion.size);
    }),
    { numRuns: 100 },
  );
});

test("Property 8: addRouteIfAbsent is idempotent — re-adding an existing route is a no-op", () => {
  fc.assert(
    fc.property(arbRouteList, arbRoute, (start, extra) => {
      const inv = foldAdd([], start);

      // Adding a brand-new route appends exactly one entry.
      const present = inv.some((r) => r.id === extra.id);
      const afterFirst = addRouteIfAbsent(inv, extra);
      if (present) {
        assert.equal(afterFirst.length, inv.length, "existing route must not grow inventory");
        assert.strictEqual(afterFirst, inv, "existing route returns the same array reference");
      } else {
        assert.equal(afterFirst.length, inv.length + 1, "new route appends exactly one");
      }

      // Re-adding the same route again is always a no-op (idempotent).
      const afterSecond = addRouteIfAbsent(afterFirst, extra);
      assert.equal(afterSecond.length, afterFirst.length);
      assert.deepEqual(idSet(afterSecond), idSet(afterFirst));
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Property 8.2 — buildRouteInventory: no duplicates + idempotent     */
/* ------------------------------------------------------------------ */

test("Property 8: buildRouteInventory has no duplicate ids and is deterministic/idempotent", () => {
  fc.assert(
    fc.asyncProperty(fc.constant(BASE_URL), async (baseUrl) => {
      const first = await buildRouteInventory(baseUrl);
      const second = await buildRouteInventory(baseUrl);

      // No duplicate ids in the built inventory.
      assert.ok(hasNoDuplicateIds(first), "inventory must contain no duplicate ids");

      // Deterministic: two builds yield the same set of routes (same ids).
      assert.deepEqual(idSet(first), idSet(second));
      // And, as a pure deterministic function, the full structure matches too.
      assert.deepEqual(first, second);

      // Feeding the output back through addRouteIfAbsent adds nothing.
      const refed = foldAdd(first, second);
      assert.equal(refed.length, first.length, "re-feeding the inventory adds nothing");
      assert.deepEqual(idSet(refed), idSet(first));
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Directed example                                                   */
/* ------------------------------------------------------------------ */

test("Property 8 (example): inventory of the dev target is non-empty and duplicate-free", async () => {
  const inv = await buildRouteInventory(BASE_URL);
  assert.ok(inv.length > 0, "inventory should not be empty");
  assert.ok(hasNoDuplicateIds(inv), "no duplicate ids");

  // Re-adding any existing route is a no-op.
  for (const r of inv) {
    assert.strictEqual(addRouteIfAbsent(inv, r), inv);
  }
});
