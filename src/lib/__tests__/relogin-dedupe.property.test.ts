// Feature: session-nav-hardening, Property 7: El re-login se dispara una única vez por ventana de 5000 ms
/**
 * Property test para la deduplicación temporal (single-flight) del re-login.
 *
 * Feature: session-nav-hardening
 * Module under test: src/lib/session/relogin-dedupe.ts
 *   (`shouldTriggerRelogin`, `markTriggered`, `ReloginState`, `RELOGIN_DEDUPE_MS`)
 *
 * Property 7: El re-login se dispara una única vez por ventana de 5000 ms
 *   ∀ secuencia de intentos de disparo con timestamps arbitrarios (procesados en
 *   orden no decreciente) y fuentes arbitrarias (`guard`, `http-401`,
 *   `guard-refresh-failed`), aplicando `shouldTriggerRelogin`/`markTriggered`, el
 *   número de disparos efectivos dentro de cualquier ventana de 5000 ms iniciada
 *   por un disparo es exactamente uno, con independencia de la concurrencia y del
 *   origen de los intentos.
 *
 * **Validates: Requirements 2.6, 4.7**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  shouldTriggerRelogin,
  markTriggered,
  RELOGIN_DEDUPE_MS,
  type ReloginState,
} from "../session/relogin-dedupe";

/** Fuentes posibles de un intento de disparo (no afectan a la lógica de dedupe). */
type ReloginSource = "guard" | "http-401" | "guard-refresh-failed";
const sourceArb: fc.Arbitrary<ReloginSource> = fc.constantFrom(
  "guard",
  "http-401",
  "guard-refresh-failed",
);

interface Attempt {
  t: number;
  source: ReloginSource;
}

/**
 * Generador de una secuencia de intentos: array de `{ timestamp, source }`.
 * Los timestamps son `fc.nat()` (epoch ms no negativos y finitos); la secuencia
 * se ordena de forma NO decreciente para modelar el flujo real de intentos que
 * llegan cronológicamente (concurrencia colapsada a un orden temporal coherente).
 */
const attemptsArb: fc.Arbitrary<Attempt[]> = fc
  .array(fc.record({ t: fc.nat(), source: sourceArb }), { maxLength: 60 })
  .map((xs) => [...xs].sort((a, b) => a.t - b.t));

/**
 * Reproduce el flujo real: procesa los intentos en orden no decreciente,
 * aplicando `shouldTriggerRelogin`/`markTriggered`. Devuelve, por cada intento,
 * si fue un disparo efectivo, y la lista de timestamps de los disparos efectivos.
 */
function simulate(attempts: Attempt[]): {
  fired: boolean[];
  effectiveTimes: number[];
} {
  let state: ReloginState = { lastTriggeredAt: null };
  const fired: boolean[] = [];
  const effectiveTimes: number[] = [];
  for (const attempt of attempts) {
    const doTrigger = shouldTriggerRelogin(state, attempt.t);
    fired.push(doTrigger);
    if (doTrigger) {
      state = markTriggered(state, attempt.t);
      effectiveTimes.push(attempt.t);
    }
  }
  return { fired, effectiveTimes };
}

test("Property 7: el primer intento de una secuencia no vacía siempre dispara", () => {
  fc.assert(
    fc.property(attemptsArb, (attempts) => {
      const { fired } = simulate(attempts);
      if (attempts.length > 0) {
        assert.equal(fired[0], true);
      }
    }),
    { numRuns: 100 },
  );
});

test("Property 7: disparos efectivos consecutivos distan >= 5000 ms", () => {
  fc.assert(
    fc.property(attemptsArb, (attempts) => {
      const { effectiveTimes } = simulate(attempts);
      for (let i = 1; i < effectiveTimes.length; i++) {
        assert.ok(
          effectiveTimes[i] - effectiveTimes[i - 1] >= RELOGIN_DEDUPE_MS,
          `disparos consecutivos demasiado próximos: ${effectiveTimes[i - 1]} y ${effectiveTimes[i]}`,
        );
      }
    }),
    { numRuns: 100 },
  );
});

test("Property 7: en la ventana [disparo, disparo+5000) hay exactamente un disparo efectivo", () => {
  fc.assert(
    fc.property(attemptsArb, (attempts) => {
      const { effectiveTimes } = simulate(attempts);
      // Para cada disparo efectivo, ninguna otra marca cae dentro de su ventana
      // de 5000 ms hacia delante → exactamente uno por ventana.
      for (const start of effectiveTimes) {
        const inWindow = effectiveTimes.filter(
          (t) => t >= start && t < start + RELOGIN_DEDUPE_MS,
        );
        assert.equal(
          inWindow.length,
          1,
          `ventana [${start}, ${start + RELOGIN_DEDUPE_MS}) con ${inWindow.length} disparos`,
        );
      }
    }),
    { numRuns: 100 },
  );
});

test("Property 7: un intento no efectivo tiene siempre un disparo previo a < 5000 ms", () => {
  fc.assert(
    fc.property(attemptsArb, (attempts) => {
      let lastEffective: number | null = null;
      let state: ReloginState = { lastTriggeredAt: null };
      for (const attempt of attempts) {
        const doTrigger = shouldTriggerRelogin(state, attempt.t);
        if (doTrigger) {
          state = markTriggered(state, attempt.t);
          lastEffective = attempt.t;
        } else {
          // No disparó ⇒ había un disparo previo y estamos dentro de su ventana.
          assert.notEqual(lastEffective, null);
          assert.ok(attempt.t - (lastEffective as number) < RELOGIN_DEDUPE_MS);
        }
      }
    }),
    { numRuns: 100 },
  );
});

test("Property 7: el patrón de disparos es independiente del origen (fuente) de los intentos", () => {
  fc.assert(
    fc.property(attemptsArb, sourceArb, (attempts, forcedSource) => {
      const base = simulate(attempts);
      // Reasignar todas las fuentes a una única fuente no cambia el resultado:
      // la dedupe depende solo del tiempo, no del origen.
      const reSourced = attempts.map((a) => ({ ...a, source: forcedSource }));
      const alt = simulate(reSourced);
      assert.deepEqual(alt.fired, base.fired);
      assert.deepEqual(alt.effectiveTimes, base.effectiveTimes);
    }),
    { numRuns: 100 },
  );
});
