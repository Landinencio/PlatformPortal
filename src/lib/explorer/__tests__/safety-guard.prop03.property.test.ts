// Feature: ai-portal-explorer, Property 3: El Crawler solo emite métodos HTTP seguros
/**
 * Property-based test for the Safety_Guard safe-method gate.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/safety-guard.ts
 *
 * Property 3: El Crawler solo emite métodos HTTP seguros.
 *   Para TODO string de método HTTP, `isSafeMethod(method)` devuelve verdadero
 *   SI Y SOLO SI su forma normalizada (trim + uppercase) pertenece a
 *   {GET, HEAD}. En consecuencia, para una interacción HTTP candidata
 *   `{ kind: "http", httpMethod }`, `evaluateInteraction` la PERMITE si y solo
 *   si `isSafeMethod(httpMethod)` — es decir, el Crawler nunca emitiría un
 *   método distinto de GET/HEAD hacia el Portal.
 *
 * **Validates: Requirements 1.5, 1.6, 1.8**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/safety-guard.prop03.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { evaluateInteraction, isSafeMethod } from "../safety-guard";
import { arbHttpMethod } from "./arbitraries";

/* ------------------------------------------------------------------ */
/*  Independent oracle (mirrors the spec, not the implementation)      */
/* ------------------------------------------------------------------ */

/**
 * Oráculo de "método seguro" según la especificación (Property 3):
 * un método es seguro IFF su normalización (trim + uppercase) ∈ {GET, HEAD}.
 */
function expectedSafe(method: string): boolean {
  const normalized = method.trim().toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}

/* ------------------------------------------------------------------ */
/*  Property 3                                                         */
/* ------------------------------------------------------------------ */

test("Property 3: isSafeMethod is true IFF normalized method ∈ {GET, HEAD}", () => {
  fc.assert(
    fc.property(arbHttpMethod, (method) => {
      const expected = expectedSafe(method);

      // isSafeMethod coincide exactamente con el oráculo (IFF).
      assert.equal(
        isSafeMethod(method),
        expected,
        `isSafeMethod(${JSON.stringify(method)}) → ${isSafeMethod(method)}, expected ${expected}`,
      );

      // El Crawler solo emite GET/HEAD: una interacción HTTP se permite IFF el
      // método es seguro.
      const decision = evaluateInteraction({ kind: "http", httpMethod: method });
      assert.equal(
        decision.allowed,
        expected,
        `evaluateInteraction(http, ${JSON.stringify(method)}) → allowed=${decision.allowed}, ` +
          `expected=${expected}`,
      );

      // La decisión siempre lleva un motivo no vacío (trazabilidad).
      assert.ok(decision.reason.length > 0, "la decisión debe llevar un motivo no vacío");
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Directed examples                                                  */
/* ------------------------------------------------------------------ */

test("Property 3 (example): GET/HEAD safe across casing and surrounding spaces", () => {
  for (const m of ["GET", "HEAD", "get", "head", "Get", "Head", " GET ", " head "]) {
    assert.equal(isSafeMethod(m), true, `${JSON.stringify(m)} debe ser seguro`);
    assert.equal(
      evaluateInteraction({ kind: "http", httpMethod: m }).allowed,
      true,
      `http ${JSON.stringify(m)} debe permitirse`,
    );
  }
});

test("Property 3 (example): mutating and unknown methods are unsafe", () => {
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT", "delete", "", "garbage"]) {
    assert.equal(isSafeMethod(m), false, `${JSON.stringify(m)} NO debe ser seguro`);
    assert.equal(
      evaluateInteraction({ kind: "http", httpMethod: m }).allowed,
      false,
      `http ${JSON.stringify(m)} debe bloquearse`,
    );
  }
});
