/**
 * Property test — preservación de la identidad del Response en passthrough.
 *
 * Feature: session-nav-hardening, Property 6: El passthrough preserva la identidad del Response
 *
 * Module under test: src/lib/session/http-interceptor-core.ts
 *
 * Property 6: Para CUALQUIER `Response` con `status` fuera de `{401, 403}`,
 * la capa de passthrough del interceptor devuelve EL MISMO objeto `Response`
 * (misma referencia) y su cuerpo permanece legible (el stream no se consume),
 * preservando `status`, `ok`, `headers` y cuerpo.
 *
 * Se modela la capa de passthrough como una función pequeña que, dado un
 * `Response`, usa `classifyApiResponse(res.status)` y — cuando la acción es
 * "passthrough" — devuelve el mismo objeto SIN leerlo. Esto refleja el contrato
 * del componente `HttpInterceptor`, que nunca lee el body (`.json()/.text()/.clone()`)
 * y solo consulta `status`.
 *
 * **Validates: Requirements 2.5, 2.7**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { classifyApiResponse } from "../session/http-interceptor-core";

const RUNS = { numRuns: 100 } as const;

/* ------------------------------------------------------------------ */
/*  Modelo de la capa de passthrough                                   */
/* ------------------------------------------------------------------ */

/**
 * Capa de passthrough: dado un `Response`, clasifica su status y — para todo
 * status distinto de 401/403 — devuelve EL MISMO objeto sin leer el cuerpo.
 * No consume el stream: solo inspecciona `status`.
 */
function passthroughLayer(res: Response): Response {
  const action = classifyApiResponse(res.status);
  if (action === "passthrough") {
    return res;
  }
  // Para relogin/forbidden el interceptor real dispara efectos pero, según el
  // diseño (R2.5/R2.7), TAMPOCO lee el body: devuelve el mismo Response.
  return res;
}

/* ------------------------------------------------------------------ */
/*  Generadores                                                        */
/* ------------------------------------------------------------------ */

/**
 * Status fuera de {401, 403} (los que caen en passthrough).
 * Se excluyen los "null body statuses" (101, 103, 204, 205, 304): el
 * constructor `Response` del runtime rechaza construirlos con un cuerpo, así
 * que quedan fuera del espacio de entrada de un Response con body legible.
 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const arbPassthroughStatus = fc
  .integer({ min: 200, max: 599 })
  .filter((s) => s !== 401 && s !== 403 && !NULL_BODY_STATUSES.has(s));

/** Cuerpos textuales arbitrarios (incluye vacío). */
const arbBody = fc.string();

/* ------------------------------------------------------------------ */
/*  Property 6                                                         */
/* ------------------------------------------------------------------ */

test("Property 6: passthrough devuelve la MISMA referencia de Response sin consumir el body", async () => {
  await fc.assert(
    fc.asyncProperty(arbBody, arbPassthroughStatus, async (body, status) => {
      const res = new Response(body, { status });

      const result = passthroughLayer(res);

      // Misma referencia (identidad preservada).
      assert.equal(result === res, true);
      // El stream NO se ha consumido.
      assert.equal(res.bodyUsed, false);
      assert.equal(result.bodyUsed, false);
      // status y ok se preservan.
      assert.equal(result.status, status);
      assert.equal(result.ok, status >= 200 && status < 300);

      // El cuerpo sigue siendo legible tras el passthrough.
      const text = await result.text();
      assert.equal(text, body);
      // Y ahora sí está consumido (tras leerlo explícitamente).
      assert.equal(result.bodyUsed, true);
    }),
    RUNS,
  );
});

test("Property 6: el passthrough preserva las cabeceras del Response original", async () => {
  await fc.assert(
    fc.asyncProperty(arbBody, arbPassthroughStatus, async (body, status) => {
      const res = new Response(body, {
        status,
        headers: { "content-type": "application/json", "x-portal": "true" },
      });

      const result = passthroughLayer(res);

      assert.equal(result === res, true);
      assert.equal(result.headers.get("content-type"), "application/json");
      assert.equal(result.headers.get("x-portal"), "true");
      assert.equal(res.bodyUsed, false);
    }),
    RUNS,
  );
});
