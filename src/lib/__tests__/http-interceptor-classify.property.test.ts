/**
 * Property test — clasificación total de la respuesta de API.
 *
 * Feature: session-nav-hardening, Property 4: La clasificación de la respuesta de API es total
 *
 * Module under test: src/lib/session/http-interceptor-core.ts
 *
 * Property 4: Para CUALQUIER entero `status`, `classifyApiResponse(status)`
 * devuelve exactamente "relogin" si status === 401, "forbidden" si status === 403,
 * y "passthrough" para cualquier otro valor. El resultado siempre pertenece al
 * conjunto {relogin, forbidden, passthrough}.
 *
 * **Validates: Requirements 2.2, 2.3, 2.7**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { classifyApiResponse } from "../session/http-interceptor-core";
import type { InterceptAction } from "../session/http-interceptor-core";

const RUNS = { numRuns: 100 } as const;

const ACTIONS: ReadonlySet<InterceptAction> = new Set([
  "relogin",
  "forbidden",
  "passthrough",
]);

/* ------------------------------------------------------------------ */
/*  Generador                                                          */
/* ------------------------------------------------------------------ */

/** Enteros arbitrarios como `status` (incluye negativos, 0 y >599). */
const arbStatus = fc.integer();

/* ------------------------------------------------------------------ */
/*  Property 4                                                         */
/* ------------------------------------------------------------------ */

test("Property 4: classifyApiResponse mapea 401→relogin, 403→forbidden, resto→passthrough", () => {
  fc.assert(
    fc.property(arbStatus, (status) => {
      const action = classifyApiResponse(status);
      if (status === 401) {
        assert.equal(action, "relogin");
      } else if (status === 403) {
        assert.equal(action, "forbidden");
      } else {
        assert.equal(action, "passthrough");
      }
    }),
    RUNS,
  );
});

test("Property 4: el resultado pertenece siempre al conjunto {relogin, forbidden, passthrough}", () => {
  fc.assert(
    fc.property(arbStatus, (status) => {
      const action = classifyApiResponse(status);
      assert.equal(ACTIONS.has(action), true);
    }),
    RUNS,
  );
});
